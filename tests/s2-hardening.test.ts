import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createEverything2McpServer } from "../src/control/server.js";
import { callManagementTool } from "../src/control/tools.js";
import { IntegrityLedger } from "../src/control/security/index.js";
import { SlidingWindowLimiter } from "../src/control/security/rate-limit.js";
import { AuditLog } from "../src/runtime/audit-log.js";
import { AdapterError } from "../src/runtime/errors.js";
import { redactSecrets, SECRET_MASK } from "../src/runtime/redact.js";
import { startHttp } from "../src/transport/http.js";

const specPath = fileURLToPath(new URL("../examples/petstore.openapi.json", import.meta.url));

async function withTempDir(): Promise<{ dataDir: string; cleanup: () => Promise<void> }> {
  const dataDir = await mkdtemp(join(tmpdir(), "e2mcp-s2-"));
  return { dataDir, cleanup: () => rm(dataDir, { recursive: true, force: true }) };
}

describe("S2 integrity HMAC + audit + rate-limit", { timeout: 30_000 }, () => {
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

  it("HMAC seals files and rejects target or ledger tampering", async () => {
    const tmp = await withTempDir();
    cleanups.push(tmp.cleanup);
    const ledger = new IntegrityLedger(tmp.dataDir, { key: "s2-test-key", keySource: "file" });
    assert.equal(ledger.hmac, true);
    assert.equal(ledger.algo, "hmac-sha256");

    await writeFile(join(tmp.dataDir, "security.json"), `${JSON.stringify({ version: 1, mode: "safe", modules: [] }, null, 2)}\n`);
    await assert.rejects(
      () => ledger.verify("security.json"),
      (err: unknown) => err instanceof AdapterError && /not sealed/.test(String(err)),
    );
    await ledger.seal("security.json");
    await ledger.verify("security.json");

    await writeFile(join(tmp.dataDir, "security.json"), `${JSON.stringify({ version: 1, mode: "full", modules: [] }, null, 2)}\n`);
    await assert.rejects(
      () => ledger.verify("security.json"),
      (err: unknown) => err instanceof AdapterError && /hash mismatch/.test(String(err)),
    );

    await ledger.seal("security.json");
    const raw = JSON.parse(await readFile(join(tmp.dataDir, "integrity.json"), "utf8")) as {
      algo: string;
      mac: string;
      files: Record<string, string>;
    };
    assert.equal(raw.algo, "hmac-sha256");
    raw.files["security.json"] = "0".repeat(64);
    await writeFile(join(tmp.dataDir, "integrity.json"), `${JSON.stringify(raw, null, 2)}\n`);
    await assert.rejects(
      () => ledger.verifyAll(),
      (err: unknown) => err instanceof AdapterError && /MAC mismatch/.test(String(err)),
    );
  });

  it("HMAC refuses first-seen after integrity.json wipe", async () => {
    const tmp = await withTempDir();
    cleanups.push(tmp.cleanup);
    const ledger = new IntegrityLedger(tmp.dataDir, { key: "wipe-key" });
    await writeFile(join(tmp.dataDir, "blacklist.json"), `${JSON.stringify({ version: 1, entries: [] }, null, 2)}\n`);
    await ledger.seal("blacklist.json");
    await unlink(join(tmp.dataDir, "integrity.json"));
    await assert.rejects(
      () => ledger.verifyAll(),
      (err: unknown) => err instanceof AdapterError && /integrity.json is missing/.test(String(err)),
    );
  });

  it("seals registrations.json and rejects on-disk edits", async () => {
    const tmp = await withTempDir();
    const app = track(await createEverything2McpServer({ dataDir: tmp.dataDir }), tmp.cleanup);
    const ctx = { registry: app.registry, config: app.config, blacklist: app.blacklist, security: app.security };
    await callManagementTool(
      "mcp_add",
      { protocol: "sqlite", name: "s2reg", config: { filename: ":memory:" } },
      ctx,
    );
    const snap = await app.security.integritySnapshot();
    assert.match(String(snap.files["registrations.json"]), /^[0-9a-f]{64}$/);

    await writeFile(
      join(tmp.dataDir, "registrations.json"),
      `${JSON.stringify({ version: 1, registrations: [] }, null, 2)}\n`,
    );
    await assert.rejects(
      () =>
        callManagementTool(
          "mcp_add",
          { protocol: "sqlite", name: "other", config: { filename: ":memory:" } },
          ctx,
        ),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED" && /Integrity/.test(String(err)),
    );
  });

  it("persists audit.jsonl across restart and redacts secrets", async () => {
    const tmp = await withTempDir();
    const first = track(await createEverything2McpServer({ dataDir: tmp.dataDir }), tmp.cleanup);
    const ctx = {
      registry: first.registry,
      config: first.config,
      blacklist: first.blacklist,
      security: first.security,
      auditLog: first.auditLog,
    };
    await callManagementTool(
      "mcp_add",
      { protocol: "sqlite", name: "aud", config: { filename: ":memory:" } },
      ctx,
    );
    await first.registry.invoke("sqlite.aud.list_tables", {});
    first.auditLog.record({
      at: new Date().toISOString(),
      ok: true,
      kind: "policy",
      detail: "manual",
      tool: "note",
      ...({ token: "super-secret-token", password: "hunter2" } as Record<string, unknown>),
    } as Parameters<AuditLog["record"]>[0]);
    await first.auditLog.flush();
    await first.close();

    const second = track(await createEverything2McpServer({ dataDir: tmp.dataDir }));
    const snap = second.auditLog.snapshot(20);
    assert.ok(snap.counts.success >= 1);
    assert.ok(snap.events.some((e) => e.tool === "sqlite.aud.list_tables"));
    const leaked = await readFile(join(tmp.dataDir, "audit.jsonl"), "utf8");
    assert.ok(!leaked.includes("super-secret-token"));
    assert.ok(!leaked.includes("hunter2"));
    assert.ok(leaked.includes(SECRET_MASK));
  });

  it("GET /api/audit reads persisted log; REST security shows hmac=false by default", async () => {
    const tmp = await withTempDir();
    const app = track(
      await startHttp({ dataDir: tmp.dataDir, transport: { kind: "http", port: 0, host: "127.0.0.1" } }),
      tmp.cleanup,
    );
    const base = app.http.url;
    const add = await fetch(`${base}/api/adapters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ protocol: "sqlite", name: "http-aud", config: { filename: ":memory:" } }),
    });
    assert.equal(add.status, 201);
    const inv = await fetch(`${base}/api/tools/${encodeURIComponent("sqlite.http-aud.list_tables")}/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ arguments: {} }),
    });
    assert.equal(inv.status, 200);
    await app.auditLog.flush();

    const audit = (await (await fetch(`${base}/api/audit?limit=20`)).json()) as {
      persisted: boolean;
      events: Array<{ tool?: string }>;
    };
    assert.equal(audit.persisted, true);
    assert.ok(audit.events.some((e) => e.tool === "sqlite.http-aud.list_tables"));

    const sec = (await (await fetch(`${base}/api/security`)).json()) as {
      integrity: { hmac: boolean; algo: string; files: Record<string, string | null> };
      rateLimit: { invokePerMinute: number };
      modules: Array<{ id: string }>;
    };
    assert.equal(sec.integrity.hmac, false);
    assert.equal(sec.integrity.algo, "sha256");
    assert.match(String(sec.integrity.files["registrations.json"]), /^[0-9a-f]{64}$/);
    assert.ok(sec.modules.some((m) => m.id === "secret-redact"));
    assert.ok(sec.modules.some((m) => m.id === "tls-material"));
    assert.ok(sec.modules.some((m) => m.id === "rate-limit"));
    assert.equal(sec.rateLimit.invokePerMinute, 60);
  });

  it("rate-limit denies in Safe and is skipped in Full", async () => {
    const limiter = new SlidingWindowLimiter({ invokePerMinute: 1, discoverPerMinute: 1 });
    assert.equal(limiter.try("invoke"), undefined);
    const denied = limiter.try("invoke");
    assert.equal(denied?.effect, "deny");

    const tmp = await withTempDir();
    const app = track(
      await createEverything2McpServer({
        dataDir: tmp.dataDir,
        rateLimit: { invokePerMinute: 1, discoverPerMinute: 1 },
      }),
      tmp.cleanup,
    );
    const ctx = { registry: app.registry, config: app.config, blacklist: app.blacklist, security: app.security };
    await callManagementTool(
      "mcp_add",
      { protocol: "sqlite", name: "rl", config: { filename: ":memory:" } },
      ctx,
    );
    await app.security.assert({
      hook: "invoke",
      actor: { kind: "mcp-stdio", tokenPresent: false },
      tool: { name: "sqlite.rl.list_tables", layer: "business", write: false },
    });
    await assert.rejects(
      () =>
        app.security.assert({
          hook: "invoke",
          actor: { kind: "mcp-stdio", tokenPresent: false },
          tool: { name: "sqlite.rl.list_tables", layer: "business", write: false },
        }),
      (err: unknown) => err instanceof AdapterError && /Rate limit/.test(String(err)),
    );

    await app.security.setMode("full", { actor: { kind: "console", tokenPresent: true } });
    await app.security.assert({
      hook: "invoke",
      actor: { kind: "mcp-stdio", tokenPresent: false },
      tool: { name: "sqlite.rl.list_tables", layer: "business", write: false },
    });
  });

  it("redactSecrets still masks token/password", () => {
    const masked = redactSecrets({
      token: "abc",
      password: "x",
      jwt: "eyJhbGciOiJIUzI1NiJ9.e30.sig",
      tlsKey: "-----BEGIN PRIVATE KEY-----",
      timeoutMs: 5,
      allowWrite: false,
    });
    assert.equal(masked.token, SECRET_MASK);
    assert.equal(masked.password, SECRET_MASK);
    assert.equal(masked.jwt, SECRET_MASK);
    assert.equal(masked.tlsKey, SECRET_MASK);
    assert.equal(masked.timeoutMs, 5);
  });
});
