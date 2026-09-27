# Web Console

同进程管理台：HTTP 监听器在 MCP `/mcp` + SSE `/sse` 之外挂载 **`/ui` SPA** 与 **`/api/*` REST**。业务仍走 `callManagementTool` / `ToolRegistry`，没有第二份 catalog。

**当前快照：控制台改版（Console Redesign）。** 信息架构收敛为 **能力 / 活动 / 设置** 三个一级页，旧页面折叠在侧栏「高级」里。添加能力走按协议 `configSchema` 生成的表单向导（先测试连接再保存）。黑名单支持目标 / 能力实例 / 工具三种粒度。私网自动发现支持 自动 / 手动 / 关闭 三档。改版说明见 [CONSOLE_REDESIGN_REPORT.md](CONSOLE_REDESIGN_REPORT.md)。

## 打开

先构建再开 HTTP（stdio 默认不提供 UI）：

```bash
npm install
npm run build          # tsc + 复制 proto + ui:build → dist/ui（跨平台，Windows 也可）
EVERYTHING2MCP_TRANSPORT=http EVERYTHING2MCP_HTTP_PORT=8742 npm start
```

浏览器打开 **http://127.0.0.1:8742/ui/**（`GET /` 会 302 到 `/ui/`）。能力清单见 [RELEASE_NOTES.md](RELEASE_NOTES.md)。

若设置了 `EVERYTHING2MCP_HTTP_TOKEN`，顶栏胶囊贴上同一 token（`Authorization: Bearer`，只存 sessionStorage）。`GET /health` 与静态 `/ui` 不鉴权；`/api/*` 与 MCP 共用 token。

单独构建 UI：`npm run ui:build`（`tsc -p ui/tsconfig.json` + `node scripts/copy-assets.mjs ui`）。产物：`dist/ui/index.html`、`main.js`、`api.js`、`styles.css`。未构建时 `/ui` 返回 503 说明页。

## 一级页

### 能力 `#/caps`

顶部摘要条四格：**当前能力**（总数 / 启用 / 停用 / 拉黑 / 异常）、**可支持能力**（已发现 / 可一键启用 / 需要配置 / 启用失败 / 类型数）、**黑名单**（目标 / 能力 / 工具）、**自动发现**（模式、上次与下次运行、立即扫描）。数字来自 `GET /api/overview`，与下面三个 tab 一一对应，点格子切 tab。右上角 **+ 添加** 直接进向导。

| Tab | Hash | 内容 |
| --- | --- | --- |
| 当前能力 | `#/caps?tab=current` | 所有已注册能力。每行：名称/id、协议徽章、来源（自动发现 / 伙伴 / 手动）与地址（只显示 host:port，不回显 URL 里的凭据）、tools 数、只读/可写、状态、**启用开关**、**加入黑名单**（已拉黑时为 **解除**）、`…` 菜单（配置 / 测试 / 删除）。点行打开右侧 **tools 抽屉**：逐个工具 **屏蔽 / 解除**（工具级黑名单）和 **试调用**。 |
| 可支持能力 | `#/caps?tab=supported` | 上方 **已发现，可一键启用**：自动发现得到的候选。凭据齐全的显示 **一键启用**；缺字段或需要凭据的标 **需要配置**，卡片里只出缺的那几个输入框。也可 **忽略** 或 **加入黑名单**。下方是 **全部支持的类型**：按包分组的类型卡片（带搜索），点卡片打开 **添加向导并预选该类型**；另有「导入 Schema / 扫描单个主机 / MCP Server（兜底）/ Partner 伙伴」入口卡。 |
| 黑名单 | `#/caps?tab=blacklist` | 所有拉黑条目（目标 / 能力实例 / 工具），每条一键 **解除**；底部「手动添加」按范围填写。 |

启用开关关掉 = **停用**：保留注册与配置，卸载其 tools（Agent 看不到），重启后仍保持停用；打开即重新挂载。与「删除」「加入黑名单」不同。

### 添加向导 `#/add`

1. **选择类型**：类型卡片（同「可支持能力」）。`#/add?type=<protocol>` 直接预选。
2. **配置**：由 `GET /api/protocols/:id` 的 `configSchema` 生成。必填在前（`*`），「高级选项」折叠；`oneOf` 组（如 url 或 host）会提示任填其一。密钥字段为 password 输入框，可点「显示」；编辑已有能力时密钥回显为 `••••`，**原样保存即保留旧值**（服务端 `unmaskConfig`）。`allowWrite` 单独放在黄色警示框里，默认关。无法用表单表达的配置可切 **使用原始 JSON**。
3. **测试并保存**：**测试连接** 调 `POST /api/adapters/test`（校验 + SSRF + 安全钩子 + 黑名单，然后临时连接并列出 tools，**不落盘**），成功后显示将暴露的 tools；**保存并启用** 走 `mcp_add`。`#/add?edit=<id>` 为编辑模式。

### 活动 `#/activity`

调用、策略拒绝、启用/停用、能力增删改、黑名单增删、自动发现运行，按时间倒序；「只看失败」过滤。密钥已脱敏（只记录 id）。数据来自 `GET /api/activity`（审计环 + 发现运行记录）。

