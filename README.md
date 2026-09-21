# Everything2MCP

把异构协议（OpenAPI/HTTP、MQTT、SOAP、gRPC、消息队列、工业总线、RPC、邮件/目录等）动态注册成 **MCP tools**，让 AI Agent 通过稳定的 MCP 表面调用外部系统。

> Universal protocol→MCP bridge. Agents call heterogeneous systems through a hot-reloadable MCP tool registry.

## 为什么

每个系统都有自己的接口形态：REST、消息队列、SOAP……Agent 不想为每一种协议各接一套客户端。Everything2MCP 作为桥：

1. 用管理工具 `mcp_add` 注册一个端点
2. 适配器把该端点的操作映射成 MCP tools（`openapi.widgets.listWidgets`）
3. Agent 像调用普通 MCP tool 一样 `tools/call`

无需重启进程即可增删改（热注册）。

## 快速开始

```bash
npm install
npm run build
npm test
npm start          # stdio MCP server（默认；不要在终端里当 REPL 使用）
```

**最新启动（控制台 + MCP HTTP，过夜收口后仍是这一条）：** 先 `npm run build`，再

```bash
EVERYTHING2MCP_TRANSPORT=http EVERYTHING2MCP_HTTP_PORT=8742 npm start
# 控制台:         http://127.0.0.1:8742/ui/
# Streamable HTTP: http://127.0.0.1:8742/mcp
# SSE:             http://127.0.0.1:8742/sse  (POST /messages?sessionId=…)
# REST:            http://127.0.0.1:8742/api/health
# 探活（无 token）: http://127.0.0.1:8742/health
```

可选鉴权：设置 `EVERYTHING2MCP_HTTP_TOKEN`，客户端带 `Authorization: Bearer <token>` 或 `x-api-key`。`EVERYTHING2MCP_TRANSPORT=sse` 与 `http` 绑定同一监听器。

同进程控制台在 **`/ui/`**，REST 在 **`/api/*`**，复用 management tools。详见 [docs/CONSOLE.md](docs/CONSOLE.md) 与 [docs/RELEASE_NOTES.md](docs/RELEASE_NOTES.md)。顶栏可粘贴同一 HTTP token。W2：Discovery / Import / 只读试调用。W3：`#/audit`、`#/plan`。黑名单：`#/blacklist` + `GET/POST/DELETE /api/blacklist`（匹配规则见 [docs/BLACKLIST.md](docs/BLACKLIST.md)）。写操作需二次确认且仍受 `allowWrite`。没有 CIDR 扫描 UI。安全平面（Safe / Full Control，S1 已落地；`#/security`）见 [docs/SECURITY_ARCHITECTURE.md](docs/SECURITY_ARCHITECTURE.md)。

开发模式：

```bash
npm run dev
```

环境变量：

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `EVERYTHING2MCP_DATA_DIR` | `data` | 注册持久化目录（JSON） |
| `EVERYTHING2MCP_DISCOVERY_ENABLED` | `true` | 是否暴露 `discovery_probe` |
| `EVERYTHING2MCP_DISCOVERY_ALLOW_SCAN` | **忽略** | **死变量**。不能打开 CIDR；设置了会打日志并强制 `allowScan=false` |
| `EVERYTHING2MCP_DISCOVERY_TIMEOUT_MS` | `2500` | 单次探测超时 |
| `EVERYTHING2MCP_TRANSPORT` | `stdio` | `stdio`（默认）/ `http` / `sse` |
| `EVERYTHING2MCP_HTTP_HOST` | `127.0.0.1` | HTTP/SSE 绑定地址 |
| `EVERYTHING2MCP_HTTP_PORT` | `8742` | HTTP/SSE 端口（避免 3000/5173/8080） |
| `EVERYTHING2MCP_HTTP_PATH` | `/mcp` | Streamable HTTP 路径 |
| `EVERYTHING2MCP_SSE_PATH` | `/sse` | 遗留 SSE GET 路径 |
| `EVERYTHING2MCP_SSE_MESSAGES_PATH` | `/messages` | 遗留 SSE POST 路径 |
| `EVERYTHING2MCP_HTTP_TOKEN` | （空） | 可选共享密钥；空则不鉴权 |
| `EVERYTHING2MCP_HTTP_TOKEN_HEADER` | （空） | 额外 token header（仍接受 Authorization / x-api-key） |
| `EVERYTHING2MCP_INTEGRITY_KEY` | （空） | 可选 HMAC 密钥；也可放 `dataDir/.integrity-key`。空则只用 SHA-256 |
| `EVERYTHING2MCP_RATE_LIMIT_INVOKE` | `60` | Safe 下每分钟业务 invoke 上限；`0` = 不限。Full 跳过 |
| `EVERYTHING2MCP_RATE_LIMIT_DISCOVER` | `20` | Safe 下每分钟 discover 上限；`0` = 不限。Full 跳过 |

