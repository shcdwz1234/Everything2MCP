# Web Console

同进程管理台：HTTP 监听器在 MCP `/mcp` + SSE `/sse` 之外挂载 **`/ui` SPA** 与 **`/api/*` REST**。业务仍走 `callManagementTool` / `ToolRegistry`，没有第二份 catalog。

**当前快照：Phase X。** 协议矩阵含平台/docker + Partner/native SaaS。`#/capabilities` 热加载/热卸载。`#/partner` 伙伴连接、ingress 徽章、本地 token。部署不批量注册。没有 CIDR 输入。mcp_bridge 在 UI 标为兜底。

## 打开

先构建再开 HTTP（stdio 默认不提供 UI）：

```bash
npm install
npm run build          # tsc + ui:build → dist/ui
EVERYTHING2MCP_TRANSPORT=http EVERYTHING2MCP_HTTP_PORT=8742 npm start
```

浏览器打开 **http://127.0.0.1:8742/ui/**（`GET /` 会 302 到 `/ui/`）。能力清单见 [RELEASE_NOTES.md](RELEASE_NOTES.md)。Windows 同步树示例：`D:\Everything2MCP`。

若设置了 `EVERYTHING2MCP_HTTP_TOKEN`，顶栏胶囊贴上同一 token（`Authorization: Bearer`）。`GET /health` 与静态 `/ui` 不鉴权；`/api/*` 与 MCP 共用 token。

单独构建 UI：

```bash
npm run ui:build
```

产物：`dist/ui/index.html`、`main.js`、`api.js`、`styles.css`。未构建时 `/ui` 返回 503 说明页。

## 页面

| 页 | 作用 |
| --- | --- |
| Dashboard | 健康、hints、适配器一览 |
| 计划桥 | `#/plan` — `mcp_plan_bridge`，步骤跳 Discovery / Import |
| Adapters | CRUD + ping；config 密钥脱敏 |
| Tools | `business` / `management` / `all`；业务 tool 只读试调用 |
| Discovery | 单主机向导（无 CIDR 输入） |
| Import | `schema_import` |
| 审计 | `#/audit` — invoke 成功/失败时间线（`dataDir/audit.jsonl` 持久化，重启可读） |
| 黑名单 | `#/blacklist` — 列表 / 加入 / 解除；Discovery 结果可一键拉黑 |
| 安全 | `#/security` — Safe/Full 热切换（二次确认）；模块表只读。Full 仍执行黑名单，**不会**全局打开 `allowWrite` |
| 热加载 | `#/capabilities` — 环境盘点建议 + 确认热加载；**热卸载**已挂能力（confirm；不要求 allowWrite） |
| Settings | 进程配置只读（不回显 token） |

写操作：UI 二次确认 + 请求体 `confirm:true`，**仍然**受适配器 `allowWrite` / `assertCanWrite` 闸。默认 `allowWrite=false`。切到 Full **只**跳过平面模块 `allow-write`（以及 `dangerous-tools` challenge / `rate-limit` stub），**不会**把现有适配器改成可写。

## REST

| 方法 | 路径 |
| --- | --- |
| GET | `/api/health` `/api/settings` `/api/matrix` |
| GET/POST | `/api/adapters` |
| GET/PUT/DELETE | `/api/adapters/:id` |
| POST | `/api/adapters/:id/ping` |
| GET | `/api/tools?layer=business\|management\|all`（固定 audience=`console`，已拉黑业务 tools **仍列出**） |
| GET | `/api/tools/:name` |
| POST | `/api/tools/:name/invoke` |
| POST | `/api/discovery/scan` `probe` `suggest` `register` |
| POST | `/api/import` |
| GET | `/api/audit` `/api/errors` |
| POST | `/api/plan` |
| GET/POST | `/api/blacklist` |
| GET/DELETE | `/api/blacklist/:id` |
| GET | `/api/security` `/api/security/mode` |
| PUT | `/api/security/mode`（`{ mode, confirm:true }`） |
| POST | `/api/environment/inventory` |
| POST | `/api/capabilities/register`（`confirm:true` 或 Safe+readonly `auto:true`） |
| POST | `/api/capabilities/unregister` `{ id, confirm:true }` |
| DELETE | `/api/capabilities/:id?confirm=true`（与 POST unregister 同一管道） |
| POST | `/api/capabilities/configure` `{ id, config }` |

## W3 页怎么打开

侧栏或 hash：

| Hash | 页 |
| --- | --- |
| `#/` | 仪表盘 |
| `#/plan` | 计划桥（`POST /api/plan`） |
| `#/audit` | 审计时间线（`GET /api/audit`） |
| `#/discovery` | 单主机发现 |
| `#/import` | Schema 导入 |
| `#/blacklist` | 黑名单（`GET/POST/DELETE /api/blacklist`） |
| `#/security` | 安全平面（`GET/PUT /api/security`） |
| `#/capabilities` | 热加载（`POST /api/environment/inventory`、`/api/capabilities/register`） |
| `#/matrix` | 协议矩阵 |
| `#/settings` | 只读设置 |

写操作仍要二次确认 + `allowWrite`。gRPC `tlsWatch: true` 换 PEM 文件后进程内 remount（不必 `mcp_update`）；其它适配器仍用 **保存配置** 重连，见 `docs/TLS.md`。

视觉：底 `#0B0F14`、面板 `#121820`、强调 `#3DD6C6`；侧栏、顶栏胶囊、协议徽章、状态点。

安全平面见 [SECURITY_ARCHITECTURE.md](SECURITY_ARCHITECTURE.md)。`#/security` 已实现 Safe/Full 热切换；模式不是普通 MCP tool。CIDR 永不放行。`GET /api/security` 带完整性快照（`security.json` / `blacklist.json` / `registrations.json`；可选 HMAC）与限流配额。

`GET /api/audit` 读 `dataDir/audit.jsonl`（启动重载）。事件里的 token/password 会脱敏。

**Full vs 写闸：** 平面 `allow-write` 在 Full 下 `bypassInFullControl=true`，避免控制面把「操作员排障」理解成二次策略。数据面仍走各适配器 `assertCanWrite`。Agent `tools/list` / `mcp_list` 默认 audience=`agent`（隐藏已拉黑业务 tools）。控制台 REST 入口写入 `actor.kind=console`，不靠查询串。Agent 传 `audience: "console"` 无效。
