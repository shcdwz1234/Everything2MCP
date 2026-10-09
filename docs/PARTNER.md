# Partner protocol v1

**Phase X.** Southbound apps do **not** implement MCP. The Agent still talks to **one** Everything2MCP over MCP (stdio / Streamable HTTP / SSE). Test baseline: **140 suites / 570 tests** (`npm test`, after the console redesign).

## Southbound priority (hard)

1. **E2MCP Partner protocol** — Capability Manifest + operations + HTTP invoke (or documented IPC).
2. **Native OpenAPI adapters** — Feishu, DingTalk, WeCom, Slack, Notion, GitHub, …
3. **MCP bridge** — last-resort 兜底 (`ingress: mcp_bridge`). Import local `mcpServers` JSON. Marked in console and docs. Do not require vendors to speak MCP.

Catalog records `ingress: partner | native | mcp_bridge`.

## Manifest

JSON Schema: `GET /api/partner/v1/schema` and `PARTNER_MANIFEST_SCHEMA` in `src/adapters/partner/manifest.ts`.

Required fields:

| Field | Meaning |
| --- | --- |
| `capability_id` | `[A-Za-z0-9_-]{1,64}` — becomes Catalog name |
| `display_name` | Human label |
| `version` | App-defined |
| `operations[]` | `name`, `description`, `inputSchema`, `risk`: `readonly` \| `write` \| `desktop` |
| `invoke` | `{ kind: "http", url }` or `{ kind: "ipc", path }` (IPC is documented, invoke is `E_UNSUPPORTED` in v1) |
| `auth` | `none` / `bearer` / `partner_token` |
| `heartbeatTtlMs` | 0 = no expiry |

On register each operation becomes `partner.{capability_id}.{op}`. Same Catalog Lifecycle as every other protocol (Policy `register` hook, `tools/list_changed`).

## Control plane (loopback + partner token)

Token file: `dataDir/partner-token` (created on first access). Distinct from `EVERYTHING2MCP_HTTP_TOKEN`. Console `#/partner` shows it. `GET /api/partner/v1/token` (and rotate) skip REST secret-redaction so the operator can copy the value; other `/api` bodies still mask `token` keys.

| Method | Path | Auth |
| --- | --- | --- |
| `POST` | `/api/partner/v1/register` | Partner token |
| `POST` | `/api/partner/v1/unregister` | Partner token + `confirm:true` |
| `POST` | `/api/partner/v1/heartbeat` | Partner token |
| `POST` | `/api/partner/v1/invoke` | Partner token (internal; normal path is core → partner callback) |
| `GET` | `/api/partner/v1/schema` | none (schema only) |
| `GET` | `/api/partner/v1/token` | Console / HTTP token |
| `GET` | `/api/partner/v1/connections` | Console |

On a tool call the core POSTs `{ op, args, call_id }` to the partner invoke URL and maps `{ ok, result }` back to the MCP tool result.

Unregister uses the same `capability_unregister` / `ToolRegistry.remove` path. Missing id is `E_NOT_FOUND`. No confirm → HTTP 400.

## Risk and auto-register

- Scan / register success **never** sets `allowWrite` / `allowShell` / `allowDesktop` / `allowReadSecrets`.
- Safe + all-readonly operations may `auto:true`.
- Any `write` or `desktop` operation sets `riskCeiling` so Safe-auto is denied (`E_UNSUPPORTED`).
- Write ops still exist but `assertCanWrite` until the operator sets `allowWrite:true`.
- Blacklist blocks re-register and invoke. Blacklist does **not** block unregister.

## Drops

User-placed hot-add (not boot bulk-register of builtins):

- POSIX: `~/.everything2mcp/drops/*.json`
- Windows: `%LOCALAPPDATA%\everything2mcp\drops\*.json`
- Override: `EVERYTHING2MCP_DROPS_DIR`
- Each instance also reads `dataDir/drops/`

Under `node:test` the home directory is not scanned.

## DX

- Node SDK: `sdk/partner/` — `register` / `heartbeat` / `unregister` / `serveInvoke`
- Python stub: `sdk/partner/python/e2mcp_partner.py`
- Demo (zero MCP code): `examples/partner-demo-chat/`
- Agent meta-tools: `partner_list`, `compat_scan`

## Personal WeChat / QQ

Honest non-claim: personal WeChat private chat is **not** Partner-compatible in this release. No payment protocol. No personal QQ protocol. Desktop UI automation is P4 deferred and `allowDesktop`-gated.


## Console: interfaces (operations)

GET /api/partner/v1/connections and the Partner page list each connection's **operations** (接口) with tool names partner.{capability_id}.{op}. Operators can blacklist a single operation via tool-kind blacklist without unregistering the whole partner. display_name, invokeUrl, and ersion are shown alongside the capability id.