## 接入 Cursor / Claude Desktop

MCP 使用 **stdio**。在 Cursor 的 MCP 配置中加入（路径按本机修改）：

```json
{
  "mcpServers": {
    "everything2mcp": {
      "command": "node",
      "args": ["/absolute/path/to/Everything2MCP/dist/index.js"]
    }
  }
}
```

参考 `examples/cursor-mcp.json`。远程 / Streamable HTTP（需先 `EVERYTHING2MCP_TRANSPORT=http npm start`）：

```json
{
  "mcpServers": {
    "everything2mcp": {
      "url": "http://127.0.0.1:8742/mcp",
      "headers": { "Authorization": "Bearer replace-me" }
    }
  }
}
```

启动后，Agent 应能看到管理工具：`mcp_list`、`mcp_add`、`mcp_update`、`mcp_remove`、`mcp_query_by_protocol`、`mcp_health`、`mcp_explain_tool`、`mcp_plan_bridge`、`mcp_add_from_discovery`、`schema_import`、`discovery_suggest`，以及可选的 `discovery_probe` / `discovery_scan_host`。

## Agent 自主使用

目标：让 Agent **自己找协议、自己注册、自己调用**，而不是等人手写 `mcp_add`。

推荐顺序：

1. **`mcp_plan_bridge`** — 用自然语言描述目标（「把 10.0.0.8 上的 REST 和 MQTT 接进来」）。返回推荐协议、示例 config、下一步该调哪些 MCP 工具。
2. **`discovery_scan_host`** — 只扫 **一个** hostname/IP。并行探测 OpenAPI/WSDL/GraphQL、gRPC reflection、Redis/MQTT/NATS/Modbus/CoAP、JSON-RPC/XML-RPC、Pulsar **8080/6650**、GCS **4443**、Influx **8086**、OSS HTTP 头、以及 BACnet/IP **unicast Who-Is（UDP 47808，不广播）**。默认拒绝 CIDR/网段，并拦截云 metadata IP（SSRF）。
3. **`discovery_suggest`** 或直接用 scan 返回的 `suggestions`。
4. **`mcp_add_from_discovery`** — 把 suggestion 一键变成热注册 tools。
5. 若已有 spec 文件/URL：**`schema_import`**（OpenAPI / WSDL / proto / GraphQL SDL / AsyncAPI）。
6. **`mcp_health`** / **`mcp_explain_tool`** — 确认适配器是否 live、某个 `openapi.foo.bar` 怎么调。空注册表时 health 会给出 golden-path hints。

黄金路径有专用回归：`tests/p5-golden-path.test.ts`。

无 proto 的 gRPC：

```json
{ "protocol": "grpc", "name": "edge", "config": { "target": "127.0.0.1:50051", "reflection": true } }
```

AsyncAPI / Sparkplug 示例见 `examples/streetlights.asyncapi.json`、`examples/sparkplug-node.json`。

**不会做的事：** 默认扫描网段、扫 1–65535 全端口、探测云 metadata。详见 `docs/DISCOVERY.md`、`docs/ROADMAP.md`。

## 管理工具

