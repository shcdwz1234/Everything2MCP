import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { isSecretKey, redactSecrets, SECRET_MASK } from "../src/control/redact.js";
import { handleConsoleRest, isWriteTool } from "../src/control/rest.js";
import { startHttp } from "../src/transport/http.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const petstore = join(root, "examples/petstore.openapi.json");

async function withTempDir(): Promise<{ dataDir: string; cleanup: () => Promise<void> }> {
  const dataDir = await mkdtemp(join(tmpdir(), "e2mcp-w1-"));
  return { dataDir, cleanup: () => rm(dataDir, { recursive: true, force: true }) };
}

describe("W1/W2 console REST + redact", { timeout: 30_000 }, () => {
  const cleanups: Array<() => Promise<void>> = [];
  after(async () => {
    for (const fn of [...cleanups].reverse()) await fn().catch(() => undefined);
    cleanups.length = 0;
  });

  function track<T extends { close: () => Promise<void> }>(app: T, extra?: () => Promise<void>): T {
    cleanups.push(async () => {
      await app.close().catch(() => undefined);
      if (extra) await extra().catch(() => undefined);
    });
    return app;
  }

  it("redacts secret keys and leaves timeoutMs / allowWrite alone", () => {
    assert.equal(isSecretKey("secretKey"), true);
    assert.equal(isSecretKey("access_token"), true);
    assert.equal(isSecretKey("jwt"), true);
    assert.equal(isSecretKey("tlsKey"), true);
    assert.equal(isSecretKey("timeoutMs"), false);
    assert.equal(isSecretKey("allowWrite"), false);
    assert.equal(isSecretKey("partitionKey"), false);
    const masked = redactSecrets({
      filename: ":memory:",
      allowWrite: false,
      secretKey: "supersecret",
      auth: { token: "abc", headerName: "Authorization" },
    });
    assert.equal(masked.secretKey, SECRET_MASK);
    assert.equal(masked.auth.token, SECRET_MASK);
    assert.equal(masked.filename, ":memory:");
    assert.equal(masked.allowWrite, false);
    assert.equal(masked.auth.headerName, "Authorization");
  });

  it("classifies execute as write and list_tables as read", () => {
    assert.equal(isWriteTool(undefined, "execute"), true);
    assert.equal(isWriteTool(undefined, "list_tables"), false);
    assert.equal(isWriteTool({ name: "query", description: "", inputSchema: {}, annotations: { readOnlyHint: true } }, "query"), false);
  });

  it("GET /api/health, adapters CRUD, ping, tools layers, secret mask", async () => {
    const tmp = await withTempDir();
    const app = track(
      await startHttp({ dataDir: tmp.dataDir, transport: { kind: "http", port: 0, host: "127.0.0.1" } }),
      tmp.cleanup,
    );
    const base = app.http.url;

    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    const h = (await health.json()) as { ok: boolean; app: string; policy: { allowWriteDefault: boolean }; console: { ui: string } };
    assert.equal(h.ok, true);
    assert.equal(h.app, "everything2mcp");
    assert.equal(h.policy.allowWriteDefault, false);
    assert.equal(h.console.ui, "/ui/");

    const empty = await fetch(`${base}/api/adapters`);
    assert.equal(empty.status, 200);
    const emptyBody = (await empty.json()) as { adapters: unknown[] };
    assert.deepEqual(emptyBody.adapters, []);

    const created = await fetch(`${base}/api/adapters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        protocol: "s3",
        name: "vault",
        config: { bucket: "artifacts", endpoint: "memory://", accessKey: "AKIA", secretKey: "supersecret" },
      }),
    });
    assert.equal(created.status, 201);
    const createdBody = (await created.json()) as { ok: boolean; id: string };
    assert.equal(createdBody.id, "s3:vault");

    const listed = await fetch(`${base}/api/adapters`);
    const listBody = (await listed.json()) as { adapters: Array<{ id: string; config: { secretKey: string; accessKey: string } }> };
    const row = listBody.adapters.find((a) => a.id === "s3:vault");
    assert.ok(row);
    assert.equal(row.config.secretKey, SECRET_MASK);
    assert.equal(row.config.accessKey, SECRET_MASK);

    const one = await fetch(`${base}/api/adapters/${encodeURIComponent("s3:vault")}`);
    assert.equal(one.status, 200);
    const oneBody = (await one.json()) as { adapter: { config: { secretKey: string; bucket: string } } };
    assert.equal(oneBody.adapter.config.secretKey, SECRET_MASK);
    assert.equal(oneBody.adapter.config.bucket, "artifacts");

    const ping = await fetch(`${base}/api/adapters/${encodeURIComponent("s3:vault")}/ping`, { method: "POST" });
    assert.equal(ping.status, 200);
    const pingBody = (await ping.json()) as { ok: boolean; health: { ok: boolean } };
    assert.equal(pingBody.ok, true);
    assert.equal(pingBody.health.ok, true);

    const updated = await fetch(`${base}/api/adapters/${encodeURIComponent("s3:vault")}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: { bucket: "other", endpoint: "memory://" } }),
    });
    assert.equal(updated.status, 200);

    const after = await fetch(`${base}/api/adapters/${encodeURIComponent("s3:vault")}`);
    const afterBody = (await after.json()) as { adapter: { config: { bucket: string } } };
    assert.equal(afterBody.adapter.config.bucket, "other");

    const sqlite = await fetch(`${base}/api/adapters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ protocol: "sqlite", name: "mem", config: { filename: ":memory:" } }),
    });
    assert.equal(sqlite.status, 201);

    const biz = await fetch(`${base}/api/tools?layer=business`);
    const bizBody = (await biz.json()) as { layer: string; tools: Array<{ name: string; layer: string }> };
    assert.equal(bizBody.layer, "business");
    assert.ok(bizBody.tools.some((t) => t.name === "sqlite.mem.list_tables"));
    assert.ok(bizBody.tools.every((t) => t.layer === "business"));

    const mgmt = await fetch(`${base}/api/tools?layer=management`);
    const mgmtBody = (await mgmt.json()) as { tools: Array<{ name: string }> };
    assert.ok(mgmtBody.tools.some((t) => t.name === "mcp_list"));
    assert.ok(mgmtBody.tools.some((t) => t.name === "schema_import"));

    const all = await fetch(`${base}/api/tools?layer=all`);
    const allBody = (await all.json()) as { tools: Array<{ name: string }> };
    assert.ok(allBody.tools.some((t) => t.name === "mcp_health"));
    assert.ok(allBody.tools.some((t) => t.name === "sqlite.mem.query"));

    const explained = await fetch(`${base}/api/tools/${encodeURIComponent("sqlite.mem.list_tables")}`);
    assert.equal(explained.status, 200);
    const exp = (await explained.json()) as { name: string; layer: string };
    assert.equal(exp.name, "sqlite.mem.list_tables");
    assert.equal(exp.layer, "business");

    const settings = await fetch(`${base}/api/settings`);
    const settingsBody = (await settings.json()) as { policy: { allowWriteDefault: boolean }; transport: { tokenConfigured: boolean } };
    assert.equal(settingsBody.policy.allowWriteDefault, false);
    assert.equal(settingsBody.transport.tokenConfigured, false);

    const matrix = await fetch(`${base}/api/matrix`);
    const matrixBody = (await matrix.json()) as { protocols: Array<{ id: string }>; policy: { cidrScanDefault: boolean } };
    assert.ok(matrixBody.protocols.some((p) => p.id === "sqlite"));
    assert.equal(matrixBody.policy.cidrScanDefault, false);

    const removed = await fetch(`${base}/api/adapters/${encodeURIComponent("s3:vault")}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    const gone = await fetch(`${base}/api/adapters/${encodeURIComponent("s3:vault")}`);
    assert.equal(gone.status, 404);
  });

  it("shares HTTP token with /api and leaves /health + /ui public", async () => {
    const tmp = await withTempDir();
    const token = "w1-console-token";
    const app = track(
      await startHttp({
        dataDir: tmp.dataDir,
        transport: { kind: "http", port: 0, host: "127.0.0.1", token },
      }),
      tmp.cleanup,
    );
    const openHealth = await fetch(`${app.http.url}/health`);
    assert.equal(openHealth.status, 200);

    const denied = await fetch(`${app.http.url}/api/health`);
    assert.equal(denied.status, 401);

    const ok = await fetch(`${app.http.url}/api/health`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(ok.status, 200);

    const ui = await fetch(app.http.uiUrl);
    assert.equal(ui.status, 200);
    const html = await ui.text();
    assert.match(html, /Everything2MCP/);
    assert.equal(existsSync(join(root, "dist/ui/index.html")) || html.includes("控制台"), true);
  });

  it("W2: read invoke, write confirm gate, CIDR refused, schema import", async () => {
    const tmp = await withTempDir();
    const app = track(
      await startHttp({ dataDir: tmp.dataDir, transport: { kind: "http", port: 0, host: "127.0.0.1" } }),
      tmp.cleanup,
    );
    const base = app.http.url;

    const add = await fetch(`${base}/api/adapters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ protocol: "sqlite", name: "lab", config: { filename: ":memory:" } }),
    });
    assert.equal(add.status, 201);

    const listed = await fetch(`${base}/api/tools/${encodeURIComponent("sqlite.lab.list_tables")}/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ arguments: {} }),
    });
    assert.equal(listed.status, 200);
    const listedBody = (await listed.json()) as { ok: boolean; write: boolean; result: { tables?: unknown } };
    assert.equal(listedBody.ok, true);
    assert.equal(listedBody.write, false);

    const blocked = await fetch(`${base}/api/tools/${encodeURIComponent("sqlite.lab.execute")}/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ arguments: { sql: "CREATE TABLE t(x INTEGER)" } }),
    });
    assert.equal(blocked.status, 400);
    const blockedBody = (await blocked.json()) as { code: string };
    assert.equal(blockedBody.code, "E_INVALID_ARGUMENT");

    const confirmed = await fetch(`${base}/api/tools/${encodeURIComponent("sqlite.lab.execute")}/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ arguments: { sql: "CREATE TABLE t(x INTEGER)" }, confirm: true }),
    });
    assert.equal(confirmed.status, 403);
    const confirmedBody = (await confirmed.json()) as { code: string; error: string };
    assert.equal(confirmedBody.code, "E_UNSUPPORTED");
    assert.match(confirmedBody.error, /allowWrite/);

    const cidr = await fetch(`${base}/api/discovery/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host: "10.0.0.0/24" }),
    });
    assert.equal(cidr.status, 403);
    const cidrBody = (await cidr.json()) as { code: string };
    assert.equal(cidrBody.code, "E_UNSUPPORTED");

    const imported = await fetch(`${base}/api/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: petstore, kind: "openapi", name: "pets", register: true }),
    });
    assert.equal(imported.status, 200);
    const imp = (await imported.json()) as { registered: boolean; id?: string };
    assert.equal(imp.registered, true);
    assert.equal(imp.id, "openapi:pets");

    const mgmtInvoke = await fetch(`${base}/api/tools/mcp_add/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ arguments: {} }),
    });
    assert.equal(mgmtInvoke.status, 403);
  });

  it("dispatcher reuses control tools without a copied catalog", async () => {
    const src = readFileSync(join(root, "src/control/rest.ts"), "utf8");
    assert.match(src, /callManagementTool/);
    assert.equal(src.includes("new ToolRegistry"), false);
    assert.equal(src.includes("registerBuiltinAdapters"), false);

    const tmp = await withTempDir();
    const { createEverything2McpServer } = await import("../src/control/server.js");
    const app = await createEverything2McpServer({ dataDir: tmp.dataDir, transport: { kind: "http", port: 0 } });
    cleanups.push(async () => {
      await app.close();
      await tmp.cleanup();
    });
    const res = await handleConsoleRest(app, {
      method: "GET",
      pathname: "/api/health",
      query: new URLSearchParams(),
    });
    assert.equal(res.status, 200);
    assert.equal((res.body as { app: string }).app, "everything2mcp");
  });
});
