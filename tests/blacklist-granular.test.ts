import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BlacklistStore, toolPatternMatches } from "../src/catalog/blacklist.js";
import { createEverything2McpServer } from "../src/control/server.js";
import { callManagementTool } from "../src/control/tools.js";
import { AdapterError } from "../src/runtime/errors.js";
import { startHttp } from "../src/transport/http.js";

const specPath = fileURLToPath(new URL("../examples/petstore.openapi.json", import.meta.url));

async function tmp(): Promise<{ dataDir: string; cleanup: () => Promise<void> }> {
  const dataDir = await mkdtemp(join(tmpdir(), "e2m-s3-"));
  return { dataDir, cleanup: () => rm(dataDir, { recursive: true, force: true }) };
}

const blocked = (err: unknown) => err instanceof AdapterError && err.code === "E_BLACKLISTED";

describe("S3 blacklist granularity: capability instance + tool", { timeout: 30_000 }, () => {
  const cleanups: Array<() => Promise<void>> = [];
  after(async () => {
    for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
  });

  it("glob semantics: * is one segment, ** is any", () => {
    assert.equal(toolPatternMatches("redis.*.flushall", "redis.cache.flushall"), true);
    assert.equal(toolPatternMatches("redis.*.flushall", "redis.a.b.flushall"), false);
    assert.equal(toolPatternMatches("redis.**", "redis.a.b.flushall"), true);
    assert.equal(toolPatternMatches("openapi.live.delete*", "openapi.live.deleteWidget"), true);
    assert.equal(toolPatternMatches("openapi.live.delete*", "openapi.live.listWidgets"), false);
    assert.equal(toolPatternMatches("openapi.live.listWidgets", "openapi.live.listWidgets"), true);
  });

  it("store: capability + tool entries, v1 compat on load, v2 on mixed save, validation", async () => {
    const t = await tmp();
    cleanups.push(t.cleanup);
    await writeFile(
      join(t.dataDir, "blacklist.json"),
      JSON.stringify({ version: 1, entries: [{ id: "mqtt|10.0.0.8|1883", protocol: "mqtt", host: "10.0.0.8", port: 1883, createdAt: "x" }] }),
    );
    const store = new BlacklistStore(t.dataDir);
    const legacy = await store.list();
    assert.equal(legacy[0]?.kind, "target");
    const cap = await store.add({ kind: "capability", adapterId: "redis:cache", reason: "prod" });
    assert.equal(cap.id, "cap|redis:cache");
    assert.equal(cap.protocol, "redis");
    const tool = await store.add({ kind: "tool", pattern: "redis.*.flushall" });
    assert.equal(tool.id, "tool|redis.*.flushall");
    const raw = JSON.parse(await readFile(join(t.dataDir, "blacklist.json"), "utf8")) as { version: number; entries: unknown[] };
    assert.equal(raw.version, 2);
    assert.equal(raw.entries.length, 3);
    const reread = await new BlacklistStore(t.dataDir).list();
    assert.deepEqual(reread.map((e) => e.kind), ["target", "capability", "tool"]);
    assert.ok(await store.matchTool("redis.cache.flushall"));
    assert.equal(await store.matchTool("redis.cache.get"), undefined);
    assert.ok(await store.matchAdapter("redis:cache"));
    await assert.rejects(() => store.add({ kind: "tool", pattern: "*" }), /bare \*/);
    await assert.rejects(() => store.add({ kind: "tool", pattern: "a b" }));
    await assert.rejects(() => store.add({ kind: "capability", adapterId: "nocolon" }), /protocol:name/);
    await assert.rejects(() => store.add({ kind: "weird", protocol: "mqtt" }), /Unknown blacklist kind/);
    // back to target-only → written as v1 again
    await store.remove(cap.id);
    await store.remove(tool.id);
    const raw2 = JSON.parse(await readFile(join(t.dataDir, "blacklist.json"), "utf8")) as { version: number };
    assert.equal(raw2.version, 1);
  });

  it("capability entry hides the instance's tools from the Agent and blocks invoke; console flags them; 解除 restores", async () => {
    const t = await tmp();
    const app = await createEverything2McpServer({ dataDir: t.dataDir });
    cleanups.push(async () => {
      await app.close();
      await t.cleanup();
    });
    const ctx = { registry: app.registry, config: app.config, blacklist: app.blacklist, security: app.security };
    await callManagementTool("mcp_add", { protocol: "openapi", name: "live", config: { spec: specPath, baseUrl: "http://127.0.0.1:9" } }, ctx);
    await callManagementTool("mcp_add", { protocol: "openapi", name: "other", config: { spec: specPath, baseUrl: "http://127.0.0.1:9" } }, ctx);

    const added = (await callManagementTool("mcp_blacklist_add", { kind: "capability", adapterId: "openapi:live" }, ctx)) as { entry: { id: string } };
    const agentList = (await callManagementTool("mcp_list", {}, ctx)) as { tools: Array<{ name: string }> };
    assert.equal(agentList.tools.some((x) => x.name.startsWith("openapi.live.")), false);
    assert.equal(agentList.tools.some((x) => x.name.startsWith("openapi.other.")), true, "same target, other instance still visible");
    await assert.rejects(() => app.registry.invoke("openapi.live.listWidgets", {}), blocked);

    const consoleCtx = { ...ctx, actor: { kind: "console" as const, tokenPresent: true } };
    const consoleList = (await callManagementTool("mcp_list", { audience: "console" }, consoleCtx)) as {
      tools: Array<{ name: string; blocked?: boolean }>;
    };
    assert.equal(consoleList.tools.find((x) => x.name === "openapi.live.listWidgets")?.blocked, true);

    await callManagementTool("mcp_blacklist_remove", { id: added.entry.id }, ctx);
    const again = (await callManagementTool("mcp_list", {}, ctx)) as { tools: Array<{ name: string }> };
    assert.equal(again.tools.some((x) => x.name.startsWith("openapi.live.")), true);
  });

  it("tool glob hides + blocks matching tools only, even in Full mode", async () => {
    const t = await tmp();
    const app = await createEverything2McpServer({ dataDir: t.dataDir });
    cleanups.push(async () => {
      await app.close();
      await t.cleanup();
    });
    const ctx = { registry: app.registry, config: app.config, blacklist: app.blacklist, security: app.security };
    await callManagementTool("mcp_add", { protocol: "openapi", name: "live", config: { spec: specPath, baseUrl: "http://127.0.0.1:9" } }, ctx);
    const before = (await callManagementTool("mcp_list", {}, ctx)) as { tools: Array<{ name: string }> };
    const names = before.tools.map((x) => x.name).filter((n) => n.startsWith("openapi.live."));
    assert.ok(names.length >= 2);
    const victim = names[0]!;
    await callManagementTool("mcp_blacklist_add", { kind: "tool", pattern: victim }, ctx);
    await app.security.setMode("full", { kind: "console", tokenPresent: true });
    const afterList = (await callManagementTool("mcp_list", {}, ctx)) as { tools: Array<{ name: string }> };
    const left = afterList.tools.map((x) => x.name);
    assert.equal(left.includes(victim), false);
    assert.equal(left.includes(names[1]!), true);
    await assert.rejects(() => app.registry.invoke(victim, {}), blocked);
    await assert.rejects(
      () => app.security.assert({ hook: "invoke", actor: { kind: "mcp-stdio", tokenPresent: false }, tool: { name: victim, adapterId: "openapi:live", protocol: "openapi" } }),
      blocked,
    );
  });

  it("REST: POST /api/blacklist kind=capability|tool, adapters flagged, DELETE 解除", async () => {
    const t = await tmp();
    const app = await startHttp({ dataDir: t.dataDir, transport: { kind: "http", port: 0, host: "127.0.0.1" } });
    cleanups.push(async () => {
      await app.close();
      await t.cleanup();
    });
    const base = app.http.url;
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post("/api/adapters", { protocol: "sqlite", name: "mem", config: { filename: ":memory:" } })).status, 201);
    const cap = await post("/api/blacklist", { kind: "capability", adapterId: "sqlite:mem" });
    assert.equal(cap.status, 201);
    const tool = await post("/api/blacklist", { kind: "tool", pattern: "sqlite.*.execute" });
    assert.equal(tool.status, 201);
    const bad = await post("/api/blacklist", { kind: "tool", pattern: "**" });
    assert.equal(bad.status, 400);
    const list = (await (await fetch(`${base}/api/blacklist`)).json()) as { counts: { capability: number; tool: number } };
    assert.equal(list.counts.capability, 1);
    assert.equal(list.counts.tool, 1);
    const adapters = (await (await fetch(`${base}/api/adapters`)).json()) as { adapters: Array<{ id: string; blacklisted: boolean; blacklistKind: string }> };
    const row = adapters.adapters.find((a) => a.id === "sqlite:mem");
    assert.equal(row?.blacklisted, true);
    assert.equal(row?.blacklistKind, "capability");
    const inv = await post(`/api/tools/${encodeURIComponent("sqlite.mem.list_tables")}/invoke`, { arguments: {} });
    assert.equal(inv.status, 403);
    const del = await fetch(`${base}/api/blacklist/${encodeURIComponent("cap|sqlite:mem")}`, { method: "DELETE" });
    assert.equal(del.status, 200);
    const inv2 = await post(`/api/tools/${encodeURIComponent("sqlite.mem.list_tables")}/invoke`, { arguments: {} });
    assert.equal(inv2.status, 200);
  });
});
