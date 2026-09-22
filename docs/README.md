# Everything2MCP

把异构协议（OpenAPI/HTTP、MQTT、SOAP、gRPC、消息队列、工业总线、RPC、邮件/目录、对象存储、检索/编排等）动态注册成 **MCP tools**，让 AI Agent 通过稳定的 MCP 表面调用外部系统。

> Universal protocol→MCP bridge. Discover, register, and invoke heterogeneous endpoints as hot-reloadable MCP tools.

**当前快照（Phase X / Partner + Compat）：** 部署 = **最小 MCP 核心**。北向 Agent 只走 MCP；南向默认 **不是 MCP**（Partner 协议 → native OpenAPI 适配器 → `mcp_bridge` 兜底）。能力增长与收缩走共享 **热加载 / 热卸载** 管道。逻辑平面仍是五包。测试：`npm test`。

## 为什么

每个系统都有自己的接口形态：REST、消息队列、SOAP……Agent 不想为每一种协议各接一套客户端。Everything2MCP 作为桥：

1. 用管理工具 `mcp_add` 注册一个端点
2. 适配器把该端点的操作映射成 MCP tools（`openapi.widgets.listWidgets`）
3. Agent 像调用普通 MCP tool 一样 `tools/call`

无需重启进程即可增删改（热注册）。

## 快速开始

在已同步的树里（例如 Windows `D:\Everything2MCP`）：

```bash
cd D:\Everything2MCP          # 或本机实际路径
npm install
npm run build
`npm test`                      # 全绿
```

Node **≥ 18.18**。默认 **stdio MCP**（给 Cursor / Claude Desktop；不要当终端 REPL 用）：

```bash
npm start
```

**控制台 + Streamable HTTP + 遗留 SSE**（看 UI 用这条）：先 `npm run build`，再

```bash
EVERYTHING2MCP_TRANSPORT=http EVERYTHING2MCP_HTTP_PORT=8742 npm start
# 控制台:         http://127.0.0.1:8742/ui/
# Streamable HTTP: http://127.0.0.1:8742/mcp
# SSE:             http://127.0.0.1:8742/sse  (POST /messages?sessionId=…)
# REST:            http://127.0.0.1:8742/api/health
# 探活（无 token）: http://127.0.0.1:8742/health
```

可选鉴权：设置 `EVERYTHING2MCP_HTTP_TOKEN`，客户端带 `Authorization: Bearer <token>` 或 `x-api-key`。`EVERYTHING2MCP_TRANSPORT=sse` 与 `http` 绑定同一监听器。

同进程控制台在 **`/ui/`**，REST 在 **`/api/*`**，复用 management tools。详见 [docs/CONSOLE.md](docs/CONSOLE.md)。顶栏可粘贴同一 HTTP token。页面：Dashboard / Adapters / Tools / Discovery / **`#/capabilities` 热加载** / **`#/partner` 伙伴** / Import / `#/audit` / `#/plan` / `#/blacklist` / `#/security` / 协议矩阵 / Settings。写操作需二次确认且仍受 `allowWrite`。**没有 CIDR 扫描 UI。** 南向 ingress 徽章：`partner` / `native` / `mcp_bridge`（兜底）。

开发模式：`npm run dev`（`tsx watch`，仍默认 stdio）。

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

## 架构（单进程五包）

```
transport  →  control  →  catalog
control    →  discovery
catalog    →  runtime/bootstrap  →  adapters
```

| 包 | 职责 |
| --- | --- |
| Transport | stdio（默认）+ Streamable HTTP `/mcp` + SSE `/sse` + 同进程 `/ui` `/api`；无业务逻辑 |
| Control Plane | `mcp_*` 管理工具、政策网关（Safe/Full）、黑名单、REST |
| Catalog / Registry | 热注册表、`data/registrations.json`、校验、`list_changed` |
| Discovery & Import | 单主机探测、`discovery_suggest`、`schema_import` |
| Adapter Runtime | SPI + 扁平 `src/adapters/<protocol>/`；v1 **只有 builtins** |

硬约束：adapters 不得 import control/transport；无 `src/core` / `src/management` shim。**逻辑平面**（Environment / Platform / Capability Lifecycle / Policy）叠在五包上，不是新目录。详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 热加载 / 热卸载（Phase V 引入，Phase W 补齐热卸载）

