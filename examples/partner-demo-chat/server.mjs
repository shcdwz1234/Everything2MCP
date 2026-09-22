#!/usr/bin/env node
/**
 * Partner demo chat — NON-MCP.
 * Tiny HTTP invoke server (list_chats, send_message) plus optional register
 * against a local Everything2MCP core. Zero MCP SDK usage.
 *
 *   E2MCP_URL=http://127.0.0.1:8742 E2MCP_PARTNER_TOKEN=... node server.mjs
 */
import { createServer } from "node:http";

const chats = [
  { id: "c1", title: "General" },
  { id: "c2", title: "Engineering" },
];
const messages = [];

const invokePort = Number(process.env.PARTNER_DEMO_PORT ?? 0);

const server = createServer((req, res) => {
  void (async () => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      body = {};
    }
    res.setHeader("content-type", "application/json");
    const op = body.op;
    if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
      res.end(JSON.stringify({ ok: true, app: "partner-demo-chat", mcp: false, chats: chats.length }));
      return;
    }
    if (op === "list_chats") {
      res.end(JSON.stringify({ ok: true, result: { chats }, call_id: body.call_id }));
      return;
    }
    if (op === "send_message") {
      const row = {
        id: `m-${messages.length + 1}`,
        chat_id: body.args?.chat_id ?? "c1",
        text: body.args?.text ?? "",
      };
      messages.push(row);
      res.end(JSON.stringify({ ok: true, result: { message: row }, call_id: body.call_id }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: `unknown op ${op}`, code: "E_UNKNOWN_TOOL" }));
  })();
});

await new Promise((resolve) => server.listen(invokePort, "127.0.0.1", resolve));
const port = server.address().port;
const invokeUrl = `http://127.0.0.1:${port}/invoke`;
console.log(`partner-demo-chat invoke at ${invokeUrl} (not MCP)`);

const core = process.env.E2MCP_URL;
const token = process.env.E2MCP_PARTNER_TOKEN;
if (core && token) {
  const manifest = {
    capability_id: "demo_chat",
    display_name: "Demo Chat",
    version: "1.0.0",
    operations: [
      {
        name: "list_chats",
        description: "List in-memory chats",
        risk: "readonly",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "send_message",
        description: "Send an in-memory message (gated by allowWrite on the core)",
        risk: "write",
        inputSchema: {
          type: "object",
          properties: { chat_id: { type: "string" }, text: { type: "string" } },
          required: ["chat_id", "text"],
        },
      },
    ],
    invoke: { kind: "http", url: invokeUrl },
    heartbeatTtlMs: 60_000,
  };
  const res = await fetch(`${core.replace(/\/+$/, "")}/api/partner/v1/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "x-partner-token": token,
    },
    body: JSON.stringify(manifest),
  });
  const json = await res.json();
  console.log("registered with Everything2MCP", json);
}

export { server, invokeUrl };
