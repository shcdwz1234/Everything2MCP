# 黑名单

操作员可以把不想再看见、也不想再注册的目标记进黑名单。条目持久化在 **`dataDir/blacklist.json`**，与 `registrations.json` 同级，不是嵌在注册表里。

默认行为：**阻止新建与发现一键添加**；已经挂上的适配器实例**不会卸载**，但 `invoke` 也会被拒绝（更安全）。解除拉黑后可以再注册、再调用。

**Full 模式仍执行黑名单**（`builtin-blacklist.bypassInFullControl=false`）。`capability_register` / `mcp_add` / 发现一键注册走同一匹配。Agent `tools/list` / 默认 `mcp_list` 看不到已拉黑业务 tools；控制台可见。Agent 不能靠 `audience=console` 升级（[ADR 0002](adr/0002-actor-bound-audience.md)）。

## 三种粒度

| kind | id | 匹配 | 效果 |
| --- | --- | --- | --- |
| `target`（默认，兼容旧版） | `{protocol}\|{host}\|{port}` 或 `{protocol}\|url:{url}` | 下文「匹配规则」 | 挡新建 / 更新 / 发现注册；已挂实例的 invoke 被拒；自动发现候选不再出现 |
| `capability` | `cap\|{adapterId}` | 注册 id 完全相等（如 `sqlite:scratch`） | 该实例的 tools 从 Agent 列表消失、invoke 被拒；同 id 再注册被拒。可以挡住没有网络目标的实例（SQLite 文件 / 内存库等） |
| `tool` | `tool\|{pattern}` | 工具名精确匹配或 glob：`*` 匹配**一段**（以 `.` 分隔），`**` 匹配任意多段 | 命中的 tools 从 Agent 列表消失、invoke 被拒；不影响注册与同实例其它 tools。例：`redis.*.flushall`、`sqlite.demo.execute`、`s3.prod.**` |

单独的 `*` / `**` 会被拒绝（那等于把所有工具拉黑）。控制台里：**能力 → 当前能力** 行上的「加入黑名单」= capability；tools 抽屉里的「屏蔽」= tool；**可支持能力** 候选上的「加入黑名单」= target。**能力 → 黑名单** tab 列出全部条目，一键解除。

## 匹配规则（target）

1. **protocol** 走 `canonicalProtocol`（`pg` → `postgres`，`enip` → `ethernetip`，`http` → `openapi`，…）。
2. **host** 小写；去掉 IPv6 方括号与尾随点。
3. **port** 是数字。来源依次是：显式 `port`、URL 端口、`brokers[0]`、协议默认端口（MQTT 1883、Redis 6379、Solr **8983**、RabbitMQ management **15672**、Kubernetes **6443**、Docker/Podman **2375**、SMB **445**、NFS **2049**、Vault/OpenBao **8200**、Alertmanager **9093**、Pub/Sub emulator **8085**、Jira **8080**、OpenSearch **9200**、Cassandra 9042、Whois 43、…；见 `src/catalog/blacklist.ts` `DEFAULT_PORT`）。Neo4j 默认端口在代码里是 **7687**（Bolt 惯例）；HTTP 适配器常用 **7474**，拉黑 HTTP 目标请写显式 port 或 url。
4. 能抽出 `host` + `port` 时，匹配键是：

   ```
   {canonicalProtocol}|{normalizedHost}|{port}
   ```

   例如 `mqtt|10.0.0.8|1883`、`openapi|127.0.0.1|8080`。
5. 抽不出 host:port 时，退回：

   ```
   {canonicalProtocol}|url:{normalizedUrl}
   ```

   规范化 url 保留 scheme + host + port，去掉尾随 `/`。
6. 命中条件是 **id 完全相等**。不同协议的同一 host:port 互不影响（`mqtt|h|1883` 不会挡住 `redis|h|6379`）。
7. 本地文件路径、`:memory:`、`memory:` 不会被解析成网络目标，因此 **SQLite 内存库 / 纯文件 spec 无法靠 host 拉黑**。要对 OpenAPI 拉黑，用 `baseUrl` / `spec` 里的网络 URL。