Boot **不会**把 os_info / docker / 本机盘点结果写进 catalog。增长与收缩走**同一条** Policy Gateway 管道：

1. 控制台 `#/capabilities`：环境盘点或手动 config → 建议列表 → **确认**热加载（Safe+只读可勾 auto）。已挂能力可 **热卸载**（二次确认；不要求 `allowWrite`）。
2. Agent：`environment_inventory` → `capability_register`（`auto:true` 仅 Safe + `allowWrite`/`allowShell`/`allowDesktop`/`allowReadSecrets` 非 true + 非黑名单）
3. Agent / 控制台：`capability_unregister` `{ id }`（与 `mcp_remove` 同一 Catalog.remove；黑名单不拦卸载，但拦再注册）

`capability_register` / `mcp_add` / `mcp_add_from_discovery` / POST `/api/adapters` 走同一 `add()`。`capability_unregister` / `mcp_remove` / POST `/api/capabilities/unregister`（`confirm:true`）/ DELETE `/api/capabilities/:id?confirm=true` 走同一 `remove()`。卸载后 tools 立刻从 Catalog 与 MCP `tools/list` 消失，无需重启。建议列表 **从不**批量自动注册。

新管理工具：`environment_inventory`、`capability_register`、`capability_unregister`、`capability_configure`、**`partner_list`**、**`compat_scan`**。

## Partner / Compat（Phase X）

北向 = MCP only。南向优先级见 [docs/PARTNER.md](docs/PARTNER.md) 与 [docs/COMPAT.md](docs/COMPAT.md)：

1. Partner 协议（应用不写 MCP）。清单 + HTTP invoke。Demo：`examples/partner-demo-chat/`（零 MCP 代码）。
2. Native 适配器：`feishu` / `dingtalk` / `wecom` / `slack` / `notion` / `github`（模拟器 + `allowWrite` 闸）。
3. `mcp_bridge` 兜底导入本地 `mcpServers` JSON（live spawn = `E_UNSUPPORTED`）。

Drops：`~/.everything2mcp/drops/*.json`（Windows `%LOCALAPPDATA%\everything2mcp\drops`）。扫描成功 ≠ 打开写/桌面/密钥。个人微信私聊 **不**宣称 Partner 兼容。

## 安全（已锁定，不再重开）

- **默认 Safe**。数据面默认 `allowWrite=false`。**Full ≠ 全局可写**（适配器 `assertCanWrite` 仍闸）。
- **黑名单 ALWAYS on**，包括 Full（`bypassInFullControl=false`）。
- **无 CIDR UI**；`EVERYTHING2MCP_DISCOVERY_ALLOW_SCAN` 死变量；transport 合同不变；无 shim。
- **Actor-bound audience（Phase M）：** Agent 不能伪造 `audience=console` 看见已拉黑 tools。控制台 REST 写入 `actor.kind=console`。
- 政策网关、HMAC 完整性（`security.json` / `blacklist.json` / `registrations.json`）、`audit.jsonl`、限流、密钥脱敏。
- Plugin SPI：v1 **只加载 builtins**；`inject`/`replace` 钩子留给日后；非 builtin → `E_UNSUPPORTED`。**不做** v2 本地 JS / v3 npm、**不做** Agent 写 challenge。

详见 [docs/SECURITY_ARCHITECTURE.md](docs/SECURITY_ARCHITECTURE.md)、[docs/BLACKLIST.md](docs/BLACKLIST.md)。

## 接入 Cursor / Claude Desktop

MCP 使用 **stdio**。路径按本机修改（同步树在 `D:\Everything2MCP` 时用绝对路径）：

```json
{
  "mcpServers": {
    "everything2mcp": {
      "command": "node",
      "args": ["D:\\Everything2MCP\\dist\\index.js"]
    }
  }
}
```

相对路径示例见 `examples/cursor-mcp.json`（需在仓库根、且已 `npm run build`）。远程 / Streamable HTTP（需先 `EVERYTHING2MCP_TRANSPORT=http npm start`）：

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

