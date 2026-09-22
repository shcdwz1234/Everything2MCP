# 黑名单

操作员可以把不想再看见、也不想再注册的目标记进黑名单。条目持久化在 **`dataDir/blacklist.json`**，与 `registrations.json` 同级，不是嵌在注册表里。

默认行为：**阻止新建与发现一键添加**；已经挂上的适配器实例**不会卸载**，但 `invoke` 也会被拒绝（更安全）。解除拉黑后可以再注册、再调用。

**Full 模式仍执行黑名单**（`builtin-blacklist.bypassInFullControl=false`）。`capability_register` / `mcp_add` / 发现一键注册走同一匹配。Agent `tools/list` / 默认 `mcp_list` 看不到已拉黑业务 tools；控制台可见。Agent 不能靠 `audience=console` 升级（[ADR 0002](adr/0002-actor-bound-audience.md)）。

没有 CIDR / 网段扫描。黑名单按**单个** `protocol + host + port`（或规范化 url）精确匹配。

## 匹配规则

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

控制台 Discovery 结果行可以「加入黑名单」；已拉黑行标记且没有一键注册按钮。`#/blacklist` 列表 + 解除拉黑。

## API

| 方法 | 路径 | 对应管理工具 |
| --- | --- | --- |
| GET | `/api/blacklist` | `mcp_blacklist_list` |
| POST | `/api/blacklist` | `mcp_blacklist_add` |
| GET | `/api/blacklist/:id` | 从 list 中取一条 |
| DELETE | `/api/blacklist/:id` | `mcp_blacklist_remove` |

`POST` 体：`{ protocol, host?, port?, url?, reason? }`。至少要有 `protocol` + (`host`+`port` 或可解析的网络 `url`)。`id` 含 `|`，URL 里请 `encodeURIComponent`。

## MCP

- `mcp_blacklist_list` — 列出全部条目
- `mcp_blacklist_add` — `{ protocol, host?, port?, url?, reason? }`
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
