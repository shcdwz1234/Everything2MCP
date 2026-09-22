# Error codes

Adapter and management tools return a stable JSON payload when a call fails. **Current snapshot: Phase U** (no new error codes; `E_BLACKLISTED` / `E_UNSUPPORTED` still cover skip/deny paths).

Adapter and management tools return a stable JSON payload when a call fails:

```json
{ "ok": false, "error": "human message", "code": "E_INVALID_CONFIG", "protocol": "mqtt" }
```

`code` is always one of the values in `ERROR_CODES` (`src/runtime/errors.ts`). HTTP transport auth failures use the same `E_AUTH` token on the 401 body.

| Code | When |
| --- | --- |
| `E_UNKNOWN_PROTOCOL` | No adapter factory for the protocol id |
| `E_INVALID_CONFIG` | Registration config failed validation or is missing required keys |
| `E_INVALID_ARGUMENT` | Tool argument missing, wrong type, or unusable (also HTTP session start without `initialize`) |
| `E_NOT_CONNECTED` | Tool name is not bound to a live adapter |
| `E_UNKNOWN_TOOL` | No such MCP tool in the catalog |
| `E_NOT_FOUND` | Unknown registration id, or unknown HTTP/SSE session |
| `E_CONFLICT` | Registration id already exists |
| `E_TIMEOUT` | Adapter invoke exceeded `config.timeoutMs` |
| `E_AUTH` | Adapter credentials failed, or the HTTP transport token was missing/wrong |
| `E_UNSUPPORTED` | Feature, live client library, or mode is not available |
| `E_PROTOCOL` | Wire-protocol or backend error after a request was attempted |
| `E_BLACKLISTED` | Target matches the operator blacklist; new registrations and invoke are blocked (HTTP 403) |

Plain `Error` messages are classified by `AdapterError.from` / `guessCode` (timeout, unknown tool, 401, …).

## Audit counters

Each adapter `invoke` (via `invokeWithMiddleware`) increments process-wide success/fail counts and logs them on stderr:

```
[everything2mcp] adapter invoke ok {"success":3,"fail":0}
[everything2mcp] adapter invoke fail {"success":3,"fail":1,"code":"E_TIMEOUT"}
```

`mcp_health` includes `invokeAudit: { success, fail }` plus the configured transport kind/host/port.

控制台 `GET /api/audit` 返回同一计数，外加：

- 进程内环形事件（tool / protocol / adapterId / code；约 200 条截断，即时视图）
- **`dataDir/audit.jsonl` 追加持久化**（启动重载；`#/audit` 读这个）。完整性账本**不封** `audit.jsonl`（有意；见 [SECURITY_ARCHITECTURE.md](SECURITY_ARCHITECTURE.md)）

事件里的 token/password 走 `redactSecrets`。`GET /api/errors` 列出全部 `ERROR_CODES` 与 `ERROR_CODE_HELP`。
