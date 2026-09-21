import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ERROR_CODES, ERROR_CODE_HELP } from "../src/runtime/errors.js";
import { knownProtocols, registerBuiltinAdapters } from "../src/adapters/index.js";
import { canonicalProtocol, PROTOCOL_CONFIG_HELP } from "../src/catalog/validate.js";
import { startHttp } from "../src/transport/http.js";

async function withTempDir(): Promise<{ dataDir: string; cleanup: () => Promise<void> }> {
  const dataDir = await mkdtemp(join(tmpdir(), "e2mcp-w3-"));
  return { dataDir, cleanup: () => rm(dataDir, { recursive: true, force: true }) };
}

describe("W3 console audit + plan + errors", { timeout: 25_000 }, () => {
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

  it("GET /api/audit tracks invoke success/fail with tool names", async () => {
    const tmp = await withTempDir();
    const app = track(
      await startHttp({ dataDir: tmp.dataDir, transport: { kind: "http", port: 0, host: "127.0.0.1" } }),
      tmp.cleanup,
    );
    const base = app.http.url;

    const before = await fetch(`${base}/api/audit`);
    assert.equal(before.status, 200);
    const beforeBody = (await before.json()) as { counts: { success: number; fail: number }; events: unknown[] };
    assert.equal(typeof beforeBody.counts.success, "number");

    const add = await fetch(`${base}/api/adapters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ protocol: "sqlite", name: "w3", config: { filename: ":memory:" } }),
    });
    assert.equal(add.status, 201);

    const ok = await fetch(`${base}/api/tools/${encodeURIComponent("sqlite.w3.list_tables")}/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ arguments: {} }),
    });
    assert.equal(ok.status, 200);

    const fail = await fetch(`${base}/api/tools/${encodeURIComponent("sqlite.w3.execute")}/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ arguments: { sql: "CREATE TABLE t(x INTEGER)" }, confirm: true }),
    });
    assert.equal(fail.status, 403);

    const after = await fetch(`${base}/api/audit?limit=20`);
    const afterBody = (await after.json()) as {
      counts: { success: number; fail: number };
      events: Array<{ ok: boolean; tool?: string; protocol?: string; code?: string }>;
      policy: { allowWriteDefault: boolean };
    };
    assert.equal(afterBody.policy.allowWriteDefault, false);
    assert.ok(afterBody.counts.success >= beforeBody.counts.success + 1);
    assert.ok(afterBody.counts.fail >= beforeBody.counts.fail + 1);
    assert.ok(afterBody.events.some((e) => e.ok && e.tool === "sqlite.w3.list_tables" && e.protocol === "sqlite"));
    assert.ok(afterBody.events.some((e) => !e.ok && e.tool === "sqlite.w3.execute" && e.code === "E_UNSUPPORTED"));
  });

  it("POST /api/plan reuses mcp_plan_bridge and points at discovery/import", async () => {
    const tmp = await withTempDir();
    const app = track(
      await startHttp({ dataDir: tmp.dataDir, transport: { kind: "http", port: 0, host: "127.0.0.1" } }),
      tmp.cleanup,
    );
    const missing = await fetch(`${app.http.url}/api/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(missing.status, 400);

    const res = await fetch(`${app.http.url}/api/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "把 127.0.0.1 上的 MQTT 和 REST 接进来", host: "127.0.0.1" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      plan: { host?: string; steps: Array<{ tool: string }>; recommendations: Array<{ protocol: string }>; policy: { allowWriteDefault: boolean } };
      links: { discovery: string; import: string };
    };
    assert.equal(body.ok, true);
    assert.equal(body.plan.host, "127.0.0.1");
    assert.equal(body.plan.policy.allowWriteDefault, false);
    assert.ok(body.plan.recommendations.some((r) => r.protocol === "mqtt" || r.protocol === "openapi"));
    assert.ok(body.plan.steps.some((s) => s.tool === "discovery_scan_host"));
    assert.equal(body.links.discovery, "/ui/#/discovery");
    assert.equal(body.links.import, "/ui/#/import");
  });

  it("GET /api/errors lists every unified code; matrix help covers known protocols", async () => {
    const tmp = await withTempDir();
    const app = track(
      await startHttp({ dataDir: tmp.dataDir, transport: { kind: "http", port: 0, host: "127.0.0.1" } }),
      tmp.cleanup,
    );
    const res = await fetch(`${app.http.url}/api/errors`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { codes: Array<{ code: string; help: string }> };
    const listed = new Set(body.codes.map((c) => c.code));
    for (const code of ERROR_CODES) {
      assert.ok(listed.has(code), code);
      assert.ok(ERROR_CODE_HELP[code]);
      assert.ok(body.codes.find((c) => c.code === code)?.help);
    }

    const matrix = await fetch(`${app.http.url}/api/matrix`);
    const matrixBody = (await matrix.json()) as { protocols: Array<{ id: string; help: string; canonical: string }> };
    registerBuiltinAdapters();
    for (const id of knownProtocols()) {
      const row = matrixBody.protocols.find((p) => p.id === id);
      assert.ok(row, `matrix missing ${id}`);
      const help = PROTOCOL_CONFIG_HELP[canonicalProtocol(id)] ?? PROTOCOL_CONFIG_HELP[id];
      assert.ok(help, `PROTOCOL_CONFIG_HELP missing ${id}`);
      assert.equal(row.help, help);
    }
  });
});