| Tool | 参数 | 作用 |
| --- | --- | --- |
| `mcp_list` | `verbose?`, `layer?` | 按层列出：默认 `business`；`management` / `all` |
| `mcp_add` | `protocol`, `name`, `config` | 连接适配器并注册其 tools |
| `mcp_update` | `id`, `config` | 合并配置并重连 |
| `mcp_remove` | `id` | 断开并卸载 tools |
| `mcp_query_by_protocol` | `protocol` | 按协议过滤 |
| `mcp_health` | `verbose?` | 进程 + 适配器健康 |
| `mcp_explain_tool` | `name` | 解释某个 MCP tool 属于哪个适配器 |
| `mcp_plan_bridge` | `goal`, `host?` | 自然语言目标 → 推荐协议与下一步 |
| `mcp_add_from_discovery` | suggestion | 按探测草案注册 |
| `schema_import` | `source`, `kind?`, `register?` | 导入 spec 并可选注册 |
| `discovery_probe` | `host`, `port?` | 单端口 OpenAPI/SOAP/GraphQL 路径 |
| `discovery_scan_host` | `host`, `port?` | 单主机多协议并行探测 |
| `discovery_suggest` | `host` 或 `candidates` | 探测结果 → mcp_add 草案 |

注册 id 形如 `openapi:widgets`。业务 tools 命名：`{protocol}.{name}.{operationId}`。

`tools/list` 里每条 tool 带 `_meta.layer`：`management`（`mcp_*` / `discovery_*` / `schema_import`）或 `business`。Agent 应优先 `mcp_list { "layer": "business" }`，避免管理工具把上下文撑满。`annotations.title` 也有 `Management ·` / `Business ·` 前缀。

### 添加 OpenAPI 示例

对 MCP 客户端调用 `mcp_add`：

```json
{
  "protocol": "openapi",
  "name": "widgets",
  "config": {
    "spec": "./examples/petstore.openapi.json",
    "baseUrl": "https://your-api.example/v1",
    "auth": { "type": "bearer", "token": "replace-me" }
  }
}
```

成功后会出现 `openapi.widgets.listWidgets`、`openapi.widgets.getWidget` 等 tools。完整配置见 `examples/`。

### MQTT

```json
{
  "protocol": "mqtt",
  "name": "local",
  "config": {
    "url": "mqtt://127.0.0.1:1883",
    "topics": ["sensors/#"]
  }
}
```

暴露 `mqtt.local.publish`、`mqtt.local.subscribe_once`、`mqtt.local.list_topics`。

### SOAP / WSDL

```json
{
  "protocol": "soap",
  "name": "calculator",
  "config": {
    "wsdl": "./examples/calculator.wsdl",
    "endpoint": "http://127.0.0.1:8080/calculator"
  }
}
```

**限制（刻意保持薄实现）：** 按 WSDL 列出 operation，调用时把参数包进 SOAP 1.1 envelope 做 HTTP POST。不解析复杂 XML Schema、WS-Security、MTOM。详见 `docs/PROTOCOLS.md`。

### gRPC

```json
{
  "protocol": "grpc",
  "name": "greeter",
  "config": {
    "proto": "./examples/greeter.proto",
    "target": "127.0.0.1:50051",
    "tls": false
  }
}
```

暴露 unary / server-stream / client-stream / **one-shot bidi** 以及 **session bidi**（`bidi_open` / `bidi_send` / `bidi_recv` / `bidi_close`）。unary invoke：`{ "body": { "name": "Ada" } }`。one-shot bidi：`{ "messages": [{ "name": "Ada" }], "maxMessages": 8 }`。session：`bidi_open { "method": "Greeter_Chat" }` 后按 `streamId` send/recv/close；未读满 `maxMessages` 会 pause。只读动词 RPC 默认放行；`Chat`/`SayHello` 等写侧需 `allowWrite: true`。可选 `ca`/`cert`/`key` PEM。也可用 `protoInline`。

### WebSocket

```json
{
  "protocol": "websocket",
  "name": "echo",
  "config": {
    "url": "ws://127.0.0.1:8080/echo",
    "protocols": [],
    "headers": {}
  }
}
```

