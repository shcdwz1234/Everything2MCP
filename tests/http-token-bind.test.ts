import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { BlacklistStore } from "../src/catalog/blacklist.js";
import { createBuiltinModules } from "../src/control/security/index.js";
import { AdapterError } from "../src/runtime/errors.js";
import { startHttp } from "../src/transport/http.js";

async function withTempDir(): Promise<{ dataDir: string; cleanup: () => Promise<void> }> {
  const dataDir = await mkdtemp(join(tmpdir(), "e2mcp-token-"));
  return { dataDir, cleanup: () => rm(dataDir, { recursive: true, force: true }) };
}

describe("HTTP token on loopback vs non-loopback bind", { timeout: 25_000 }, () => {
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

  it("loopback without token stays open (local console / CI)", async () => {
    const tmp = await withTempDir();
    const app = track(
      await startHttp({ dataDir: tmp.dataDir, transport: { kind: "http", port: 0, host: "127.0.0.1" } }),
      tmp.cleanup,
    );
    const api = await fetch(app.http.url + "/api/security");
    assert.equal(api.status, 200);
    const health = await fetch(app.http.url + "/health");
    assert.equal(health.status, 200);
  });

  it("non-loopback bind with token requires Authorization on /api and /mcp; /health stays open", async () => {
    const tmp = await withTempDir();
    const token = "non-loop-token-" + Date.now();
    const app = track(
      await startHttp({
        dataDir: tmp.dataDir,
        transport: { kind: "http", port: 0, host: "0.0.0.0", token },
      }),
      tmp.cleanup,
    );
    assert.equal(app.http.host, "0.0.0.0");

    const deniedApi = await fetch(app.http.url + "/api/security");
    assert.equal(deniedApi.status, 401);
    const deniedBody = (await deniedApi.json()) as { code: string };
    assert.equal(deniedBody.code, "E_AUTH");

    const deniedMcp = await fetch(app.http.mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert.equal(deniedMcp.status, 401);

    const health = await fetch(app.http.url + "/health");
    assert.equal(health.status, 200);

    const ok = await fetch(app.http.url + "/api/security", {
      headers: { Authorization: "Bearer " + token },
    });
    assert.equal(ok.status, 200);
  });

  it("core-auth module denies when tokenConfigured and actor lacks token (Safe and Full)", async () => {
    const blacklist = new BlacklistStore(await mkdtemp(join(tmpdir(), "e2mcp-bl-")));
    let configured = true;
    const modules = createBuiltinModules({
      blacklist,
      tokenConfigured: () => configured,
    });
    const coreAuth = modules.find((m) => m.id === "core-auth");
    assert.ok(coreAuth);
    assert.equal(coreAuth!.bypassInFullControl, false);
    assert.equal(coreAuth!.locked, true);

    const denied = await coreAuth!.evaluate({
      hook: "auth",
      actor: { kind: "console", tokenPresent: false },
      mode: "safe",
    });
    assert.equal(denied.effect, "deny");
    assert.equal(denied.code, "E_AUTH");

    const allowed = await coreAuth!.evaluate({
      hook: "auth",
      actor: { kind: "console", tokenPresent: true },
      mode: "full",
    });
    assert.equal(allowed.effect, "allow");

    configured = false;
    const open = await coreAuth!.evaluate({
      hook: "auth",
      actor: { kind: "console", tokenPresent: false },
      mode: "safe",
    });
    assert.equal(open.effect, "allow");
  });
});
