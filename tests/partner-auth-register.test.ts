import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createEverything2McpServer } from "../src/control/server.js";
import { handleConsoleRest } from "../src/control/rest.js";
import { readOrCreatePartnerToken } from "../src/control/partner.js";

describe("Partner registration auth + schema", { timeout: 20_000 }, () => {
  const cleanups: Array<() => Promise<void>> = [];
  after(async () => {
    for (const fn of [...cleanups].reverse()) await fn().catch(() => undefined);
  });

  it("register without bearer is E_AUTH; schema stays public; bad token rejected", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "e2mcp-partner-auth-"));
    const app = await createEverything2McpServer({ dataDir });
    cleanups.push(async () => {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    });
    const ctx = { registry: app.registry, config: app.config, blacklist: app.blacklist, security: app.security };
    const manifest = {
      capability_id: "auth_chat",
      display_name: "Auth Chat",
      version: "1.0.0",
      operations: [
        {
          name: "ping",
          description: "ping",
          risk: "readonly",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
      invoke: { kind: "http", url: "http://127.0.0.1:9/invoke" },
      simulator: true,
    };

    const noAuth = await handleConsoleRest(ctx, {
      method: "POST",
      pathname: "/api/partner/v1/register",
      query: new URLSearchParams(),
      body: manifest,
      headers: {},
    });
    assert.equal(noAuth.status, 401);
    assert.equal((noAuth.body as { code?: string }).code, "E_AUTH");

    const bad = await handleConsoleRest(ctx, {
      method: "POST",
      pathname: "/api/partner/v1/register",
      query: new URLSearchParams(),
      body: manifest,
      headers: { authorization: "Bearer wrong-token" },
    });
    assert.equal(bad.status, 401);

    const schema = await handleConsoleRest(ctx, {
      method: "GET",
      pathname: "/api/partner/v1/schema",
      query: new URLSearchParams(),
      headers: {},
    });
    assert.equal(schema.status, 200);

    const token = await readOrCreatePartnerToken(dataDir);
    const ok = await handleConsoleRest(ctx, {
      method: "POST",
      pathname: "/api/partner/v1/register",
      query: new URLSearchParams(),
      body: manifest,
      headers: { authorization: "Bearer " + token },
    });
    assert.equal(ok.status, 201);
    assert.ok(app.registry.get("partner:auth_chat"));
  });
});