别名 `ws`。暴露 `websocket.echo.send`、`websocket.echo.receive_once`。无自动重连。

### GraphQL

```json
{
  "protocol": "graphql",
  "name": "api",
  "config": { "url": "http://127.0.0.1:4000/graphql", "introspect": true }
}
```

`graphql.api.query` / `mutate` / `introspect` / `subscribe_once`。Introspection 成功时还有 `Query_*`、`Mutation_*`。`subscribe_once` 需 `wsUrl`（graphql-ws）或 `simulator:true`。

### AMQP / Kafka

```json
{ "protocol": "amqp", "name": "rabbit", "config": { "url": "amqp://127.0.0.1", "queue": "jobs" } }
```

```json
{ "protocol": "kafka", "name": "events", "config": { "brokers": ["127.0.0.1:9092"], "topic": "orders" } }
```

AMQP：`publish`、`consume_once`、`list_queues`。Kafka：`produce`、`consume_once`、`list_topics`、`group_status`（one-shot；**无事务/EOS**；`idempotent` 只是 KafkaJS producer 标志）。

### 薄适配器（工业 / 消息 / 数据）

| protocol | 配置要点 | tools | 限制 |
| --- | --- | --- | --- |
| `opcua` | `endpoint`, `nodes`, `simulator?` | `read` `write` `browse` `subscribe_once` `wait_data_change` | 默认内存地址空间；`subscribe_once` 一次性；`wait_data_change` 为内存 monitored-item |
| `coap` | `host`, `port` | CRUD + `observe_once`/`observe_cancel` | 无 DTLS |
| `nats` | `servers` / `simulator?` | core + `js_publish`/`js_next`/`js_ack` | JetStream consumer/ack/interest 子集 |
| `fix` | `sender`, `target`, `allowWrite?` | logon/heartbeat/logout + encode/decode/status + NOS | 会话 logon/logout/NOS 需 allowWrite；内存 loopback |
| `asyncapi` | `spec`, `brokerUrl?` | `list_channels` `publish` `subscribe_once` | MQTT/WS/Kafka bind 或 dry-run |
| `sparkplug` | `url`, `groupId`, `edgeNode`, `hostId?`, `encoding?` | encode/decode/parse + nbirth/ndeath/publish + **`host_state`** | 官方 protobuf；Host STATE 只读 stub |
| `sqs` | `queue`, `endpoint?`, `allowWrite?` | `list_queues` `send` `receive` `delete` | 内存 / unsigned JSON HTTP；无 SigV4；写入需 allowWrite |
| `ldap` | `url`, `base`, `tls?`, `allowWrite?` | bind/search/compare + **add/modify/delete** | 写入需 allowWrite；无 SASL |
| `bacnet` | `host`, `port?`, `udp?`, `allowWrite?` | `who_is` `i_am` `read_property` `list_objects` `write_property` | unicast Who-Is；写入需 allowWrite |
| `ethernetip` / `enip` | `host?`, `tcp?`, `allowWrite?` | `list_identities` `list_tags` `read_tag` `write_tag` | CIP List Identity；本地 tags；无 Forward Open |
| `s7` | `host?`, `rack?`, `slot?`, `tcp?`, `allowWrite?` | `read` `list_areas` `write` | ISO-TCP + Read Var 子集；默认只读 |
| `mtconnect` | `url` / `fixture` / `xml` | `probe` `current` `sample` | HTTP Agent 拉；无 Assets |
| `sql` / `sqlite` / `postgres` / `mysql` | `driver`+`filename`/`url`，`native?` | `query` `execute` `list_tables` `describe` | CI mock / `node:sqlite`；`native:true` 可选 `pg`/`mysql2`/`better-sqlite3` |
| `mongodb` `elasticsearch` `clickhouse` `neo4j` `qdrant` | `simulator:true` 或 url | 见 PROTOCOLS | Mongo OP_MSG；ES HTTP `_search`；Neo4j HTTP tx；CH HTTP |
| `sftp` | `host`, `user?`, `password?` | `list` `get` `put` `delete` | **ssh2 SSH-2**；不是 FTP；写需 allowWrite |
| `memcached` | `host?`, `port?` | `get` `set` `delete` `stats` | 文本协议；写需 allowWrite |
| `tftp` | `host?`, `port?` | `get` `put` | RFC1350 RRQ/WRQ；不是 FTP |
| `caldav` | `url?` | `propfind` `report` `freebusy` `get` `put` | time-range + freebusy；iTIP `E_UNSUPPORTED`；写需 allowWrite |
| `carddav` | `url?` | `propfind` `report` `get` `put` | addressbook-query 子集；写需 allowWrite |
| `beanstalkd` | `host?`, `port?` | `stats` `put` `reserve` `delete` | 文本协议；写需 allowWrite |
| `zookeeper` | `host?`, `port?` | `ruok` `get` `create` `watch_once` `multi` | 一次性 watch + MULTI；ACL/SASL `E_UNSUPPORTED` |
| `redis` | `url`, `allowWrite?` | kv + hash/list/stream + pub/sub | 写入需 allowWrite |
| `s3` | `bucket` | `list` `get` `put` | 内存 / unsigned HTTP |
| `dns` | `host?` / `simulator?` | `query` | 单播 A/AAAA/TXT/PTR；无 AXFR / 无组播 |
| `cassandra` | `host?` / `simulator?` | `list_keyspaces` `cql` | native v4 STARTUP/QUERY；写闸 |
| `couchdb` | `url?` / `simulator?` | `all_docs` `get` `put` | HTTP；写需 allowWrite |
| `whois` | `host?` / `simulator?` | `query` | TCP 43 只读 |
| `solr` | `url?` / `simulator?` | `list_cores` `select` `update` | HTTP；写需 allowWrite |
| `rabbitmq` | `url?` / `simulator?` | `list_queues` `publish` `get` | management HTTP；不是 AMQP |
| `kubernetes` / `k8s` | `url?` / `simulator?` | list/get pods/services/configmaps | 只读；exec/apply E_UNSUPPORTED |
| `prometheus` | `url` / `simulator?` | `query` `query_range` `remote_write` | protobuf+snappy 写需 allowWrite；内存 query 按名 |
| `influx` / `influxdb` | `bucket`, `url?` | `write_points` `delete_points` `query` | Flux + `/api/v2/delete`；写/删需 allowWrite |

