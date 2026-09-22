import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createEverything2McpServer } from "../src/control/server.js";
import { handleConsoleRest } from "../src/control/rest.js";
import { callManagementTool } from "../src/control/tools.js";
import { pickupDrops, readOrCreatePartnerToken } from "../src/control/partner.js";
import { AdapterError } from "../src/runtime/errors.js";
import { evaluateLifecycle } from "../src/catalog/lifecycle.js";

const DEMO_OPS = [
  {
    name: "list_chats",
    description: "List in-memory chats",
    risk: "readonly",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "send_message",
    description: "Send an in-memory message",
    risk: "write",
    inputSchema: {
      type: "object",
      properties: { chat_id: { type: "string" }, text: { type: "string" } },
      required: ["chat_id", "text"],
    },
  },
];

async function listenDemo(): Promise<{ port: number; close: () => Promise<void>; chats: unknown[] }> {
  const chats = [{ id: "c1", title: "General" }];
  const messages: unknown[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
        op?: string;
        args?: Record<string, unknown>;
        call_id?: string;
      };
      res.setHeader("content-type", "application/json");
      if (body.op === "list_chats") {
        res.end(JSON.stringify({ ok: true, result: { chats } }));
        return;
      }
      if (body.op === "send_message") {
        const row = { id: `m-${messages.length + 1}`, ...body.args };
        messages.push(row);
        res.end(JSON.stringify({ ok: true, result: { message: row } }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: "unknown op", code: "E_UNKNOWN_TOOL" }));
    })();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as { port: number }).port,
    chats,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