启动后，Agent 应能看到管理工具：`mcp_list`、`mcp_add`、`mcp_update`、`mcp_remove`、`mcp_query_by_protocol`、`mcp_health`、`mcp_explain_tool`、`mcp_plan_bridge`、`mcp_add_from_discovery`、`schema_import`、`discovery_suggest`、`environment_inventory`、`capability_register` / `capability_unregister` / `capability_configure`、`partner_list`、`compat_scan`，以及可选的 `discovery_probe` / `discovery_scan_host`。黑名单管理工具 `mcp_blacklist_*` 给操作员用，默认不要当业务层。

## Agent 自主使用

目标：让 Agent **自己找协议、自己注册、自己调用**，而不是等人手写 `mcp_add`。

推荐顺序：

1. **`mcp_plan_bridge`** — 用自然语言描述目标（「把 10.0.0.8 上的 REST 和 MQTT 接进来」）。返回推荐协议、示例 config、下一步该调哪些 MCP 工具。
2. **`discovery_scan_host`** — 只扫 **一个** hostname/IP。并行探测 OpenAPI/WSDL/GraphQL、gRPC reflection、常见消息/工业/数据端口，以及 Phase N–U 指纹（FTP/SNMP/etcd/WebDAV、IMAP/POP3/Consul、SFTP/Memcached/TFTP、CalDAV/ZK、Cassandra/CouchDB/Whois、Solr **8983** / RabbitMQ management **15672** / Kubernetes **6443** 等）。完整表见 [docs/DISCOVERY.md](docs/DISCOVERY.md)。默认拒绝 CIDR/网段，并拦截云 metadata IP（SSRF）。
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

**不会做的事：** 默认扫描网段、扫 1–65535 全端口、探测云 metadata、mDNS 组播浏览、NFS。详见 `docs/DISCOVERY.md`、`docs/ROADMAP.md`。

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
| `environment_inventory` | （无） | 本机盘点 → suggest（不注册） |
| `capability_register` | suggestion 或 protocol/name/config，`auto?` `confirm?` | 热加载（与 mcp_add 同一闸） |
| `capability_unregister` | `id` | 热卸载（控制面，不要求 allowWrite；缺 id → `E_NOT_FOUND`） |
| `capability_configure` | `id`, `config` | 热重配 |

注册 id 形如 `openapi:widgets`。业务 tools 命名：`{protocol}.{name}.{operationId}`。

`tools/list` 里每条 tool 带 `_meta.layer`：`management`（`mcp_*` / `discovery_*` / `environment_inventory` / `capability_*` / `schema_import`）或 `business`。Agent 应优先 `mcp_list { "layer": "business" }`，避免管理工具把上下文撑满。`annotations.title` 也有 `Management ·` / `Business ·` 前缀。

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

### AMQP / Kafka / RabbitMQ management

```json
{ "protocol": "amqp", "name": "rabbit", "config": { "url": "amqp://127.0.0.1", "queue": "jobs" } }
```

```json
{ "protocol": "kafka", "name": "events", "config": { "brokers": ["127.0.0.1:9092"], "topic": "orders" } }
```

```json
{ "protocol": "rabbitmq", "name": "mgmt", "config": { "url": "http://127.0.0.1:15672", "allowWrite": false } }
```

AMQP：`publish`、`consume_once` / `get` / `ack`、`list_queues`（线协议 **5672**）。Kafka：`produce`、`consume_once`、`list_topics`、`group_status`（one-shot；**无事务/EOS**；`idempotent` 只是 KafkaJS producer 标志）。`rabbitmq` 是 **management HTTP :15672**，不是 AMQP。

### 薄适配器（工业 / 消息 / 数据 / 平台）

状态分 **Implemented**（真客户端路径）与 **Thin**（模拟器 / 子集）。完整合同与限制见 [docs/PROTOCOLS.md](docs/PROTOCOLS.md)。