### 新增协议（XML-RPC / JSON-RPC / FIX / Redis / SMTP / LDAP）

```json
{ "protocol": "xmlrpc", "name": "blog", "config": { "url": "http://127.0.0.1:8080/RPC2", "introspect": true } }
```

```json
{ "protocol": "jsonrpc", "name": "api", "config": { "url": "http://127.0.0.1:8545" } }
```

```json
{ "protocol": "fix", "name": "desk", "config": { "sender": "BUY", "target": "EXCH" } }
```

```json
{ "protocol": "redis", "name": "cache", "config": { "url": "redis://127.0.0.1:6379" } }
```

```json
{ "protocol": "smtp", "name": "mail", "config": { "host": "127.0.0.1", "port": 587, "from": "bot@example.com", "starttls": true } }
```

```json
{ "protocol": "ldap", "name": "dir", "config": { "url": "ldap://127.0.0.1:389", "base": "dc=example,dc=com" } }
```

- **XML-RPC**：`list_methods` / `call`，可 introspect 成 `rpc_*`
- **JSON-RPC 2.0**：`call` / `notify` / `batch`（HTTP，可选 WebSocket）
- **FIX**：内存 transport 上 logon/heartbeat/logout + seq（不是交易所）。**logon/logout/NOS 当写**；encode/decode/session_status 只读
- **Redis**：GET/SET/DEL/KEYS/PUBLISH/SUBSCRIBE_ONCE
- **SMTP**：`send_mail`（需 allowWrite）+ `noop`；`raw:true` EHLO/MAIL/DATA；STARTTLS 未广告 → `E_UNSUPPORTED`；不是 IMAP/POP3
- **LDAP**：bind / search / compare；`add`/`modify`/`delete` 需 `allowWrite`；`tls` / `starttls`；属性过滤
- **数据面**：优先 `sqlite` / `postgres` / `mysql` / `mongodb` / `qdrant` 等具体 id（见 `docs/PROTOCOLS.md` 与 `examples/*-local.json`）。泛化 `sql` 只是 driver 门面。

