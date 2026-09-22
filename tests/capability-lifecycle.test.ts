import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { evaluateLifecycle, evaluateUnregister } from "../src/catalog/lifecycle.js";
import { createEverything2McpServer } from "../src/control/server.js";
import { handleConsoleRest } from "../src/control/rest.js";
import { callManagementTool } from "../src/control/tools.js";
import { AdapterError } from "../src/runtime/errors.js";

async function withTempDir(): Promise<{ dataDir: string; cleanup: () => Promise<void> }> {
  const dataDir = await mkdtemp(join(tmpdir(), "e2mcp-v1-"));
  return { dataDir, cleanup: () => rm(dataDir, { recursive: true, force: true }) };
}

describe("Phase V1 capability lifecycle / hot-add", { timeout: 25_000 }, () => {
  const cleanups: Array<() => Promise<void>> = [];
  after(async () => {
    for (const fn of [...cleanups].reverse()) await fn().catch(() => undefined);
  });

  it("evaluateLifecycle: auto only for Safe+readonly; Full and writes need confirm", () => {
    const proposal = { protocol: "os_info", name: "local", config: { allowWrite: false } };
    const auto = evaluateLifecycle({
      proposal,
      mode: "safe",
      blacklisted: false,
      alreadyLive: false,
      validated: true,
    });
    assert.equal(auto.state, "auto_readonly");
    assert.equal(auto.autoEligible, true);

    const write = evaluateLifecycle({
      proposal: { ...proposal, config: { allowWrite: true } },
      mode: "safe",
      blacklisted: false,
      alreadyLive: false,
      validated: true,
    });
    assert.equal(write.autoEligible, false);
    assert.equal(write.state, "pending_confirm");

    const full = evaluateLifecycle({
      proposal,
      mode: "full",
      blacklisted: false,
      alreadyLive: false,
      validated: true,
    });
    assert.equal(full.autoEligible, false);

    const secrets = evaluateLifecycle({
      proposal: { protocol: "vault", name: "v", config: { simulator: true, allowReadSecrets: true } },
      mode: "safe",
      blacklisted: false,
      alreadyLive: false,
      validated: true,
    });
    assert.equal(secrets.autoEligible, false);
    assert.equal(secrets.state, "pending_confirm");

    const denied = evaluateLifecycle({
      proposal,
      mode: "safe",
      blacklisted: true,
      alreadyLive: false,
      validated: true,
    });
    assert.equal(denied.state, "denied");
  });

  it("evaluateUnregister: live → unregistered; missing → denied; not a write gate", () => {
    const ok = evaluateUnregister({ id: "os_info:box", live: true });
    assert.equal(ok.state, "unregistered");
    assert.equal(ok.found, true);
    const missing = evaluateUnregister({ id: "os_info:ghost", live: false });
    assert.equal(missing.state, "denied");
    assert.equal(missing.found, false);
  });

  it("fresh deploy has zero business adapters (no bulk register at boot)", async () => {
    const tmp = await withTempDir();
    const app = await createEverything2McpServer({ dataDir: tmp.dataDir });
    cleanups.push(async () => {
      await app.close();
      await tmp.cleanup();
    });
    const listed = app.registry.list();
    assert.equal(listed.adapters.length, 0);
    assert.ok(listed.protocols.includes("os_info"));
    assert.ok(listed.protocols.includes("docker"));
    assert.ok(listed.protocols.includes("vault"));
    assert.ok(listed.protocols.includes("smb"));
    assert.ok(listed.protocols.includes("browser"));
  });

  it("capability_register / unregister share policy path; auto denied when write", async () => {
    const tmp = await withTempDir();
    const app = await createEverything2McpServer({ dataDir: tmp.dataDir });
    cleanups.push(async () => {
      await app.close();
      await tmp.cleanup();
    });
    const ctx = { registry: app.registry, config: app.config, blacklist: app.blacklist, security: app.security };

    const added = (await callManagementTool(
      "capability_register",
      { protocol: "os_info", name: "box", config: { allowWrite: false }, auto: true },
      ctx,
    )) as { ok: boolean; id: string; auto: boolean };
    assert.equal(added.ok, true);
    assert.equal(added.id, "os_info:box");
    assert.equal(added.auto, true);
    assert.ok(app.registry.get("os_info:box"));

    await assert.rejects(
      () =>
        callManagementTool(
          "capability_register",
          { protocol: "docker", name: "w", config: { simulator: true, allowWrite: true }, auto: true },
          ctx,
        ),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );

    const gone = (await callManagementTool("capability_unregister", { id: "os_info:box" }, ctx)) as { ok: boolean };
    assert.equal(gone.ok, true);
    assert.equal(app.registry.get("os_info:box"), undefined);
  });

  it("hot-delete: invoke then unregister drops tools; missing id errors; re-add works; Safe allows it", async () => {
    const tmp = await withTempDir();
    const app = await createEverything2McpServer({ dataDir: tmp.dataDir });
    cleanups.push(async () => {
      await app.close();
      await tmp.cleanup();
    });
    const ctx = { registry: app.registry, config: app.config, blacklist: app.blacklist, security: app.security };
    assert.equal(app.security.mode(), "safe");

    await callManagementTool(
      "capability_register",
      { protocol: "os_info", name: "box", config: { allowWrite: false }, confirm: true },
      ctx,
    );
    const uname = await app.registry.invoke("os_info.box.uname", {});
    assert.equal(typeof (uname as { platform?: string }).platform, "string");

    const listedBefore = (await callManagementTool("mcp_list", { layer: "business" }, ctx)) as {
      tools: Array<{ name: string }>;
      adapters: unknown[];
    };
    assert.ok(listedBefore.tools.some((t) => t.name === "os_info.box.uname"));

    const gone = (await callManagementTool("capability_unregister", { id: "os_info:box" }, ctx)) as {
      ok: boolean;
      id: string;
      state: string;
      toolsRemoved: string[];
    };
    assert.equal(gone.ok, true);
    assert.equal(gone.state, "unregistered");
    assert.ok(gone.toolsRemoved.includes("os_info.box.uname"));
    assert.equal(app.registry.get("os_info:box"), undefined);
    assert.equal(app.registry.adapterTools().length, 0);

    const listedAfter = (await callManagementTool("mcp_list", { layer: "business" }, ctx)) as {
      tools: Array<{ name: string }>;
      adapters: unknown[];
    };
    assert.equal(listedAfter.adapters.length, 0);
    assert.ok(!listedAfter.tools.some((t) => t.name === "os_info.box.uname"));

    await assert.rejects(
      () => app.registry.invoke("os_info.box.uname", {}),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNKNOWN_TOOL",
    );

    await assert.rejects(
      () => callManagementTool("capability_unregister", { id: "os_info:box" }, ctx),
      (err: unknown) => err instanceof AdapterError && err.code === "E_NOT_FOUND",
    );

    const again = (await callManagementTool(
      "capability_register",
      { protocol: "os_info", name: "box", config: { allowWrite: false }, auto: true },
      ctx,
    )) as { ok: boolean; id: string };
    assert.equal(again.id, "os_info:box");
    const uname2 = await app.registry.invoke("os_info.box.uname", {});
    assert.equal(typeof (uname2 as { platform?: string }).platform, "string");

    const writable = (await callManagementTool(
      "capability_register",
      { protocol: "docker", name: "w", config: { simulator: true, allowWrite: true }, confirm: true },
      ctx,
    )) as { ok: boolean };
    assert.equal(writable.ok, true);
    const dropWrite = (await callManagementTool("capability_unregister", { id: "docker:w" }, ctx)) as { ok: boolean };
    assert.equal(dropWrite.ok, true);
    assert.equal(app.registry.get("docker:w"), undefined);

    const events = app.auditLog.snapshot(20).events;
    assert.ok(events.some((e) => e.kind === "unregister" && e.adapterId === "os_info:box" && e.ok));
  });

  it("console REST hot-delete requires confirm; DELETE alias works; counts update", async () => {
    const tmp = await withTempDir();
    const app = await createEverything2McpServer({ dataDir: tmp.dataDir });
    cleanups.push(async () => {
      await app.close();
      await tmp.cleanup();
    });
    const ctx = { registry: app.registry, config: app.config, blacklist: app.blacklist, security: app.security };
    await handleConsoleRest(ctx, {
      method: "POST",
      pathname: "/api/capabilities/register",
      query: new URLSearchParams(),
      body: { protocol: "os_info", name: "ui", config: {}, confirm: true },
    });
    assert.ok(app.registry.get("os_info:ui"));

    const denied = await handleConsoleRest(ctx, {
      method: "POST",
      pathname: "/api/capabilities/unregister",
      query: new URLSearchParams(),
      body: { id: "os_info:ui" },
    });
    assert.equal(denied.status, 400);
    assert.ok(app.registry.get("os_info:ui"));

    const ok = await handleConsoleRest(ctx, {
      method: "POST",
      pathname: "/api/capabilities/unregister",
      query: new URLSearchParams(),
      body: { id: "os_info:ui", confirm: true },
    });
    assert.equal(ok.status, 200);
    assert.equal(app.registry.get("os_info:ui"), undefined);

    await handleConsoleRest(ctx, {
      method: "POST",
      pathname: "/api/capabilities/register",
      query: new URLSearchParams(),
      body: { protocol: "journal", name: "ui", config: { simulator: true }, confirm: true },
    });
    const delDenied = await handleConsoleRest(ctx, {
      method: "DELETE",
      pathname: "/api/capabilities/journal:ui",
      query: new URLSearchParams(),
      body: {},
    });
    assert.equal(delDenied.status, 400);
    const delOk = await handleConsoleRest(ctx, {
      method: "DELETE",
      pathname: "/api/capabilities/journal:ui",
      query: new URLSearchParams("confirm=true"),
      body: {},
    });
    assert.equal(delOk.status, 200);
    assert.equal(app.registry.get("journal:ui"), undefined);

    const health = (await callManagementTool("mcp_health", { verbose: false }, ctx)) as {
      adapterCount: number;
      toolCount: number;
    };
    assert.equal(health.adapterCount, 0);
    assert.equal(health.toolCount, 0);
  });

  it("blacklist does not block hot-delete; it still blocks re-add", async () => {
    const tmp = await withTempDir();
    const app = await createEverything2McpServer({ dataDir: tmp.dataDir });
    cleanups.push(async () => {
      await app.close();
      await tmp.cleanup();
    });
    const ctx = { registry: app.registry, config: app.config, blacklist: app.blacklist, security: app.security };
    await callManagementTool(
      "capability_register",
      { protocol: "docker", name: "x", config: { simulator: true, allowWrite: false }, confirm: true },
      ctx,
    );
    await callManagementTool("mcp_blacklist_add", { protocol: "docker", host: "127.0.0.1", port: 2375 }, ctx);
    const gone = (await callManagementTool("capability_unregister", { id: "docker:x" }, ctx)) as { ok: boolean };
    assert.equal(gone.ok, true);
    await assert.rejects(
      () =>
        callManagementTool(
          "capability_register",
          { protocol: "docker", name: "x", config: { url: "http://127.0.0.1:2375" }, confirm: true },
          ctx,
        ),
      (err: unknown) => err instanceof AdapterError && err.code === "E_BLACKLISTED",
    );
  });

  it("blacklist denies hot-add on the same register path", async () => {
    const tmp = await withTempDir();
    const app = await createEverything2McpServer({ dataDir: tmp.dataDir });
    cleanups.push(async () => {
      await app.close();
      await tmp.cleanup();
    });
    const ctx = { registry: app.registry, config: app.config, blacklist: app.blacklist, security: app.security };
    await callManagementTool("mcp_blacklist_add", { protocol: "redis", host: "10.0.0.8", port: 6379 }, ctx);
    await assert.rejects(
      () =>
        callManagementTool(
          "capability_register",
          { protocol: "redis", name: "x", config: { url: "redis://10.0.0.8:6379", allowWrite: false } },
          ctx,
        ),
      (err: unknown) => err instanceof AdapterError && err.code === "E_BLACKLISTED",
    );
  });

  it("console REST hot-add requires confirm unless auto", async () => {
    const tmp = await withTempDir();
    const app = await createEverything2McpServer({ dataDir: tmp.dataDir });
    cleanups.push(async () => {
      await app.close();
      await tmp.cleanup();
    });
    const ctx = { registry: app.registry, config: app.config, blacklist: app.blacklist, security: app.security };
    const denied = await handleConsoleRest(ctx, {
      method: "POST",
      pathname: "/api/capabilities/register",
      query: new URLSearchParams(),
      body: { protocol: "os_info", name: "ui", config: {} },
    });
    assert.equal(denied.status, 400);

    const ok = await handleConsoleRest(ctx, {
      method: "POST",
      pathname: "/api/capabilities/register",
      query: new URLSearchParams(),
      body: { protocol: "os_info", name: "ui", config: {}, confirm: true },
    });
    assert.equal(ok.status, 201);

    const auto = await handleConsoleRest(ctx, {
      method: "POST",
      pathname: "/api/capabilities/register",
      query: new URLSearchParams(),
      body: { protocol: "journal", name: "ui", config: { simulator: true }, auto: true },
    });
    assert.equal(auto.status, 201);
  });
});
