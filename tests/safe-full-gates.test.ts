import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { BlacklistStore } from "../src/catalog/blacklist.js";
import { createEverything2McpServer } from "../src/control/server.js";
import { callManagementTool } from "../src/control/tools.js";
import { createBuiltinModules } from "../src/control/security/index.js";
import { AdapterError } from "../src/runtime/errors.js";

describe("Safe vs Full security gates", { timeout: 25_000 }, () => {
  const cleanups: Array<() => Promise<void>> = [];
  after(async () => {
    for (const fn of [...cleanups].reverse()) await fn().catch(() => undefined);
  });

  it("allow-write module denies write tools without allowWrite in Safe; bypasses in Full", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "e2mcp-gate-"));
    const blacklist = new BlacklistStore(dataDir);
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
    const modules = createBuiltinModules({ blacklist, tokenConfigured: () => false });
    const allowWrite = modules.find((m) => m.id === "allow-write");
    assert.ok(allowWrite);
    assert.equal(allowWrite!.bypassInFullControl, true);

    const denied = await allowWrite!.evaluate({
      hook: "invoke",
      actor: { kind: "mcp-stdio", tokenPresent: false },
      mode: "safe",
      tool: { name: "redis.t.set", layer: "business", write: true },
      config: { allowWrite: false },
    });
    assert.equal(denied.effect, "deny");
    assert.equal(denied.code, "E_UNSUPPORTED");

    const ok = await allowWrite!.evaluate({
      hook: "invoke",
      actor: { kind: "mcp-stdio", tokenPresent: false },
      mode: "safe",
      tool: { name: "redis.t.set", layer: "business", write: true },
      config: { allowWrite: true },
    });
    assert.equal(ok.effect, "allow");
  });

  it("ssrf + discovery-scope modules refuse metadata / CIDR and do not bypass in Full", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "e2mcp-gate2-"));
    const blacklist = new BlacklistStore(dataDir);
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
    const modules = createBuiltinModules({ blacklist, tokenConfigured: () => false });
    const ssrf = modules.find((m) => m.id === "ssrf")!;
    const scope = modules.find((m) => m.id === "discovery-scope")!;
    assert.equal(ssrf.bypassInFullControl, false);
    assert.equal(scope.bypassInFullControl, false);

    const meta = await ssrf.evaluate({
      hook: "register",
      actor: { kind: "console", tokenPresent: true },
      mode: "full",
      target: { host: "169.254.169.254", protocol: "openapi" },
    });
    assert.equal(meta.effect, "deny");

    const cidr = await scope.evaluate({
      hook: "discover",
      actor: { kind: "mcp-stdio", tokenPresent: false },
      mode: "full",
      target: { host: "10.0.0.0/8" },
    });
    assert.equal(cidr.effect, "deny");
  });

  it("adapter allowWrite gate still blocks writes after Full mode switch", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "e2mcp-gate3-"));
    const app = await createEverything2McpServer({ dataDir });
    cleanups.push(async () => {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    });
    const ctx = { registry: app.registry, config: app.config, blacklist: app.blacklist, security: app.security };
    await callManagementTool(
      "mcp_add",
      { protocol: "sqlite", name: "gate", config: { filename: ":memory:", allowWrite: false } },
      ctx,
    );
    await app.security.setMode("full", { actor: { kind: "console", tokenPresent: true } });
    assert.equal(app.security.mode(), "full");
    await assert.rejects(
      () => app.registry.invoke("sqlite.gate.execute", { sql: "CREATE TABLE t(x INTEGER)" }),
      (err: unknown) => err instanceof AdapterError && /allowWrite/.test(String(err)),
    );
    const tables = (await app.registry.invoke("sqlite.gate.list_tables", {})) as { tables: unknown[] };
    assert.ok(Array.isArray(tables.tables));
  });
});