| protocol | 配置要点 | tools | 限制 |
| --- | --- | --- | --- |
| `opcua` | `endpoint`, `nodes`, `simulator?` | `read` `write` `browse` `subscribe_once` `wait_data_change` | 默认内存地址空间；`subscribe_once` 一次性；`wait_data_change` 为内存 monitored-item |
| `coap` | `host`, `port` | CRUD + `observe_once`/`observe_cancel` | 无 DTLS |
| `nats` | `servers` / `simulator?` | core + `js_publish`/`js_next`/`js_ack` | JetStream consumer/ack/interest 子集 |
| `fix` | `sender`, `target`, `allowWrite?` | logon/heartbeat/logout + encode/decode/status + NOS | 会话 logon/logout/NOS 需 allowWrite；内存 loopback |
| `asyncapi` | `spec`, `brokerUrl?` | `list_channels` `publish` `subscribe_once` | MQTT/WS/Kafka bind 或 dry-run |
| `sparkplug` | `url`, `groupId`, `edgeNode`, `hostId?`, `encoding?` | encode/decode/parse + nbirth/ndeath/publish + **`host_state`** | 官方 protobuf；Host STATE 只读 stub + Host MVP |
| `sqs` | `queue`, `endpoint?`, `allowWrite?` | `list_queues` `send` `receive` `delete` | 内存 / unsigned JSON HTTP；无 SigV4；写入需 allowWrite |
| `ldap` | `url`, `base`, `tls?`, `allowWrite?` | bind/`sasl_bind`/search/compare + **add/modify/delete** | 写入需 allowWrite；SASL **PLAIN only**；**无 GSSAPI** |
| `bacnet` | `host`, `port?`, `udp?`, `allowWrite?` | `who_is` `i_am` `read_property` `list_objects` `write_property` | unicast Who-Is；写入需 allowWrite |
| `ethernetip` / `enip` | `host?`, `tcp?`, `allowWrite?` | `list_identities` `list_tags` `read_tag` `write_tag` | CIP List Identity；本地 tags；无 Forward Open |
| `s7` | `host?`, `rack?`, `slot?`, `tcp?`, `allowWrite?` | `read` `list_areas` `write` | ISO-TCP + Read Var 子集；默认只读 |
| `mtconnect` | `url` / `fixture` / `xml` | `probe` `current` `sample` | HTTP Agent 拉；无 Assets |
| `sql` / `sqlite` / `postgres` / `mysql` | `driver`+`filename`/`url`，`native?` | `query` `execute` `list_tables` `describe` | CI mock / `node:sqlite`；`native:true` 可选 `pg`/`mysql2`/`better-sqlite3` |
| `mongodb` | `simulator:true` 或 `url` | `list_collections` `find` `insert_one` | 无 url 内存；`url` 走 **OP_MSG** 子集；无 aggregation |
| `elasticsearch` / `opensearch` | `url` / simulator | `list_indices` `search` `index_doc` | HTTP `_cat`/`_search`/`_doc`；OpenSearch **同路径别名** |
| `clickhouse` | `url` / simulator | `query` `execute` | HTTP POST + `FORMAT JSONEachRow`；INSERT/DDL 需 allowWrite |
| `neo4j` | `url` / simulator | `cypher` | HTTP `/db/{db}/tx/commit`；**Bolt 仍 `E_UNSUPPORTED`** |
| `sftp` | `host`, `user?`, `password?` | `list` `get` `put` `delete` | **ssh2 SSH-2**；不是 FTP；写需 allowWrite |
| `memcached` | `host?`, `port?` | `get` `set` `delete` `stats` | 文本协议；写需 allowWrite |
| `tftp` | `host?`, `port?` | `get` `put` | RFC1350 RRQ/WRQ；不是 FTP |
| `caldav` | `url?` | `propfind` `report` `freebusy` `get` `put` | time-range + freebusy；iTIP `E_UNSUPPORTED`；写需 allowWrite |
| `carddav` | `url?` | `propfind` `report` `get` `put` | addressbook-query 子集；写需 allowWrite |
| `beanstalkd` | `host?`, `port?` | `stats` `put` `reserve` `delete` | 文本协议；写需 allowWrite |
| `zookeeper` | `host?`, `port?` | `ruok` `get` `create` `watch_once` `multi` | 一次性 watch + MULTI；ACL/SASL `E_UNSUPPORTED` |
| `redis` | `url`, `allowWrite?` | kv + hash/list/stream + pub/sub | 写入需 allowWrite |
| `s3` / `gcs` / `oss` | `bucket` | `list` `get` `put` | 内存 / 签名子集（S3 SigV4、GCS Bearer、OSS HMAC） |
| `dns` | `host?` / `simulator?` | `query` | 单播 A/AAAA/TXT/PTR；无 AXFR / 无组播 |
| `cassandra` | `host?` / `simulator?` | `list_keyspaces` `cql` | native v4 STARTUP/QUERY；写闸 |
| `couchdb` | `url?` / `simulator?` | `all_docs` `get` `put` | HTTP；写需 allowWrite |
| `whois` | `host?` / `simulator?` | `query` | TCP 43 只读 |
| `solr` | `url?` / `simulator?` | `list_cores` `select` `update` | HTTP；写需 allowWrite |
| `rabbitmq` | `url?` / `simulator?` | `list_queues` `publish` `get` | **management HTTP**；不是 AMQP |
| `kubernetes` / `k8s` | `url?` / `simulator?` | list/get pods/services/configmaps | 只读；exec/apply **恒** `E_UNSUPPORTED` |
| `os_info` | （空） | `uname` | 本机 OS；热加载，不在 boot 挂载 |
| `platform_fs` | `roots?` | `list` `read` `roots` | 闸根目录；不可 allowWrite |
| `platform_process` | `allowShell?` | `process_list` `shell_exec` | Linux `/proc`；Win/mac 注入或 gap；shell_exec 闸+stub |
| `platform_service` | `allowShell?` | `service_list` | systemd/sc/launchctl；缺工具 `E_UNSUPPORTED` |
| `docker` | `url?` / `simulator?` | list/inspect | Engine HTTP 只读；`run` 恒 stub |
| `journal` | `path?` / `simulator?` | `read` | syslog 文件；wevtutil/journalctl stub |
| `prometheus` | `url` / `simulator?` | `query` `query_range` `remote_write` | protobuf+snappy 写需 allowWrite；内存 query 按名 |
| `influx` / `influxdb` | `bucket`, `url?` | `write_points` `delete_points` `query` | Flux + `/api/v2/delete`；写/删需 allowWrite |
| `snmp` / `ftp` / `webdav` / `etcd` | 见 PROTOCOLS | get/walk；list/retr；propfind；range/put | SNMP **无 v3**；FTP **不是 SFTP** |
| `imap` / `pop3` | `host` | list/select/fetch；stat/retr | 写闸；**不是 SMTP 发信** |
| `consul` / `azureblob` | `url` | kv/catalog；list/get | Azure SharedKey 子集 / SAS |

