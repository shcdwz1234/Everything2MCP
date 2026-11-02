# Partner demo chat (NON-MCP)

A ~5-minute, end-to-end demo of the **E2MCP Partner protocol**. This folder contains a tiny
Node HTTP server (`server.mjs`) that has **no MCP SDK, no `tools/list`, no stdio MCP** — it only
implements the Partner manifest + HTTP invoke path. Once registered, two tools appear on the
single Everything2MCP MCP server:

- `partner.demo_chat.list_chats` — `readonly`
- `partner.demo_chat.send_message` — `write` (still gated by Everything2MCP `allowWrite=false`
  until an operator opens writes)

That is the whole point: a southbound app mounts without writing any MCP code, and the Agent
still talks to **one** MCP server.

Full protocol reference: [docs/PARTNER.md](../../docs/PARTNER.md).

---

## Prerequisites

- Node **≥ 18.18**
- A local clone of this repo, built once

## Step 0 — Fresh clone & build

```bash
git clone <repo-url> everything2mcp
cd everything2mcp
npm ci
npm run build
```

---

## Step 1 — Terminal A: start the HTTP console

The console and the MCP endpoint share one process:

```bash
EVERYTHING2MCP_TRANSPORT=http EVERYTHING2MCP_HTTP_PORT=8742 npm start
```

Windows PowerShell:

```powershell
$env:EVERYTHING2MCP_TRANSPORT = "http"
$env:EVERYTHING2MCP_HTTP_PORT = "8742"
npm start
```

Console: http://127.0.0.1:8742/ui/ · MCP: http://127.0.0.1:8742/mcp

## Step 2 — Terminal B: issue a partner token

The Partner token is **distinct** from `EVERYTHING2MCP_HTTP_TOKEN`. Fetch it from the API (or copy
it from the console **Partner** page, `#/partner`):

```bash
curl -s http://127.0.0.1:8742/api/partner/v1/token
```

## Step 3 — Terminal C: run the demo app

From the repo root:

```bash
E2MCP_URL=http://127.0.0.1:8742 E2MCP_PARTNER_TOKEN=<token> node examples/partner-demo-chat/server.mjs
```

`server.mjs` picks a free loopback port, prints its invoke URL, then **auto-registers** its manifest
against the core. You should see:

```text
partner-demo-chat invoke at http://127.0.0.1:<port>/invoke (not MCP)
registered with Everything2MCP { ok: true, ... }
```

> The manifest advertises `heartbeatTtlMs: 60_000`, and this demo does **not** send heartbeats.
> It expires ~60 s after registration; just re-run Step 3 to re-register.

---

## Sequence (what just happened)

```text
Agent ──MCP──▶ Everything2MCP core ──HTTP invoke──▶ partner-demo-chat (no MCP)
                   ▲                                      │
                   └──── POST /api/partner/v1/register ◀───┘  (manifest + partner token)
```

1. `server.mjs` POSTs its manifest (capability id `demo_chat`, two operations, HTTP invoke URL)
   to `/api/partner/v1/register` with the partner token.
2. The core turns each operation into a catalog tool: `partner.demo_chat.{op}`.
3. On a tool call the core POSTs `{ op, args, call_id }` to the demo's invoke URL and maps
   `{ ok, result }` back to the MCP result.

---

## Safe vs `allowWrite`

The core stays **Safe by default** (`allowWrite=false`):

| Tool | Risk | Runs in Safe? | To run |
| --- | --- | --- | --- |
| `partner.demo_chat.list_chats` | readonly | ✅ yes | call it directly |
| `partner.demo_chat.send_message` | write | ❌ no (`E_UNSUPPORTED`) | operator sets `allowWrite=true` |

Scanning / registering **never** flips write on. To try `send_message`:

1. Console → **高级 → 安全模块** (Advanced → Security), switch **Safe → Full** or enable
   `allowWrite` for the `demo_chat` capability.
2. Send a message; then switch writes back off when you are done.

The header shows `WRITE-OFF` while writes are disabled.

---

## Invoke it from the console / Agent

Once registered, confirm the capability and call it like any other tool:

- Ask the Agent to call `partner.demo_chat.list_chats` (returns the two in-memory chats
  `c1 General`, `c2 Engineering`).
- Or check registration with the meta-tools `partner_list` / `mcp_list`; the tools are listed as
  `partner.demo_chat.*`.

Example result for `list_chats`:

```json
{ "ok": true, "result": { "chats": [
  { "id": "c1", "title": "General" },
  { "id": "c2", "title": "Engineering" }
] } }
```

---

## Teardown

Stop all three terminals (Ctrl+C). The demo holds everything in memory; nothing is persisted.

---

## Troubleshooting

- **`E_UNSUPPORTED` calling `send_message`** — writes are off; see *Safe vs allowWrite* above.
- **401 on register** — the partner token is wrong or you used `EVERYTHING2MCP_HTTP_TOKEN` instead.
  Re-issue from `/api/partner/v1/token`.
- **Tools vanished after ~1 minute** — heartbeat TTL expired; re-run Step 3.
- **Nothing appears** — confirm `npm run build` ran and the console process from Step 1 is alive.

See also: [docs/PARTNER.md](../../docs/PARTNER.md) · [docs/DEMO.md](../../docs/DEMO.md) ·
[root README](../../README.md).
