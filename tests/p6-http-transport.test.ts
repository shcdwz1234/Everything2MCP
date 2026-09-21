import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadAppConfig, DEFAULT_HTTP_PORT } from "../src/catalog/config.js";
import { ERROR_CODES, ERROR_CODE_HELP } from "../src/runtime/errors.js";
import { invokeWithMiddleware } from "../src/runtime/invoke.js";
import { invokeAudit } from "../src/runtime/metrics.js";
import { startHttp } from "../src/transport/http.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const REQUIRED_TOOLS = [
  "mcp_list",
  "mcp_add",
  "mcp_health",
  "mcp_explain_tool",
  "mcp_plan_bridge",
  "discovery_scan_host",
  "schema_import",
];

async function withTempDir(): Promise<{ dataDir: string; cleanup: () => Promise<void> }> {
  const dataDir = await mkdtemp(join(tmpdir(), "e2mcp-p6-"));
  return {
    dataDir,
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}

describe("P6 HTTP/SSE transport", { timeout: 25_000 }, () => {
  const cleanups: Array<() => Promise<void>> = [];
  after(async () => {
    for (const fn of [...cleanups].reverse()) {
      await fn().catch(() => undefined);
    }
    cleanups.length = 0;
  });

  function track<T extends { close: () => Promise<void> }>(app: T, extra?: () => Promise<void>): T {
    cleanups.push(async () => {
      await app.close().catch(() => undefined);
      if (extra) await extra().catch(() => undefined);
    });
    return app;
  }

  it("src/core and src/management shims stay gone; http.ts is no longer a stub", () => {
    assert.equal(existsSync(join(root, "src/core")), false);
    assert.equal(existsSync(join(root, "src/management")), false);
    const httpSrc = readFileSync(join(root, "src/transport/http.ts"), "utf8");
    assert.equal(httpSrc.includes("not implemented yet"), false);
    assert.ok(httpSrc.includes("StreamableHTTPServerTransport"));
    assert.ok(httpSrc.includes("SSEServerTransport"));
  });

  it("loadAppConfig reads HTTP/SSE env (stdio remains default)", () => {
    const def = loadAppConfig({});
    assert.equal(def.transport.kind, "stdio");
    assert.equal(def.transport.port, DEFAULT_HTTP_PORT);
    assert.equal(def.transport.host, "127.0.0.1");
    assert.equal(def.transport.mcpPath, "/mcp");
    assert.equal(def.transport.ssePath, "/sse");

    const http = loadAppConfig({
      EVERYTHING2MCP_TRANSPORT: "http",
      EVERYTHING2MCP_HTTP_HOST: "127.0.0.1",
      EVERYTHING2MCP_HTTP_PORT: "8742",
      EVERYTHING2MCP_HTTP_TOKEN: "secret",
      EVERYTHING2MCP_HTTP_TOKEN_HEADER: "x-e2mcp-token",
      EVERYTHING2MCP_HTTP_PATH: "mcp",
    });
    assert.equal(http.transport.kind, "http");
    assert.equal(http.transport.port, 8742);
    assert.equal(http.transport.token, "secret");
    assert.equal(http.transport.tokenHeader, "x-e2mcp-token");
    assert.equal(http.transport.mcpPath, "/mcp");

    const sse = loadAppConfig({ EVERYTHING2MCP_TRANSPORT: "sse" });
    assert.equal(sse.transport.kind, "sse");
  });

  it("starts Streamable HTTP and answers tools/list", async () => {
    const tmp = await withTempDir();
    const app = track(await startHttp({ dataDir: tmp.dataDir, transport: { kind: "http", port: 0, host: "127.0.0.1" } }), tmp.cleanup);

    const health = await fetch(`${app.http.url}/health`);
    assert.equal(health.status, 200);
    const body = (await health.json()) as { ok: boolean; app: string };
    assert.equal(body.ok, true);
    assert.equal(body.app, "everything2mcp");

    const client = new Client({ name: "p6-http", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(app.http.mcpUrl));
    await client.connect(transport);
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name);
      for (const required of REQUIRED_TOOLS) {
        assert.ok(names.includes(required), `missing ${required}`);
      }
    } finally {
      await client.close();
    }
  });

  it("starts legacy SSE and answers tools/list", async () => {
    const tmp = await withTempDir();
    const app = track(await startHttp({ dataDir: tmp.dataDir, transport: { kind: "sse", port: 0, host: "127.0.0.1" } }), tmp.cleanup);

    const client = new Client({ name: "p6-sse", version: "0.0.0" });
    const transport = new SSEClientTransport(new URL(app.http.sseUrl));
    await client.connect(transport);
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name);
      assert.ok(names.includes("mcp_list"));
      assert.ok(names.includes("mcp_health"));
    } finally {
      await client.close();
    }
  });

  it("optional HTTP token: 401 without it, tools/list with Bearer", async () => {
    const tmp = await withTempDir();
    const token = "p6-test-token";
    const app = track(
      await startHttp({
        dataDir: tmp.dataDir,
        transport: { kind: "http", port: 0, host: "127.0.0.1", token },
      }),
      tmp.cleanup,
    );

    const denied = await fetch(app.http.mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert.equal(denied.status, 401);
    const payload = (await denied.json()) as { code: string };
    assert.equal(payload.code, "E_AUTH");

    const openHealth = await fetch(`${app.http.url}/health`);
    assert.equal(openHealth.status, 200);

    const client = new Client({ name: "p6-auth", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(app.http.mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    try {
      const listed = await client.listTools();
      assert.ok(listed.tools.some((t) => t.name === "mcp_list"));
    } finally {
      await client.close();
    }
  });

  it("records adapter invoke success/fail counts", async () => {
    const before = invokeAudit();
    await invokeWithMiddleware(async () => 1);
    assert.equal(invokeAudit().success, before.success + 1);
    await assert.rejects(() => invokeWithMiddleware(async () => {
      throw new Error("boom");
    }));
    assert.equal(invokeAudit().fail, before.fail + 1);
  });

  it("documents every unified error code", () => {
    for (const code of ERROR_CODES) {
      assert.ok(ERROR_CODE_HELP[code], code);
    }
    const errorsDoc = readFileSync(join(root, "docs/ERRORS.md"), "utf8");
    for (const code of ERROR_CODES) {
      assert.ok(errorsDoc.includes(code), `docs/ERRORS.md missing ${code}`);
    }
  });
});