### 新增协议示例（XML-RPC / JSON-RPC / FIX / Redis / SMTP / LDAP）

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
- **Redis**：GET/SET/DEL/KEYS/PUBLISH/SUBSCRIBE_ONCE + hash/list/stream
- **SMTP**：`send_mail`（需 allowWrite）+ `noop`；`raw:true` EHLO/MAIL/DATA；STARTTLS 未广告 → `E_UNSUPPORTED`；不是 IMAP/POP3
- **LDAP**：bind / `sasl_bind` PLAIN / search / compare；`add`/`modify`/`delete` 需 `allowWrite`；`tls` / `starttls`；**无 GSSAPI**
- **数据面**：优先 `sqlite` / `postgres` / `mysql` / `mongodb` / `qdrant` 等具体 id。泛化 `sql` 只是 driver 门面。

完整合同见 `docs/PROTOCOLS.md`。示例配置见 `examples/`（含 `solr-local.json`、`rabbitmq-local.json`、`kubernetes-local.json`）。

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

`discovery_scan_host` 只探测**单个 host**。网段 / CIDR / 通配符默认直接拒绝，并拦截 metadata IP。mDNS **组播**与 NFS **未实现**（组播等于扫网；NFS 无适配器）。设计见 `docs/DISCOVERY.md`。

## 仓库结构

```
src/transport/     stdio（默认）+ Streamable HTTP `/mcp` + SSE `/sse`；无业务逻辑
src/control/       mcp_* 管理工具、policy、security plane、console REST
src/catalog/       热注册表、JSON 持久化、校验、blacklist、list_changed
src/discovery/     单主机探测；suggest/import 已挂成 MCP 工具
src/runtime/       内核：types/errors/auth/load/log/invoke
src/adapters/      SPI + 扁平协议实现 + 可选 pack 分组
examples/          配置与 OpenAPI/WSDL/proto 夹具
tests/             注册表 + 各适配器 + MCP 语义（~133 suites）
docs/              架构 / ADR / 协议目录 / 发现 / 安全 / 发布说明
ui/                同进程控制台源；构建进 dist/ui
```

依赖：`transport → control → catalog`；`control → discovery`；适配器经 `runtime/bootstrap` 注册；**adapters 不得 import control/transport**。详见 `docs/ARCHITECTURE.md`。

