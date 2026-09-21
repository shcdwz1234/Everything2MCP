import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadAppConfig } from "../src/catalog/config.js";
import { createEverything2McpServer } from "../src/control/server.js";
import { callManagementTool } from "../src/control/tools.js";
import { assertHostProbeAllowed } from "../src/control/policy.js";
import { IntegrityLedger } from "../src/control/security/index.js";
import { AdapterError } from "../src/runtime/errors.js";
import { invokeAuditEvents } from "../src/runtime/metrics.js";
import { startHttp } from "../src/transport/http.js";

const specPath = fileURLToPath(new URL("../examples/petstore.openapi.json", import.meta.url));

async function withTempDir(): Promise<{ dataDir: string; cleanup: () => Promise<void> }> {
  const dataDir = await mkdtemp(join(tmpdir(), "e2mcp-sec-"));
  return { dataDir, cleanup: () => rm(dataDir, { recursive: true, force: true }) };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const part = result.content.find((c) => c.type === "text");
  return part && "text" in part ? String(part.text) : "";
}

describe("S1 security plane", { timeout: 30_000 }, () => {
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

  it("defaults safe, hot-switches to full, audits mode_change, persists", async () => {
    const tmp = await withTempDir();
    const app = track(await createEverything2McpServer({ dataDir: tmp.dataDir }), tmp.cleanup);
    assert.equal(app.security.mode(), "safe");
    await app.security.setMode("full", { actor: { kind: "console", tokenPresent: true } });
    assert.equal(app.security.mode(), "full");
    const raw = JSON.parse(await readFile(join(tmp.dataDir, "security.json"), "utf8")) as { mode: string };
    assert.equal(raw.mode, "full");
    const events = invokeAuditEvents(20);
    assert.ok(events.some((e) => e.kind === "mode_change" && /safe → full/.test(String(e.detail))));
    await app.security.reload();
    assert.equal(app.security.mode(), "full");
  });

  it("blacklist still blocks register/list/invoke in full mode", async () => {
    const tmp = await withTempDir();
    const app = track(await createEverything2McpServer({ dataDir: tmp.dataDir }), tmp.cleanup);
    const ctx = { registry: app.registry, config: app.config, blacklist: app.blacklist, security: app.security };
    await callManagementTool(
      "mcp_add",
      { protocol: "openapi", name: "live", config: { spec: specPath, baseUrl: "http://10.9.8.7:8080" } },
      ctx,
    );
    await callManagementTool("mcp_blacklist_add", { protocol: "openapi", host: "10.9.8.7", port: 8080 }, ctx);
    await app.security.setMode("full", { actor: { kind: "console", tokenPresent: true } });
    assert.equal(app.security.mode(), "full");

    await assert.rejects(
      () =>
        callManagementTool(
          "mcp_add",
          { protocol: "openapi", name: "again", config: { spec: specPath, baseUrl: "http://10.9.8.7:8080" } },
          ctx,
        ),
      (err: unknown) => err instanceof AdapterError && err.code === "E_BLACKLISTED",
    );

    const listed = (await callManagementTool("mcp_list", { layer: "business" }, ctx)) as {
      tools: Array<{ name: string }>;
    };
    assert.ok(!listed.tools.some((t) => t.name.startsWith("openapi.live.")));
    const health = (await callManagementTool("mcp_health", {}, ctx)) as {
      security: { mode: string };
      toolLayers: { hiddenBlacklisted?: number; business: number };
      adapters: Array<{ tools: string[] }>;
    };
    assert.equal(health.security.mode, "full");
    assert.equal(health.toolLayers.hiddenBlacklisted, undefined);
    assert.ok(!health.adapters.some((a) => a.tools.some((n) => n.startsWith("openapi.live."))));

    const spoofed = (await callManagementTool("mcp_list", { layer: "business", audience: "console" }, ctx)) as {
      tools: Array<{ name: string }>;
      adapters: Array<{ tools: string[] }>;
    };
    assert.ok(!spoofed.tools.some((t) => t.name.startsWith("openapi.live.")));
    assert.ok(!spoofed.adapters.some((a) => a.tools.some((n) => n.startsWith("openapi.live."))));

    const consoleCtx = { ...ctx, actor: { kind: "console" as const, tokenPresent: true } };
    const consoleList = (await callManagementTool("mcp_list", { layer: "business", audience: "console" }, consoleCtx)) as {
      tools: Array<{ name: string }>;
    };
    assert.ok(consoleList.tools.some((t) => t.name === "openapi.live.listWidgets"));

    const consoleHealth = (await callManagementTool("mcp_health", {}, consoleCtx)) as {
      toolLayers: { hiddenBlacklisted?: number };
    };
    assert.ok((consoleHealth.toolLayers.hiddenBlacklisted ?? 0) > 0);

    await assert.rejects(
      () => app.registry.invoke("openapi.live.listWidgets", {}),
      (err: unknown) => err instanceof AdapterError && err.code === "E_BLACKLISTED",
    );
  });

  it("MCP tools/list hides blacklisted business tools; CIDR denied in full", async () => {
    const tmp = await withTempDir();
    const app = track(await createEverything2McpServer({ dataDir: tmp.dataDir }), tmp.cleanup);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "sec", version: "0.0.0" });
    await Promise.all([app.server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(async () => {
      await client.close().catch(() => undefined);
    });

    await client.callTool({
      name: "mcp_add",
      arguments: { protocol: "openapi", name: "hideme", config: { spec: specPath, baseUrl: "http://10.1.2.3:80" } },
    });
    await client.callTool({
      name: "mcp_blacklist_add",
      arguments: { protocol: "openapi", host: "10.1.2.3", port: 80 },
    });
    await app.security.setMode("full", { actor: { kind: "console", tokenPresent: true } });

    const tools = await client.listTools();
    assert.ok(!tools.tools.some((t) => t.name.startsWith("openapi.hideme.")));
    assert.ok(tools.tools.some((t) => t.name === "mcp_list"));

    const invoked = await client.callTool({ name: "openapi.hideme.listWidgets", arguments: {} });
    assert.equal(invoked.isError, true);
    const payload = JSON.parse(textOf(invoked as { content: Array<{ type: string; text?: string }> }));
    assert.equal(payload.code, "E_BLACKLISTED");

    const scanned = await client.callTool({
      name: "discovery_scan_host",
      arguments: { host: "10.0.0.0/8" },
    });
    assert.equal(scanned.isError, true);
    const scanBody = JSON.parse(textOf(scanned as { content: Array<{ type: string; text?: string }> }));
    assert.equal(scanBody.code, "E_UNSUPPORTED");
  });

  it("REST GET/PUT security mode; v1 loader rejects file/package", async () => {
    const tmp = await withTempDir();
    const app = track(
      await startHttp({ dataDir: tmp.dataDir, transport: { kind: "http", port: 0, host: "127.0.0.1" } }),
      tmp.cleanup,
    );
    const base = app.http.url;
    const got = await fetch(`${base}/api/security`);
    assert.equal(got.status, 200);
    const body = (await got.json()) as { mode: string; modules: Array<{ id: string; bypassInFullControl: boolean }> };
    assert.equal(body.mode, "safe");
    const bl = body.modules.find((m) => m.id === "builtin-blacklist");
    assert.ok(bl);
    assert.equal(bl.bypassInFullControl, false);
    const aw = body.modules.find((m) => m.id === "allow-write");
    assert.equal(aw?.bypassInFullControl, true);

    const noConfirm = await fetch(`${base}/api/security/mode`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "full" }),
    });
    assert.equal(noConfirm.status, 400);

    const put = await fetch(`${base}/api/security/mode`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "full", confirm: true }),
    });
    assert.equal(put.status, 200);
    const after = (await put.json()) as { mode: string };
    assert.equal(after.mode, "full");

    await assert.rejects(
      () => app.security.inject({ id: "evil", hooks: ["invoke"], evaluate: async () => ({ effect: "allow", reason: "x", moduleId: "evil" }) }, { source: "file" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
    await assert.rejects(
      () => app.security.replace("allow-write", { id: "allow-write", hooks: ["invoke"], evaluate: async () => ({ effect: "allow", reason: "x", moduleId: "allow-write" }) }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );

    const sec = (await (await fetch(`${base}/api/security`)).json()) as {
      integrity: { algo: string; files: Record<string, string | null> };
      policy: { fullDoesNotEnableWrite: boolean; blacklistInFull: boolean };
    };
    assert.equal(sec.integrity.algo, "sha256");
    assert.equal(typeof sec.integrity.files["security.json"], "string");
    assert.equal(sec.policy.fullDoesNotEnableWrite, true);
    assert.equal(sec.policy.blacklistInFull, true);
  });

  it("IntegrityLedger seals first-seen files and rejects hash mismatch", async () => {
    const tmp = await withTempDir();
    cleanups.push(tmp.cleanup);
    const ledger = new IntegrityLedger(tmp.dataDir);
    await ledger.verifyAll();
    const empty = await ledger.snapshot();
    assert.equal(empty.hmac, false);
    assert.equal(empty.files["security.json"], null);
    assert.equal(empty.files["blacklist.json"], null);
    assert.equal(empty.files["registrations.json"], null);

    await writeFile(join(tmp.dataDir, "security.json"), `${JSON.stringify({ version: 1, mode: "safe", modules: [] }, null, 2)}\n`);
    await ledger.verify("security.json");
    const sealed = await ledger.snapshot();
    assert.match(String(sealed.files["security.json"]), /^[0-9a-f]{64}$/);

    await writeFile(join(tmp.dataDir, "security.json"), `${JSON.stringify({ version: 1, mode: "full", modules: [] }, null, 2)}\n`);
    await assert.rejects(
      () => ledger.verify("security.json"),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED" && /hash mismatch/.test(String(err)),
    );
  });

  it("tampered blacklist.json fails restore and register after seal", async () => {
    const tmp = await withTempDir();
    const app = track(await createEverything2McpServer({ dataDir: tmp.dataDir }), tmp.cleanup);
    const ctx = { registry: app.registry, config: app.config, blacklist: app.blacklist, security: app.security };
    await callManagementTool("mcp_blacklist_add", { protocol: "openapi", host: "10.9.9.9", port: 80 }, ctx);
    const snap = await app.security.integritySnapshot();
    assert.match(String(snap.files["blacklist.json"]), /^[0-9a-f]{64}$/);

    await writeFile(
      join(tmp.dataDir, "blacklist.json"),
      `${JSON.stringify({ version: 1, entries: [] }, null, 2)}\n`,
    );
    await assert.rejects(
      () =>
        callManagementTool(
          "mcp_add",
          { protocol: "openapi", name: "x", config: { spec: specPath, baseUrl: "http://10.8.8.8:80" } },
          ctx,
        ),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED" && /Integrity/.test(String(err)),
    );

    await app.close();
    await assert.rejects(
      () => createEverything2McpServer({ dataDir: tmp.dataDir }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED" && /Integrity/.test(String(err)),
    );
  });

  it("EVERYTHING2MCP_DISCOVERY_ALLOW_SCAN and allowScan override cannot re-enable CIDR", async () => {
    const cfg = loadAppConfig({
      ...process.env,
      EVERYTHING2MCP_DISCOVERY_ALLOW_SCAN: "true",
    });
    assert.equal(cfg.discovery.allowScan, false);

    assert.throws(
      () => assertHostProbeAllowed("10.0.0.0/8", true),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
    assert.throws(
      () => assertHostProbeAllowed("10.0.0.1-254", true),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );

    const tmp = await withTempDir();
    const app = track(
      await createEverything2McpServer({
        dataDir: tmp.dataDir,
        discovery: { allowScan: true, enabled: true, timeoutMs: 200 },
      }),
      tmp.cleanup,
    );
    assert.equal(app.config.discovery.allowScan, false);
    const ctx = { registry: app.registry, config: app.config, blacklist: app.blacklist, security: app.security };
    await assert.rejects(
      () => callManagementTool("discovery_scan_host", { host: "10.0.0.0/8" }, ctx),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED" && /network range/.test(String(err)),
    );
    await assert.rejects(
      () => callManagementTool("discovery_probe", { host: "192.168.0.0/16" }, ctx),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
  });

  it("REST /api/tools stays console audience; Full does not lift adapter assertCanWrite", async () => {
    const tmp = await withTempDir();
    const app = track(
      await startHttp({ dataDir: tmp.dataDir, transport: { kind: "http", port: 0, host: "127.0.0.1" } }),
      tmp.cleanup,
    );
    const base = app.http.url;
    const ctx = { registry: app.registry, config: app.config, blacklist: app.blacklist, security: app.security };

    await callManagementTool(
      "mcp_add",
      { protocol: "openapi", name: "shown", config: { spec: specPath, baseUrl: "http://10.4.5.6:8080" } },
      ctx,
    );
    await callManagementTool("mcp_blacklist_add", { protocol: "openapi", host: "10.4.5.6", port: 8080 }, ctx);
    await callManagementTool(
      "mcp_add",
      { protocol: "sqlite", name: "mem", config: { filename: ":memory:" } },
      ctx,
    );
    await app.security.setMode("full", { actor: { kind: "console", tokenPresent: true } });

    const restTools = (await (await fetch(`${base}/api/tools?layer=business`)).json()) as {
      tools: Array<{ name: string }>;
    };
    assert.ok(restTools.tools.some((t) => t.name.startsWith("openapi.shown.")));

    const agentList = (await callManagementTool("mcp_list", { layer: "business" }, ctx)) as {
      tools: Array<{ name: string }>;
    };
    assert.ok(!agentList.tools.some((t) => t.name.startsWith("openapi.shown.")));

    await assert.rejects(
      () => app.registry.invoke("sqlite.mem.execute", { sql: "CREATE TABLE t (id INT)" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED" && /allowWrite/.test(String(err)),
    );

    const writeRest = await fetch(`${base}/api/tools/${encodeURIComponent("sqlite.mem.execute")}/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ arguments: { sql: "CREATE TABLE t (id INT)" }, confirm: true }),
    });
    assert.equal(writeRest.status, 403);
    const writeBody = (await writeRest.json()) as { code: string; error?: string };
    assert.equal(writeBody.code, "E_UNSUPPORTED");
    assert.match(String(writeBody.error ?? writeBody), /allowWrite/);
  });

  it("Agent cannot spoof audience=console; explain/query hide blacklisted names", async () => {
    const tmp = await withTempDir();
    const app = track(await createEverything2McpServer({ dataDir: tmp.dataDir }), tmp.cleanup);
    const agent = { registry: app.registry, config: app.config, blacklist: app.blacklist, security: app.security };
    const console = { ...agent, actor: { kind: "console" as const, tokenPresent: true } };

    await callManagementTool(
      "mcp_add",
      { protocol: "openapi", name: "ghost", config: { spec: specPath, baseUrl: "http://10.7.7.7:80" } },
      agent,
    );
    await callManagementTool("mcp_blacklist_add", { protocol: "openapi", host: "10.7.7.7", port: 80 }, agent);

    await assert.rejects(
      () => callManagementTool("mcp_explain_tool", { name: "openapi.ghost.listWidgets" }, agent),
      (err: unknown) => err instanceof AdapterError && err.code === "E_BLACKLISTED",
    );
    const explained = (await callManagementTool("mcp_explain_tool", { name: "openapi.ghost.listWidgets" }, console)) as {
      name: string;
    };
    assert.equal(explained.name, "openapi.ghost.listWidgets");

    const queried = (await callManagementTool("mcp_query_by_protocol", { protocol: "openapi" }, agent)) as {
      tools: Array<{ name: string }>;
      adapters: Array<{ tools: string[] }>;
    };
    assert.ok(!queried.tools.some((t) => t.name.startsWith("openapi.ghost.")));
    assert.ok(!queried.adapters.some((a) => a.tools.some((n) => n.startsWith("openapi.ghost."))));

    const consoleQuery = (await callManagementTool("mcp_query_by_protocol", { protocol: "openapi" }, console)) as {
      tools: Array<{ name: string }>;
    };
    assert.ok(consoleQuery.tools.some((t) => t.name === "openapi.ghost.listWidgets"));
  });
});