describe("Phase X Partner lifecycle", { timeout: 25_000 }, () => {
  const cleanups: Array<() => Promise<void>> = [];
  after(async () => {
    for (const fn of [...cleanups].reverse()) await fn().catch(() => undefined);
  });

  it("register → tools appear → invoke demo → unregister → tools gone", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "e2mcp-px-"));
    const demo = await listenDemo();
    const app = await createEverything2McpServer({ dataDir });
    cleanups.push(async () => {
      await app.close();
      await demo.close();
      await rm(dataDir, { recursive: true, force: true });
    });
    const ctx = { registry: app.registry, config: app.config, blacklist: app.blacklist, security: app.security };
    const token = await readOrCreatePartnerToken(dataDir);
    const headers = { authorization: `Bearer ${token}` };
    const manifest = {
      capability_id: "demo_chat",
      display_name: "Demo Chat",
      version: "1.0.0",
      operations: DEMO_OPS,
      invoke: { kind: "http", url: `http://127.0.0.1:${demo.port}/invoke` },
      heartbeatTtlMs: 30_000,
    };
    const registered = await handleConsoleRest(ctx, {
      method: "POST",
      pathname: "/api/partner/v1/register",
      query: new URLSearchParams(),
      body: manifest,
      headers,
    });
    assert.equal(registered.status, 201);
    const tools = app.registry.list().tools.map((t) => t.name);
    assert.ok(tools.includes("partner.demo_chat.list_chats"));
    assert.ok(tools.includes("partner.demo_chat.send_message"));
    const listed = (await callManagementTool("partner_list", {}, ctx)) as { connections: Array<{ id: string }> };
    assert.ok(listed.connections.some((c) => c.id === "partner:demo_chat"));

    const chats = (await app.registry.invoke("partner.demo_chat.list_chats", {})) as { chats: unknown[] };
    assert.ok(Array.isArray(chats.chats) && chats.chats.length >= 1);

    await assert.rejects(
      () => app.registry.invoke("partner.demo_chat.send_message", { chat_id: "c1", text: "nope" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );

    const hb = await handleConsoleRest(ctx, {
      method: "POST",
      pathname: "/api/partner/v1/heartbeat",
      query: new URLSearchParams(),
      body: { capability_id: "demo_chat" },
      headers,
    });
    assert.equal(hb.status, 200);

    const noConfirm = await handleConsoleRest(ctx, {
      method: "POST",
      pathname: "/api/partner/v1/unregister",
      query: new URLSearchParams(),
      body: { capability_id: "demo_chat" },
      headers,
    });
    assert.equal(noConfirm.status, 400);

    const gone = await handleConsoleRest(ctx, {
      method: "POST",
      pathname: "/api/partner/v1/unregister",
      query: new URLSearchParams(),
      body: { capability_id: "demo_chat", confirm: true },
      headers,
    });
    assert.equal(gone.status, 200);
    assert.equal(app.registry.get("partner:demo_chat"), undefined);
    assert.equal(
      app.registry.list().tools.some((t) => t.name.startsWith("partner.demo_chat.")),
      false,
    );
  });

  it("missing id is E_NOT_FOUND; write risk cannot Safe-auto; blacklist blocks re-register", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "e2mcp-px2-"));
    const app = await createEverything2McpServer({ dataDir });
    cleanups.push(async () => {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    });
    const ctx = { registry: app.registry, config: app.config, blacklist: app.blacklist, security: app.security };
    const token = await readOrCreatePartnerToken(dataDir);
    const headers = { authorization: `Bearer ${token}` };

    const missing = await handleConsoleRest(ctx, {
      method: "POST",
      pathname: "/api/partner/v1/unregister",
      query: new URLSearchParams(),
      body: { capability_id: "ghost", confirm: true },
      headers,
    });
    assert.equal(missing.status, 404);
    assert.equal((missing.body as { code?: string }).code, "E_NOT_FOUND");

    const writeAuto = evaluateLifecycle({
      proposal: {
        protocol: "partner",
        name: "w",
        config: { riskCeiling: "write", allowWrite: false },
      },
      mode: "safe",
      blacklisted: false,
      alreadyLive: false,
      validated: true,
    });
    assert.equal(writeAuto.autoEligible, false);

    await assert.rejects(
      () =>
        callManagementTool(
          "capability_register",
          {
            protocol: "partner",
            name: "wchat",
            config: {
              capability_id: "wchat",
              display_name: "W",
              version: "1",
              operations: DEMO_OPS,
              simulator: true,
              riskCeiling: "write",
            },
            auto: true,
          },
          ctx,
        ),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );

    const url = "http://127.0.0.1:17999/invoke";
    await callManagementTool("mcp_blacklist_add", { protocol: "partner", url }, ctx);
    const blocked = await handleConsoleRest(ctx, {
      method: "POST",
      pathname: "/api/partner/v1/register",
      query: new URLSearchParams(),
      body: {
        capability_id: "blocked",
        display_name: "Blocked",
        version: "1",
        operations: DEMO_OPS.filter((o) => o.risk === "readonly"),
        invoke: { kind: "http", url },
      },
      headers,
    });
    assert.equal(blocked.status, 403);
    assert.equal((blocked.body as { code?: string }).code, "E_BLACKLISTED");
  });

  it("drops file pickup registers partner tools", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "e2mcp-px3-"));
    const drops = join(dataDir, "drops-in");
    await mkdir(drops, { recursive: true });
    await writeFile(
      join(drops, "pickup_chat.json"),
      JSON.stringify({
        capability_id: "pickup_chat",
        display_name: "Pickup",
        version: "1.0.0",
        operations: [DEMO_OPS[0]],
        simulator: true,
        invoke: { kind: "http" },
      }),
    );
    const app = await createEverything2McpServer({ dataDir });
    cleanups.push(async () => {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    });
    const ctx = { registry: app.registry, config: app.config, blacklist: app.blacklist, security: app.security };
    const picked = await pickupDrops(ctx, drops);
    assert.ok(picked.picked.some((f) => f.endsWith("pickup_chat.json")), JSON.stringify(picked));
    assert.ok(app.registry.get("partner:pickup_chat"));
    assert.ok(app.registry.list().tools.some((t) => t.name === "partner.pickup_chat.list_chats"));
  });

  it("schema endpoint is public on the control plane", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "e2mcp-px4-"));
    const app = await createEverything2McpServer({ dataDir });
    cleanups.push(async () => {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    });
    const ctx = { registry: app.registry, config: app.config, blacklist: app.blacklist, security: app.security };
    const schema = await handleConsoleRest(ctx, {
      method: "GET",
      pathname: "/api/partner/v1/schema",
      query: new URLSearchParams(),
    });
    assert.equal(schema.status, 200);
    assert.equal((schema.body as { ok?: boolean }).ok, true);
  });

  it("issues a usable local partner token (not redacted)", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "e2mcp-px5-"));
    const app = await createEverything2McpServer({ dataDir });
    cleanups.push(async () => {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    });
    const ctx = { registry: app.registry, config: app.config, blacklist: app.blacklist, security: app.security };
    const issued = await handleConsoleRest(ctx, {
      method: "GET",
      pathname: "/api/partner/v1/token",
      query: new URLSearchParams(),
    });
    assert.equal(issued.status, 200);
    const token = (issued.body as { token?: string }).token ?? "";
    assert.ok(token.length >= 16);
    assert.notEqual(token, "••••");
  });
});