## 文档

- [架构](docs/ARCHITECTURE.md)
- [ADR 0001 五包布局](docs/adr/0001-five-package-layout.md)
- [ADR 0002 Audience 绑定 actor](docs/adr/0002-actor-bound-audience.md)
- [Phase M 审查纪要（历史）](docs/PHASE_M_REVIEW.md)
- [协议目录（Implemented / Thin / leftover）](docs/PROTOCOLS.md)
- [发现](docs/DISCOVERY.md)
- [Roadmap（P0–V 执行顺序；下一阶段等用户）](docs/ROADMAP.md)
- [发布说明 / 变更记录](docs/RELEASE_NOTES.md)
- [Web 控制台](docs/CONSOLE.md)
- [安全架构（锁定决策）](docs/SECURITY_ARCHITECTURE.md)
- [黑名单](docs/BLACKLIST.md)
- [TLS / 证书 reconnect 重载](docs/TLS.md)
- [体检与测试覆盖](docs/AUDIT.md)
- [统一错误码](docs/ERRORS.md)

没有单独的 `CHANGELOG.md` / `CONTRIBUTING.md`：发版与基线在 `docs/RELEASE_NOTES.md`；贡献入口就是本 README 的快速开始 + `npm test`。

## 开发脚本

| 脚本 | 作用 |
| --- | --- |
| `npm run build` | `tsc` → `dist/`，并 `ui:build` 到 `dist/ui` |
| `npm run ui:build` | 控制台 SPA → `dist/ui` |
| `npm start` | 运行 MCP server（默认 stdio；见 `EVERYTHING2MCP_TRANSPORT`） |
| `npm test` | `tsx --test`（当前基线 115 / 494） |
| `npm run dev` | `tsx watch` |

## 有意不做 / 环境挡住（不是漏写）

- Kafka **真** EOS / cooperative rebalance（需集群；hermetic 状态机 ≠ 线上事务）
- SQL CI 真 Postgres/MySQL **Docker 镜像**（本环境无 Docker；`native:true` 可选动态驱动）
- LDAP **GSSAPI**
- v2 本地 JS / v3 npm **外部安全插件加载**
- MCP **Agent 写 challenge**（只有控制台 `confirm:true`）
- **NFS** 完整客户端 / SHOWMOUNT（已有 NFSv3 NULL ping + simulator exports）
- mDNS **组播浏览**（单播 `host:5353` 已有）
- 部署时批量注册能力 / 默认打开桌面控制
- `allowShell` / `allowDesktop` 真执行（只有闸与 stub；扫描从不打开）
- SMB/CIFS 完整 TREE_CONNECT 文件客户端（已有 SMB2 NEGOTIATE + simulator）

## English

Everything2MCP is a single-process MCP server: **discover, register, invoke** heterogeneous protocols as MCP tools. **stdio is the default.** Set `EVERYTHING2MCP_TRANSPORT=http` (or `sse`) to serve Streamable HTTP at `/mcp`, legacy SSE at `/sse`, and the same-process dark console at `/ui/` (REST under `/api/*`) on port `8742`. Optional `EVERYTHING2MCP_HTTP_TOKEN` requires `Authorization: Bearer` or `x-api-key`.

**Phase X is current** (Partner protocol + Compat Catalog + native Feishu/DingTalk/WeCom/Slack/Notion/GitHub + mcp_bridge 兜底). Test baseline **133 suites / 545 tests**. Southbound is not MCP by default. Next work waits for an explicit continue.

Security (locked): Safe vs Full; blacklist always on (including Full); default `allowWrite=false`; Full ≠ global write; no CIDR UI; `ALLOW_SCAN` is dead; no shim; actor-bound audience so agents cannot spoof `audience=console`. Plugin SPI: builtins only in v1.

Agents should prefer `mcp_plan_bridge`, `discovery_scan_host`, `mcp_add_from_discovery`, and `schema_import`. Discovery never scans network ranges or metadata IPs. Protocol honesty table: `docs/PROTOCOLS.md`. Unified error codes: `docs/ERRORS.md`.

```bash
npm install && npm run build && npm test
EVERYTHING2MCP_TRANSPORT=http EVERYTHING2MCP_HTTP_PORT=8742 npm start
```