完整合同见 `docs/PROTOCOLS.md`。示例配置见 `examples/`。

## 认证占位

`config.auth`：

```json
{ "type": "none" }
{ "type": "bearer", "token": "..." }
{ "type": "apiKey", "apiKey": "...", "headerName": "X-API-Key" }
{ "type": "basic", "username": "...", "password": "..." }
```

MVP 不包含 OAuth、密钥托管或多租户。

## 发现

`discovery_scan_host` 只探测**单个 host**。网段 / CIDR / 通配符默认直接拒绝，并拦截 metadata IP。设计见 `docs/DISCOVERY.md`。

## 仓库结构

```
src/transport/     stdio（默认）+ Streamable HTTP `/mcp` + SSE `/sse`；无业务逻辑
src/control/       mcp_* 管理工具与 policy
src/catalog/       热注册表、JSON 持久化、校验、list_changed
src/discovery/     单主机探测；suggest/import 入口
src/runtime/       内核：types/errors/auth/load/log/invoke
src/adapters/      SPI + 扁平协议实现 + 可选 pack 分组
examples/          配置与 OpenAPI/WSDL/proto 夹具
tests/             注册表 + 各适配器 + MCP 语义
docs/              架构 / ADR / 协议目录 / 发现
```

依赖：`transport → control → catalog`；`control → discovery`；适配器经 `runtime/bootstrap` 注册；**adapters 不得 import control/transport**。详见 `docs/ARCHITECTURE.md`。

## 文档

- [架构](docs/ARCHITECTURE.md)
- [ADR 0001 五包布局](docs/adr/0001-five-package-layout.md)
- [ADR 0002 Audience 绑定 actor](docs/adr/0002-actor-bound-audience.md)
- [Phase M 审查纪要](docs/PHASE_M_REVIEW.md)
- [协议目录与优先级](docs/PROTOCOLS.md)
- [发现](docs/DISCOVERY.md)
- [Roadmap P0–P6（执行顺序）](docs/ROADMAP.md)
- [Web 控制台](docs/CONSOLE.md)
- [体检与测试覆盖](docs/AUDIT.md)
- [统一错误码](docs/ERRORS.md)
- [TLS / 证书 reconnect 重载](docs/TLS.md)

## 开发脚本

| 脚本 | 作用 |
| --- | --- |
| `npm run build` | `tsc` → `dist/`，并 `ui:build` 到 `dist/ui` |
| `npm run ui:build` | 控制台 SPA → `dist/ui` |
| `npm start` | 运行 MCP server（默认 stdio；见 `EVERYTHING2MCP_TRANSPORT`） |
| `npm test` | `tsx --test` |
| `npm run dev` | `tsx watch` |

## English

Everything2MCP is an MCP server. **stdio is the default.** Set `EVERYTHING2MCP_TRANSPORT=http` (or `sse`) to serve Streamable HTTP at `/mcp`, legacy SSE at `/sse`, and the same-process console at `/ui/` (REST under `/api/*`) on port `8742`. Optional `EVERYTHING2MCP_HTTP_TOKEN` requires `Authorization: Bearer` or `x-api-key`. Agents should prefer `mcp_plan_bridge`, `discovery_scan_host`, `mcp_add_from_discovery`, and `schema_import`. Discovery never scans network ranges or metadata IPs by default. Unified error codes: `docs/ERRORS.md`.

```bash
npm install && npm run build && npm test && npm start
EVERYTHING2MCP_TRANSPORT=http EVERYTHING2MCP_HTTP_PORT=8742 npm start
```
