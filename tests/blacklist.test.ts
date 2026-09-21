import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BlacklistStore,
  blacklistId,
  normalizeHost,
  targetFromConfig,
  targetFromInput,
} from "../src/catalog/blacklist.js";
import { createEverything2McpServer } from "../src/control/server.js";
import { callManagementTool } from "../src/control/tools.js";
import { AdapterError } from "../src/runtime/errors.js";
import { startHttp } from "../src/transport/http.js";

const specPath = fileURLToPath(new URL("../examples/petstore.openapi.json", import.meta.url));

async function withTempDir(): Promise<{ dataDir: string; cleanup: () => Promise<void> }> {
  const dataDir = await mkdtemp(join(tmpdir(), "e2mcp-bl-"));
  return { dataDir, cleanup: () => rm(dataDir, { recursive: true, force: true }) };
}

describe("blacklist store + gates", { timeout: 25_000 }, () => {
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

  it("matches canonical protocol + normalized host + port (or url)", () => {
    assert.equal(normalizeHost("Broker.Internal."), "broker.internal");
    assert.equal(normalizeHost("[::1]"), "::1");
    const fromHost = targetFromInput({ protocol: "pg", host: "DB.Example.", port: 5432 });
    assert.equal(blacklistId(fromHost), "postgres|db.example|5432");
    const fromUrl = targetFromInput({ protocol: "openapi", url: "http://127.0.0.1:8080/openapi.json" });
    assert.equal(blacklistId(fromUrl), "openapi|127.0.0.1|8080");
    const fromDefault = targetFromInput({ protocol: "mqtt", host: "10.0.0.8" });
    assert.equal(fromDefault.port, 1883);
    const cfg = targetFromConfig("redis", { url: "redis://Cache.Local:6379/0" });
    assert.ok(cfg);
    assert.equal(blacklistId(cfg), "redis|cache.local|6379");
    assert.equal(targetFromConfig("sqlite", { filename: ":memory:" }), undefined);
  });

  it("persists sibling blacklist.json next to registrations", async () => {
    const tmp = await withTempDir();
    cleanups.push(tmp.cleanup);
    const store = new BlacklistStore(tmp.dataDir);
    const entry = await store.add({ protocol: "mqtt", host: "10.0.0.8", port: 1883, reason: "lab" });
    assert.equal(entry.id, "mqtt|10.0.0.8|1883");
    const raw = JSON.parse(await readFile(join(tmp.dataDir, "blacklist.json"), "utf8")) as {
      version: number;
      entries: Array<{ id: string }>;
    };
    assert.equal(raw.version, 1);
    assert.equal(raw.entries[0]?.id, "mqtt|10.0.0.8|1883");
    const other = new BlacklistStore(tmp.dataDir);
    const listed = await other.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.reason, "lab");
    assert.equal(await other.remove(entry.id), true);
    assert.deepEqual(await other.list(), []);
  });

  it("add → discover filters blacklisted candidates from suggestions", async () => {
    const tmp = await withTempDir();
    const app = track(await createEverything2McpServer({ dataDir: tmp.dataDir }), tmp.cleanup);
    const ctx = { registry: app.registry, config: app.config, blacklist: app.blacklist, security: app.security };
    await callManagementTool("mcp_blacklist_add", { protocol: "mqtt", host: "10.0.0.8", port: 1883 }, ctx);
    const suggested = (await callManagementTool(
      "discovery_suggest",
      {
        candidates: [
          { protocol: "mqtt", url: "mqtt://10.0.0.8:1883", hint: "mqtt fingerprint", status: 200, title: "broker" },
          {
            protocol: "openapi",
            url: "http://10.0.0.8:8080/openapi.json",
            hint: "openapi",
            status: 200,
            title: "widgets",
          },
        ],
      },
      ctx,
    )) as {
      suggestions: Array<{ protocol: string }>;
      candidates: Array<{ protocol: string; blacklisted?: boolean; blacklistId?: string }>;
      blocked: Array<{ protocol: string }>;
      hiddenBlacklisted: number;
    };
    assert.equal(suggested.hiddenBlacklisted, 1);
    assert.equal(suggested.blocked.length, 1);
    assert.equal(suggested.blocked[0]?.protocol, "mqtt");
    assert.deepEqual(
      suggested.suggestions.map((s) => s.protocol),
      ["openapi"],
    );
    const mqtt = suggested.candidates.find((c) => c.protocol === "mqtt");
    assert.equal(mqtt?.blacklisted, true);
    assert.equal(mqtt?.blacklistId, "mqtt|10.0.0.8|1883");
    const openapi = suggested.candidates.find((c) => c.protocol === "openapi");
    assert.equal(openapi?.blacklisted, false);
  });

  it("mcp_add / discovery register refuse E_BLACKLISTED; remove then add works", async () => {
    const tmp = await withTempDir();
    const app = track(await createEverything2McpServer({ dataDir: tmp.dataDir }), tmp.cleanup);
    const ctx = { registry: app.registry, config: app.config, blacklist: app.blacklist, security: app.security };
    const added = (await callManagementTool(
      "mcp_blacklist_add",
      { protocol: "openapi", url: "http://10.9.8.7:8080/openapi.json", reason: "nope" },
      ctx,
    )) as { entry: { id: string } };
    assert.equal(added.entry.id, "openapi|10.9.8.7|8080");

    await assert.rejects(
      () =>
        callManagementTool(
          "mcp_add",
          {
            protocol: "openapi",
            name: "blocked",
            config: { spec: specPath, baseUrl: "http://10.9.8.7:8080" },
          },
          ctx,
        ),
      (err: unknown) => err instanceof AdapterError && err.code === "E_BLACKLISTED",
    );

    await assert.rejects(
      () =>
        callManagementTool(
          "mcp_add_from_discovery",
          {
            suggestion: {
              protocol: "openapi",
              name: "from-scan",
              config: { spec: specPath, baseUrl: "http://10.9.8.7:8080" },
            },
          },
          ctx,
        ),
      (err: unknown) => err instanceof AdapterError && err.code === "E_BLACKLISTED",
    );

    await callManagementTool("mcp_blacklist_remove", { id: added.entry.id }, ctx);
    const created = (await callManagementTool(
      "mcp_add",
      {
        protocol: "openapi",
        name: "oknow",
        config: { spec: specPath, baseUrl: "http://10.9.8.7:8080" },
      },
      ctx,
    )) as { id: string };
    assert.equal(created.id, "openapi:oknow");
  });

  it("already-mounted adapter invoke is refused after blacklist", async () => {
    const tmp = await withTempDir();
    const app = track(await createEverything2McpServer({ dataDir: tmp.dataDir }), tmp.cleanup);
    const ctx = { registry: app.registry, config: app.config, blacklist: app.blacklist, security: app.security };
    await callManagementTool(
      "mcp_add",
      {
        protocol: "openapi",
        name: "live",
        config: { spec: specPath, baseUrl: "http://10.9.8.7:8080" },
      },
      ctx,
    );
    await callManagementTool("mcp_blacklist_add", { protocol: "openapi", host: "10.9.8.7", port: 8080 }, ctx);
    await assert.rejects(
      () => app.registry.invoke("openapi.live.listWidgets", {}),
      (err: unknown) => err instanceof AdapterError && err.code === "E_BLACKLISTED",
    );
  });

  it("REST GET/POST/DELETE /api/blacklist and POST /api/adapters → 403", async () => {
    const tmp = await withTempDir();
    const app = track(
      await startHttp({ dataDir: tmp.dataDir, transport: { kind: "http", port: 0, host: "127.0.0.1" } }),
      tmp.cleanup,
    );
    const base = app.http.url;

    const settings = await fetch(`${base}/api/settings`);
    const settingsBody = (await settings.json()) as { console: { blacklist?: boolean } };
    assert.equal(settingsBody.console.blacklist, true);

    const created = await fetch(`${base}/api/blacklist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ protocol: "mqtt", host: "10.0.0.8", port: 1883, reason: "rest" }),
    });
    assert.equal(created.status, 201);
    const createdBody = (await created.json()) as { entry: { id: string } };
    assert.equal(createdBody.entry.id, "mqtt|10.0.0.8|1883");

    const listed = await fetch(`${base}/api/blacklist`);
    assert.equal(listed.status, 200);
    const listBody = (await listed.json()) as { entries: Array<{ id: string }> };
    assert.ok(listBody.entries.some((e) => e.id === "mqtt|10.0.0.8|1883"));

    const one = await fetch(`${base}/api/blacklist/${encodeURIComponent("mqtt|10.0.0.8|1883")}`);
    assert.equal(one.status, 200);

    const refused = await fetch(`${base}/api/adapters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        protocol: "mqtt",
        name: "nope",
        config: { url: "mqtt://10.0.0.8:1883", allowWrite: false },
      }),
    });
    assert.equal(refused.status, 403);
    const refusedBody = (await refused.json()) as { code: string };
    assert.equal(refusedBody.code, "E_BLACKLISTED");

    const removed = await fetch(`${base}/api/blacklist/${encodeURIComponent("mqtt|10.0.0.8|1883")}`, {
      method: "DELETE",
    });
    assert.equal(removed.status, 200);

    const missing = await fetch(`${base}/api/blacklist/${encodeURIComponent("mqtt|10.0.0.8|1883")}`);
    assert.equal(missing.status, 404);
  });
});