### 设置 `#/settings`

- **自动发现**：模式（自动 / 手动 / 关闭）、间隔、单次主机上限、并发、单端口超时、本机 / 网卡私网 / mDNS·SSDP 组播开关、手动范围与排除、是否允许公网范围、自动启用（默认关）、探测协议列表；最近运行历史。规则见 [DISCOVERY.md](DISCOVERY.md#自动发现auto-discovery)。
- **安全模式**：Safe / Full 热切换（二次确认）。
- 版本、数据目录、传输、token 是否配置；原始设置 JSON。

## 高级（侧栏折叠）

| Hash | 页 |
| --- | --- |
| `#/tools` `#/tools/:name` | 全部 tools（business / management / all）与试调用 |
| `#/discovery` | 单主机发现向导（Agent 同款 `discovery_scan_host`） |
| `#/import` | Schema 导入 |
| `#/matrix` | 协议矩阵 |
| `#/audit` | 审计时间线 |
| `#/plan` | 计划桥 |
| `#/security` | 安全平面（模块表、完整性、限流） |
| `#/hotload` | 环境盘点 + 热加载 / 热卸载（原 `#/capabilities`） |
| `#/partner` | 伙伴连接 |

旧 hash 自动跳转：`#/`、`#/adapters`、`#/capabilities` → 当前能力；`#/blacklist` → 黑名单 tab；`#/adapters/new` → 向导；`#/adapters/:id` → 向导编辑。

写操作：UI 二次确认 + 请求体 `confirm:true`，**仍然**受适配器 `allowWrite` / `assertCanWrite` 闸。默认 `allowWrite=false`；自动发现得到的候选一律 `allowWrite=false`。切到 Full **只**跳过平面模块 `allow-write`（以及 `dangerous-tools` challenge / `rate-limit` stub），**不会**把现有适配器改成可写，也**不会**跳过黑名单。

## REST

| 方法 | 路径 |
| --- | --- |
| GET | `/api/health` `/api/settings` `/api/matrix` |
| GET | `/api/overview`（摘要条计数：`current` / `supported` / `blacklist` / `discovery`） |
| GET | `/api/protocols`、`/api/protocols/:id`（每协议 `configSchema`） |
| POST | `/api/protocols/:id/validate` `{ config }` → `{ ok, missing, error }` |
| POST | `/api/adapters/test` `{ protocol, name?, config }`（临时连接 + listTools，不保存） |
| GET/POST | `/api/adapters` |
| GET/PUT/DELETE | `/api/adapters/:id`（PUT 中 `••••` 保留原密钥） |
| POST/PUT | `/api/adapters/:id/enabled` `{ enabled }`（停用 / 启用，保留注册） |
| POST | `/api/adapters/:id/ping` |
| GET | `/api/tools?layer=business\|management\|all`（audience=`console`，已拉黑业务 tools **仍列出** 并带 `blocked` / `blacklistId`） |
| GET | `/api/tools/:name` |
| POST | `/api/tools/:name/invoke` |
| GET/PUT | `/api/discovery/settings` |
| GET | `/api/discovery/status` `/api/discovery/runs` |
| GET | `/api/discovery/candidates?status=new\|all\|enabled\|dismissed` |
| POST | `/api/discovery/run` `{ wait? }`（`wait:false` → 202） |
| POST | `/api/discovery/candidates/:id/enable` `{ name?, config?, credentials? }` / `dismiss` / `restore` |
| POST | `/api/discovery/scan` `probe` `suggest` `register`（单主机向导） |
| GET | `/api/activity?limit=` |
| POST | `/api/import` |
| GET | `/api/audit` `/api/errors` |
| POST | `/api/plan` |
| GET/POST | `/api/blacklist`（POST 体带 `kind: target\|capability\|tool`） |
| GET/DELETE | `/api/blacklist/:id` |
| GET | `/api/security` `/api/security/mode` |
| PUT | `/api/security/mode`（`{ mode, confirm:true }`） |
| POST | `/api/environment/inventory` |
| POST | `/api/capabilities/register`（`confirm:true` 或 Safe+readonly `auto:true`） |
| POST | `/api/capabilities/unregister` `{ id, confirm:true }` |
| DELETE | `/api/capabilities/:id?confirm=true` |
| POST | `/api/capabilities/configure` `{ id, config }` |

视觉：底 `#0B0F14`、面板 `#121820`、强调 `#3DD6C6`；侧栏、顶栏胶囊、协议徽章、状态点、开关、右侧抽屉。

安全平面见 [SECURITY_ARCHITECTURE.md](SECURITY_ARCHITECTURE.md)。`GET /api/security` 带完整性快照（`security.json` / `blacklist.json` / `registrations.json`；可选 HMAC）与限流配额。`GET /api/audit` 读 `dataDir/audit.jsonl`（启动重载），token/password 会脱敏。

**Audience：** Agent `tools/list` / `mcp_list` 默认 audience=`agent`（隐藏已拉黑的能力与工具）。控制台 REST 入口写入 `actor.kind=console`，不靠查询串。Agent 传 `audience: "console"` 无效。
