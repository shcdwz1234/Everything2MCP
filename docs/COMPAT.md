# Compat Catalog

**Phase X.** Compat is a **suggest** surface, not a grant of power. Test baseline: **140 suites / 570 tests** (`npm test`, after the console redesign).

`compat_scan` (and `environment_inventory.compat`) returns structured suggestions with `ingress`. One-click path is the same Lifecycle: `capability_register`.

## Priority bands

| Band | Meaning |
| --- | --- |
| P0 | Compat catalog ∩ installed binaries **plus** Partner drops / live Partner registrations |
| P1 | Config / login clues (env names only — tokens are never copied) |
| P2 | Listening ports / process clues |
| P3 | Cursor / Claude / VS Code / Windsurf-style `mcpServers` JSON → **`mcp_bridge` 兜底 only** |
| P4 | Desktop UI automation — documented deferred, `allowDesktop` gated, not used for detect |

Scan success ≠ `allowWrite` / `allowShell` / `allowDesktop` / `allowReadSecrets`. Safe readonly may auto; write/desktop never auto from scan.

## Catalog

Runtime: `src/discovery/compat-catalog.ts`. Human copy: [`compat/catalog.json`](../compat/catalog.json) (repo root; the former duplicate under `docs/compat/` was removed).

Native adapters (honest MVPs, hermetic simulators; live HTTP behind `config.url`; writes gated):

| appId | protocol | Read | Write (gated) |
| --- | --- | --- | --- |
| feishu / lark | `feishu` | `list_chats`, `search_messages` | `send_message` |
| dingtalk | `dingtalk` | `probe` | `send_work_notice`, `send_robot` |
| wecom | `wecom` | `list_departments`, `list_users` | `send_app_message` |
| slack | `slack` | `conversations_list` | `post_message` |
| notion | `notion` | `search`, `get_page` | `create_page` |
| github | `github` | `list_issues`, `list_pulls` | `create_issue` |

WeCom is **企业微信**, not personal WeChat. Personal WeChat is listed as an honest non-claim (`personal_wechat`) with desktop/P4 gaps.

## MCP bridge (兜底)

`mcp_bridge` imports `mcpServers` objects (or a file `path`). Tools are prefixed `mcp_bridge.{name}.{child}_{op}` (`describe` / `ping` stubs). Live child spawn is `E_UNSUPPORTED`. Console and docs mark this as last-resort. New integrations should use Partner or a native adapter.

## Policy (unchanged)

Blacklist + Policy Gateway still wrap register / invoke / unregister. Unregister is control-plane (not `allowWrite`).