从适配器 `config` 抽目标时读取这些键：`url` `endpoint` `serviceUrl` `brokerUrl` `baseUrl` `adminUrl` `wsdl` `spec`，然后 `target`、`brokers[0]`、最后 `host`+`port`。

## 挡住什么

| 入口 | 行为 |
| --- | --- |
| `mcp_add` / `mcp_update` / POST `/api/adapters` | 匹配则 `E_BLACKLISTED`（HTTP 403） |
| `capability_register` / POST `/api/capabilities/register` | 同上（走同一 `add()` + Policy Gateway；`auto:true` 也不能绕过） |
| `mcp_add_from_discovery` / POST `/api/discovery/register` | 同上（走同一 `add`） |
| `schema_import` 并注册 | 同上 |
| `discovery_scan_host` / `discovery_probe` / `discovery_suggest` | 候选带 `blacklisted` + `blacklistId`；**suggestions 省略**它们；`blocked` / `hiddenBlacklisted` 列出被过滤条数 |
| 已挂载适配器 `invoke` | 匹配则 `E_BLACKLISTED`，不打后端 |
| `mcp_remove` | 不受影响（可以删掉已挂实例）。`capability_unregister` 同一路径；黑名单仍拦再注册 |

| Agent `tools/list` / `mcp_list`（audience=agent） | capability / tool 条目命中的 tools 被隐藏 |
| 控制台 `GET /api/tools`（audience=console） | 仍列出，带 `blocked: true` + `blacklistId`，便于解除 |

控制台发现结果与自动发现候选可以「加入黑名单」；已拉黑行标记且没有一键注册按钮。旧 hash `#/blacklist` 跳到 **能力 → 黑名单** tab。

## API

| 方法 | 路径 | 对应管理工具 |
| --- | --- | --- |
| GET | `/api/blacklist` | `mcp_blacklist_list` |
| POST | `/api/blacklist` | `mcp_blacklist_add` |
| GET | `/api/blacklist/:id` | 从 list 中取一条 |
| DELETE | `/api/blacklist/:id` | `mcp_blacklist_remove` |

`POST` 体：

- target：`{ kind?: "target", protocol, host?, port?, url?, reason? }`，至少要有 `protocol` + (`host`+`port` 或可解析的网络 `url`)；
- capability：`{ kind: "capability", adapterId, reason? }`；
- tool：`{ kind: "tool", pattern, reason? }`。

`id` 含 `|`，URL 里请 `encodeURIComponent`。`GET /api/blacklist` 同时返回按 kind 的计数。

## MCP

- `mcp_blacklist_list` — 列出全部条目与 `counts`
- `mcp_blacklist_add` — `{ kind?, protocol?, host?, port?, url?, adapterId?, pattern?, reason? }`（按 kind 取字段，见上）
- `mcp_blacklist_remove` — `{ id }`

`mcp_blacklist_add` / `mcp_blacklist_remove` 记在 mutating 管理层（和 `mcp_add` 一样），不是数据面写。

## 文件格式

```json
{
  "version": 1,
  "entries": [
    {
      "id": "mqtt|10.0.0.8|1883",
      "protocol": "mqtt",
      "host": "10.0.0.8",
      "port": 1883,
      "reason": "console discovery",
      "createdAt": "2026-09-21T20:00:00.000Z"
    }
  ]
}
```

全部条目都是 `target` 时仍写 `version: 1`（与旧版本完全兼容）。出现 capability / tool 条目后写 `version: 2`，条目多出 `kind` 与 `adapterId` / `pattern`：

```json
{
  "version": 2,
  "entries": [
    { "id": "tool|sqlite.demo.execute", "kind": "tool", "pattern": "sqlite.demo.execute", "protocol": "sqlite", "host": "", "port": 0, "reason": "console", "createdAt": "2026-09-27T13:18:20.070Z" },
    { "id": "cap|sqlite:scratch", "kind": "capability", "adapterId": "sqlite:scratch", "protocol": "sqlite", "host": "", "port": 0, "reason": "console", "createdAt": "2026-09-27T13:18:23.740Z" }
  ]
}
```

读取时 v1 / v2 都接受；v1 条目（无 `kind`）一律按 `target` 处理。
