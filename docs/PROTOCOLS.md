# 协议目录与优先级

Everything2MCP 用同一套 MCP tool 表面覆盖多种线协议。状态分三档：

- **Implemented** — 可用，有真实客户端路径 + hermetic 测试
- **Thin** — 已注册，`listTools`/`invoke` 可用；能力故意收窄（模拟器、编码器或有限操作），文档写明限制
- **Planned leftover** — 尚未做适配器

`src/core/` 与 `src/management/` shim **已删除**。入口与测试一律从 `transport` / `control` / `catalog` / `runtime` / `discovery` / `adapters` 导入。阶段勾选见 `docs/ROADMAP.md`（P0–P6 已验收核心项；stdio 默认，HTTP/SSE 可选）。

## 总表（按面分组）

数据面默认 **`allowWrite=false`**（query / list / describe / search 可读；execute / insert / upsert 需显式打开）。推荐直接用具体 protocol id，不要依赖泛化 `sql`。

### 数据面 — 关系型

| 协议 | id | 状态 | tools | 限制 |
| --- | --- | --- | --- | --- |
| SQLite | `sqlite` | Implemented | `query` `execute` `list_tables` `describe` | CI 默认 `node:sqlite`；`native:true` 走可选 `better-sqlite3`（缺包 `E_UNSUPPORTED`） |
| PostgreSQL | `postgres` | Thin | 同上 | CI `simulator:true`；`native:true`+`url` 走可选 `pg`（缺包友好 `E_UNSUPPORTED`）；不是完整 live 池/SSL |
| MySQL / MariaDB | `mysql`（别名 `mariadb`） | Thin | 同上 | CI simulator；`native:true`+`url` 走可选 `mysql2`；MariaDB 线兼容 |
| SQL Server | `sqlserver` | Thin | 同上 | 无捆绑 TDS 客户端；simulator / 注入 |
| DuckDB | `duckdb` | Thin | 同上 | 无捆绑 duckdb 包；CI simulator |
| SQL 门面 | `sql` | Thin | 同上 | **按 `driver` 转发**；文档不推荐新集成使用 |

### 数据面 — 文档 / KV / 搜索 / 图 / 向量 / 对象

| 协议 | id | 状态 | tools | 限制 |
| --- | --- | --- | --- | --- |
| MongoDB | `mongodb` | Thin | `list_collections` `describe` `find` `insert_one` | 无 aggregation；无 url 内存；`url` 走 **OP_MSG** hello/find/insert/listCollections |
| Redis | `redis` | Implemented | get/set/del/keys + **hget/hset/hgetall** + **lpush/lrange** + **xadd/xread** + pub/sub | 无集群 / Lua；hash/list/stream 基础；写入需 allowWrite |
| Elasticsearch | `elasticsearch` | Thin | `list_indices` `describe` `search` `index_doc` | Query DSL 子集；CI 内存；`url` 走 HTTP `_cat` / `_search` / `_doc` |
| OpenSearch | `opensearch` | Thin | 同上 | **与 ES 同 HTTP 路径**（别名，无第二套客户端） |
| ClickHouse | `clickhouse` | Thin | `query` `execute` `list_tables` `describe` | `url` 走 HTTP POST + `FORMAT JSONEachRow`；无 url / `simulator` 内存；INSERT/DDL 需 allowWrite；无 cluster DDL |
| Neo4j | `neo4j` | Thin | `list_labels` `describe` `cypher` | Cypher 子集；`http(s)` 走 `/db/{db}/tx/commit`；Bolt 仍需注入 |
| Cassandra | `cassandra` | Thin | `list_keyspaces` `list_tables` `describe` `cql` | CQL 子集；native v4 STARTUP/QUERY；写闸；无 prepared / 无 LWT |
| CouchDB | `couchdb` | Thin | `list_dbs` `all_docs` `get` `put` | HTTP `_all_docs` / GET / PUT；写闸；无 `_changes` / 无附件 |
| Whois | `whois` | Thin | `query` | TCP 43 只读；无写 |
| Solr | `solr` | Thin | `list_cores` `select` `update` | HTTP select/update；写闸；不是 SolrCloud admin |
| RabbitMQ management | `rabbitmq` | Thin | `list_queues` `list_exchanges` `publish` `get` | HTTP `/api/*`（15672）；**不是** AMQP 线协议（见 `amqp`） |
| Kubernetes | `kubernetes`（`k8s`） | Thin | `list_*` `get_*` pods/services/configmaps | 只读；`exec`/`apply` 恒 `E_UNSUPPORTED` |
| Qdrant | `qdrant` | Thin | `list_collections` `describe` `search` `upsert` | 向量库（**未做 ChromaDB**）；cosine simulator |
| S3 / MinIO | `s3` | Implemented | `list` `get` `put` `delete` | memory / unsigned / **SigV4**；写入需 `allowWrite` |
| GCS | `gcs` | Thin | 同上 | unsigned JSON 或 **Bearer token**；无完整 OAuth 刷新 |
| Aliyun OSS | `oss` | Thin | 同上 | unsigned REST 或 **AccessKey HMAC-SHA1** |
| Azure Blob | `azureblob` | Thin | 同上 | unsigned / **SharedKey HMAC-SHA256 子集** / `sasToken` 查询串；写需 allowWrite；不是完整 2015+ canonical query |
| Consul | `consul` | Thin | `kv_get` `kv_put` `kv_delete` `catalog_services` `health_service` | HTTP API；无 Connect/intentions；写需 allowWrite |
| Prometheus | `prometheus` | Implemented | `query` `query_range` `remote_write` | HTTP API + protobuf/snappy remote_write；内存 query 仅按 metric 名；写需 allowWrite |
| InfluxDB | `influx`（`influxdb`） | Thin | `write_points` `delete_points` `query` | **Flux**（非 InfluxQL）；`/api/v2/delete` 谓词子集；内存非真引擎；写/删需 `allowWrite` |

### HTTP / RPC / 消息 / 工业

| 协议 | id | 状态 | 主要 tools | 限制 |
| --- | --- | --- | --- | --- |
| OpenAPI / HTTP | `openapi`（`http`） | Implemented | 每个 operation | OAS3 |
| SOAP | `soap` | Thin | WSDL operations | 1.1/1.2；无 WS-Security |
| gRPC | `grpc` | Implemented | unary + server/client/one-shot bidi + session bidi | `tlsWatch` 热重读 PEM 并 **进程内 remount** ChannelCredentials（bidi session 会断）；remount 失败才要 `mcp_update`；reflection 先 v1 再 v1alpha |
| GraphQL | `graphql` | Implemented | query/mutate/introspect/`subscribe_once` | `subscribe_once` 为 graphql-ws 一次 next；无 wsUrl/`simulator` → `E_UNSUPPORTED` |
| XML-RPC / JSON-RPC | `xmlrpc` / `jsonrpc` | Implemented | call 等 | — |
| MQTT | `mqtt` | Implemented | publish / subscribe_once | `$share/{group}/{filter}` 只剥前缀匹配；broker 需支持 shared sub |
| AsyncAPI | `asyncapi` | Thin | list_channels / publish / subscribe_once | MQTT/WS/Kafka bind 或 dry-run |
| Sparkplug B | `sparkplug` | Implemented | encode/decode/parse + nbirth/ndeath/publish | 默认官方 protobuf；json-compat 为 fallback |
| WebSocket | `websocket`（`ws`） | Implemented | send / receive_once | 无重连 |
| AMQP / Kafka / NATS / SQS / Pulsar | `amqp` `kafka` `nats` `sqs` `pulsar` | Implemented / Thin | 见下 | NATS JetStream consumer/ack/interest 内存子集；AMQP get/ack/nack；SQS unsigned JSON；Pulsar 默认官方 PulsarApi 子集，`dialect: e2p1` 为旧方言 |
| OPC-UA | `opcua` | Thin | read/write/browse/`subscribe_once`/`wait_data_change` | CI simulator；`subscribe_once` 一次性；`wait_data_change` 为内存 monitored-item |
| Modbus / CoAP / FIX / BACnet | `modbus` `coap` `fix` `bacnet` | Thin / Implemented | 见下 | CoAP 有 Observe；FIX 内存 session；BACnet/IP unicast Who-Is |
| EtherNet/IP | `ethernetip`（`enip`） | Thin | `list_identities` `list_tags` `read_tag` `write_tag` | CIP List Identity；本地 tag 表；无 Forward Open / Class 1 |
| Siemens S7 | `s7` | Thin | `read` `list_areas` `write` | ISO-TCP + S7comm Read Var 子集；无优化块访问 |
| MTConnect | `mtconnect` | Thin | `probe` `current` `sample` | HTTP 拉 Agent；无 Assets / websocket |
| SMTP / LDAP | `smtp` `ldap` | Implemented / Thin | send_mail / **noop**；bind/**sasl_bind**/search/**add/modify/delete** | SMTP 发信需 allowWrite；`raw:true` EHLO/MAIL/DATA；STARTTLS 未广告 `E_UNSUPPORTED`；不是 IMAP/POP3。LDAP SASL **PLAIN only** |
| SFTP | `sftp` | Implemented | `list` `get` `put` `delete` | **ssh2 SSH-2 子系统**；不是 FTP/FTPS；写需 allowWrite |
| Memcached | `memcached` | Implemented | `get` `set` `delete` `stats` | 文本协议；写需 allowWrite |
| TFTP | `tftp` | Thin | `get` `put` | RFC1350 octet RRQ/WRQ；不是 FTP；WRQ 需 allowWrite |
| IMAP | `imap` | Thin | `list_mailboxes` `select` `fetch` `search` `append` `store_delete` `expunge` | IMAP4rev1 读优先；写/删需 allowWrite；**不是 SMTP 发信**；无 IDLE/QRESYNC/IMAPS-only |
| POP3 | `pop3` | Thin | `stat` `list` `retr` `dele` `rset` | 读优先；DELE/RSET 需 allowWrite；**不是 SMTP** |
| SNMP | `snmp` | Implemented | `get` `get_next` `walk` `set` | SNMPv2c BER；内存 MIB 或 UDP 161；**无 v3/USM**；`set` 需 allowWrite |
| WebDAV | `webdav` | Implemented | `propfind` `get` `put` `delete` `mkcol` | 内存 VFS 或 HTTP；CalDAV/CardDAV 见独立 id；写需 allowWrite |
| CalDAV | `caldav` | Implemented | `propfind` `report` `freebusy` `get` `put` `delete` `mkcalendar` | RFC4791 time-range + free-busy-query；iTIP schedule `E_UNSUPPORTED`；写需 allowWrite |
| CardDAV | `carddav` | Implemented | `propfind` `report` `get` `put` `delete` `mkcol` | RFC6352 addressbook-query 子集；写需 allowWrite |
| Beanstalkd | `beanstalkd` | Implemented | `stats` `list_tubes` `peek` `put` `reserve` `delete` | 文本协议；put/reserve/delete 需 allowWrite |
| ZooKeeper | `zookeeper` | Thin | `ruok` `exists` `get` `get_children` `create` `set` `delete` `watch_once` `multi` | 四字 + 二进制；一次性 watch + MULTI；ACL/SASL `E_UNSUPPORTED` |
| DNS | `dns` | Thin | `query` | 单播 A/AAAA/TXT/PTR；无 AXFR / 无组播 / 不是 DNS-SD 浏览 |
| FTP | `ftp` | Implemented | `list` `retr` `stor` `dele` | 内存或 PASV 控制通道；**不是 SFTP/FTPS**；写需 allowWrite |
| etcd | `etcd` | Thin | `range` `put` `delete` | v3 HTTP KV；无 watch/lease/election；写需 allowWrite |

`discovery_scan_host` 会指纹常见 DB 端口（5432/3306/1433/27017/9200/8123/7687/7474/6333/6379/**9042 Cassandra**/**5984 CouchDB**/**8983 Solr**）、MinIO **9000** / Prometheus **9090** / GCS **4443** / Influx **8086**、OSS HTTP 头（`x-oss-request-id`）、Pulsar **8080 admin / 6650 TCP**、**RabbitMQ management 15672**（与 AMQP **5672** 分开）、**Kubernetes 6443** `/version`、BACnet/IP **47808 单播 Who-Is**、EtherNet/IP **44818 List Identity**、S7 **102 COTP CC**、MTConnect **5000/80 /probe**、**FTP 21** / **SFTP 22 SSH-2** / **TFTP 69** / **Memcached 11211** / **SNMP 161** / **etcd 2379** / **IMAP 143** / **POP3 110** / **Consul 8500** / **Azure Blob 10000** / **SSDP 单播 1900** / **DNS-SD 单播 5353** / **DNS 单播 53** / **Whois 43** / **CalDAV/CardDAV 5232 OPTIONS** / **Beanstalkd 11300** / **ZooKeeper 2181 ruok** / WebDAV `OPTIONS`，**不做网段扫、不发 BACnet 广播、不发 SSDP/mDNS 组播**。

管理工具：`mcp_list` / `mcp_add` / `mcp_update` / `mcp_remove` / `mcp_query_by_protocol` / `mcp_health` / `mcp_explain_tool` / `mcp_plan_bridge` / `mcp_add_from_discovery` / `schema_import` / `discovery_*`。业务 tool 全名：`{protocol}.{name}.{op}`。

默认 **禁止网段扫描**；`mcp_add` 配置走 SSRF 防护（metadata / link-local）。

## OpenAPI / HTTP（Implemented）

```json
{
  "spec": "./examples/petstore.openapi.json",
  "baseUrl": "https://api.example.com/v1",
  "auth": { "type": "bearer", "token": "…" }
}
```

## MQTT（Implemented）

```json
{ "url": "mqtt://127.0.0.1:1883", "topics": ["sensors/#", "$share/workers/sensors/+"] }
```

`subscribe_once` 的 filter 若为 MQTT 5 **`$share/{ShareName}/{filter}`**，匹配时剥掉 share 前缀。真正的共享订阅仍取决于 broker；本适配器不做 `$queue/` HiveMQ 扩展。

## SOAP / WSDL（Thin）

```json
{ "wsdl": "./examples/calculator.wsdl", "endpoint": "http://127.0.0.1:8080/calculator" }
```

## gRPC（Implemented — unary + streaming MVP）

```json
{ "proto": "./examples/greeter.proto", "target": "127.0.0.1:50051", "tls": false }
```

无 `.proto` 时可开反射：`{ "target": "127.0.0.1:50051", "reflection": true }`（先 `grpc.reflection.v1`，失败再 `v1alpha`）。反射与业务 RPC 共用 `credentialsFromConfig`。

写闸：`Get`/`List`/`Read`/`Query`/`Ping`/`Health`/`Status`/`Echo` 等只读动词前缀的 RPC **不需要** `allowWrite`；`SayHello`/`Add`/`Chat` 等未知名默认闸住（fail-closed）。

- **unary**：`body` JSON 字段
- **server-streaming**：同一 tool，`maxMessages`（默认 8，上限 64）收集后 cancel；返回 `{ messages, count, truncated }`
- **client-streaming**：`messages[]` 写完再等一条 reply
- **bidi（one-shot）**：按 method 暴露 tool。写入 `messages[]`、结束客户端半流、收集最多 `maxMessages`（默认 8，上限 64）条 reply，然后 **cancel**。返回 `{ messages, count, truncated, cancelled, window }`。
- **bidi（session）**：`bidi_open` `{ method, maxMessages?, timeoutMs? }` → `streamId`；`bidi_send` `{ streamId, message, end? }`；`bidi_recv` `{ streamId, maxMessages?, timeoutMs? }`（空窗 `E_TIMEOUT`）；`bidi_close` 取消；`bidi_status` 只读。未读 inbox 达到 `maxMessages` 时 **pause**（背压），recv 后 resume。`allowWrite` 只约束 **open/send**（按目标 RPC 名启发式）；recv/close/status 不闸。会话 deadline 在 open 时设置；**无**证书热重载。
- **TLS / 证书**：`tls: true` 用系统/默认 SSL creds。可选 `ca` / `cert` / `key`（及 `tlsCa`/`tlsCert`/`tlsKey`、`*File` 别名）— **内联 PEM**（含 `-----BEGIN`）或文件路径。证书在 `connect` 时加载一次，**不热重载**。只给 cert 不给 key（或反过来）→ `E_INVALID_CONFIG`。CI **不做**完整 mTLS 握手（无随仓库的真实证书链）。

`examples/greeter.proto` 含 `SayHello`、`GetStatus`（只读动词，默认放行）、`StreamHello`（server-stream）、`CollectHellos`（client-stream）、`Chat`（bidi）。

## AsyncAPI（Thin）

```json
{ "spec": "./examples/streetlights.asyncapi.json", "brokerUrl": "mqtt://127.0.0.1:1883" }
```

`brokerUrl` 按 scheme 绑定其一：`mqtt(s)://`、`ws(s)://`、`kafka://`（或 `bind: "mqtt"|"websocket"|"kafka"`）。无 broker 时 `publish` 为 dry-run，`subscribe_once` 拒绝。不把 spec `servers` 自动连上（避免 CI 误连 127.0.0.1:1883）。

## Sparkplug B（Implemented — official protobuf）

```json
{ "url": "mqtt://127.0.0.1:1883", "groupId": "IIoT", "edgeNode": "press-01", "encoding": "protobuf" }
```

主题：`spBv1.0/{group}/{NBIRTH|NDEATH|NDATA|DBIRTH|DDATA|DDEATH|…}/{edge}[/{device}]`。

- **默认** Eclipse Tahu / Sparkplug 3.0 **官方 protobuf** `org.eclipse.tahu.protobuf.Payload`（`src/adapters/sparkplug/sparkplug_b.proto`，来源 [eclipse/tahu sparkplug_b.proto](https://github.com/eclipse/tahu/blob/master/sparkplug_b/sparkplug_b.proto)）
- Tools：`encode_payload` `decode_payload` `parse_message` `encode_topic` `publish` `nbirth` `ndeath` `subscribe_once` `session_status` `list_topics` **`host_state`** **`host_online`** **`host_offline`** **`rebirth`**
- `parse_message` 识别 NBIRTH/NDEATH/NDATA/DBIRTH/DDATA/DDEATH（及 NCMD/DCMD）以及 **Host STATE**（`spBv1.0/STATE/{hostId}`）
- `encoding: "json-compat"` 仍可用作 Tahu JSON fallback；入站 JSON `{` 自动按 json-compat 解码
- MQTT will（LWT NDEATH）**仅在 `allowWrite: true` 时设置**；默认只读 connect 不再向 broker 登记死亡遗嘱
- **Template / DataSet / PropertySet**：`encode_payload` / `decode_payload` / `parse_message` 做官方 protobuf 往返。DataSet 为 `{ columns, types, rows }`；Template 为 `{ version, templateRef, isDefinition, metrics, parameters }`；PropertySet 挂在 metric `properties`（一层嵌套 + PropertySetList）。
- **Host Application MVP**：`host_online` / `host_offline` 发 **retain** STATE JSON `{online,timestamp}`（需 `allowWrite`）。`rebirth` 发 `spBv1.0/{group}/NCMD/{edge}`，metric `Node Control/Rebirth=true`。`host_state`：若本适配器已发布 STATE 则返回快照（`role=host`）；否则 observer one-shot 订阅。不是完整 Host（无自动 rebirth 循环、无全量 NCMD 目录）。Parameter/DataSet/Metric *Extension*、任意深度 Template 套 Template 仍不做。

样例二进制：`examples/sparkplug-nbirth.pb`、`examples/sparkplug-complex.pb`。

## WebSocket / GraphQL / AMQP / Kafka

见 README 与 `examples/`。GraphQL `subscribe_once` 走 graphql-ws（`wsUrl`）或 simulator bus；HTTP `query` 文档若含 mutation/subscription **操作**仍闸 `allowWrite`。JSON-RPC / XML-RPC / SOAP 与 gRPC 共用只读动词启发式（未知 method 默认闸）。

- **Kafka** `consume_once` 使用稳定 `groupId`（默认 `everything2mcp`，可按调用覆盖）。每次 consume 是短连接 join（connect / subscribe / 读一条 / leave）。只读 **`group_status`** 报告 `groupId`、`committed` 偏移。**live KafkaJS**：`rebalance=none`、`transactional` 永远 false、`transactionalId.effective=false`、`staticMembership.effective=false`；事务 tool → `E_UNSUPPORTED`。**hermetic** 内存 handle（`createHermeticKafkaHandle`）另有本地 `InitProducerId` 状态机、`group.instance.id` 旗、以及 `generation`（instance 变化 +1，`rebalance=hermetic-generation`）；**不是** 集群事务协调器 / **不是** cooperative rebalance / **不是 EOS**。`config.idempotent=true` 时真实路径把 KafkaJS `producer({ idempotent:true, maxInFlightRequests:1 })`。不要把 `group_status` 当成事务协调器。
- **AMQP** 除 `publish` / `consume_once` / **`rpc`** 外有内存 **`get`/`ack`/`nack`**（requeue）。publish/rpc/ack/nack 需 `allowWrite`。无 publisher confirm。`simulator:true` 不连真 broker。

## OPC-UA（Thin）

```json
{
  "endpoint": "opc.tcp://127.0.0.1:4840",
  "simulator": true,
  "nodes": [{ "nodeId": "ns=2;s=Temperature", "displayName": "Temperature", "value": 21.5 }]
}
```

- 默认 `simulator: true`：内存地址空间 + `sessionId`（CI）
- `simulator: false`：node-opcua 建 session，browse/read/write；测试可注入 `OpcUaHandle`
- `subscribe_once`：一次性读（不是 Subscription 服务）
- `create_monitored_item` / `wait_data_change` / `delete_monitored_item`：内存 monitored-item，写节点后触发；不是完整 Publish 循环
- 无 method-call

## Modbus TCP / RTU（Thin）

FC1–6、**FC15** Write Multiple Coils、**FC16** Write Multiple Registers、**FC23** Read/Write Multiple Registers（先写后读）。

- 默认 **TCP/MBAP**（`simulator: true` 或 TCP `host`/`port`）
- **`mode: "rtu"`**：`[slaveId][PDU][CRC16 LE]`。hermetic 为 memory duplex 或 `createVirtualSerialPair` 可注入 `stream`。无捆绑 `serialport`：设 `path`（真串口）→ `E_UNSUPPORTED`。

Tools：`read_holding_registers` `read_input_registers` `read_coils` `read_discrete_inputs` `write_register` `write_coil` `write_coils` `write_registers` `read_write_registers`。写 tool（含 FC23）需 `allowWrite: true`。

## CoAP（Thin）

Confirmable CRUD + **Observe** `observe_once` / `observe_cancel`。无 DTLS。

## NATS（Thin）

Core NATS + JetStream 子集：`js_publish`、`js_subscribe_once`、`js_info`、`js_consumer_add`、`js_next`、`js_ack`、`js_nack`。`simulator:true` 为内存 stream + interest filter（`*` / `.>`）。publish / consumer_add / ack / nack 需 `allowWrite`。不是完整 JetStream API / 不是集群 mirror。

## SQS（Thin — unsigned JSON HTTP / 内存）

```json
{ "queue": "orders", "endpoint": "memory://", "allowWrite": false }
```

Tools：`list_queues` `send` `receive` `delete`。默认只读；`send` / `delete` 需 `allowWrite: true`。`unsigned: true` + http endpoint 走简化 JSON REST（`/queues`、`/queues/{name}/messages`），**无 AWS SigV4**。CI：内存或本地 fake HTTP。

## Pulsar（Thin — 内存 / unsigned JSON HTTP / 官方 PulsarApi / e2p1）

```json
{ "topic": "orders", "serviceUrl": "memory://", "allowWrite": false }
```

```json
{ "topic": "orders", "serviceUrl": "pulsar://127.0.0.1:6650", "allowWrite": false }
```

```json
{ "topic": "orders", "serviceUrl": "pulsar://127.0.0.1:6650", "dialect": "e2p1", "allowWrite": false }
```

Tools：`publish` `consume_once` `list_topics` `list_namespaces` **`lookup`** **`partitioned_metadata`**。默认只读；`publish` 需 `allowWrite: true`。`consume_once` 按 `subscription` 记游标。短名 topic 展开为 `persistent://{tenant}/{namespace}/{name}`（默认 `public/default`）。

- **`pulsar://` 默认**：官方 **PulsarApi** 子集（`src/adapters/pulsar/PulsarApi.proto`，字段号对齐 [apache/pulsar PulsarApi.proto](https://github.com/apache/pulsar/blob/master/pulsar-common/src/main/proto/PulsarApi.proto)）。帧：`[totalSize][cmdSize][BaseCommand]`，带载荷时再跟 `0x0e01` + CRC32C + `MessageMetadata` + payload。命令：CONNECT/CONNECTED、PRODUCER/PRODUCER_SUCCESS、SEND/SEND_RECEIPT、SUBSCRIBE/SUCCESS、FLOW、MESSAGE、ACK、GET_TOPICS_OF_NAMESPACE、**LOOKUP/LOOKUP_RESPONSE（官方 type 23/24）**、PING/PONG、CLOSE_*。
- **`lookup`**：只读。fake broker：普通 topic → `Connect`（本 broker URL）；名含 `missing`/`notfound`/`-fail` → `Failed`/`TopicNotFound` → **`E_NOT_FOUND`**。名含 `redirect` 时 **跟 Redirect**：默认最多 `maxLookupRedirects=3`；跟到 owner 后 `followed:true`，该 topic 的 publish/consume **改走 owner hop**。死 hop（`redirect-dead` 或无 `redirectTarget`）→ `E_PROTOCOL`；环 / 超限 → `E_UNSUPPORTED`。其它 topic 仍走原 CONNECT session。memory / unsigned HTTP / e2p1 → `E_UNSUPPORTED`。
- **`partitioned_metadata`**：官方 type 37/38。报 `partitions`。名含 `partitions-N` → N；`parted` → 3；普通 topic → 0；missing → `E_NOT_FOUND`。官方 **produce** 在 count>0 时路由到 `persistent://t/ns/name-partition-i`（有 `key` 则 FNV-1a hash，否则 round-robin）。已是 `*-partition-N` 的 topic **不再**改写。`consume_once` 在父 topic 上对各分区 FLOW，先到的 MESSAGE 胜出。
- **batch / chunk**：`consume_once` 若 `num_messages_in_batch>1` 则按 `SingleMessageMetadata` 展开，一次返回一条。带 `uuid`/`num_chunks_from_msg`/`chunk_id` 的 inbound chunk **按 uuid 重组**（最多 8 片；交错/超限 → `E_UNSUPPORTED`）。官方 `publish` 可带 `batch: string[]`、**`chunks: string[2-8]`**，或 **`chunk:true`**：按 UTF-8 **`chunkSize`**（默认 256，范围 1–1MiB；可用 `config.chunkSize` / `args.chunkSize`）切成多帧，**不撕码点**。单片（payload ≤ chunkSize）**不**带 chunk metadata。超过 8 片 → `E_UNSUPPORTED`；单码点大于 chunkSize → `E_INVALID_ARGUMENT`。`chunks[]` 优先于 `chunk:true`。memory / unsigned HTTP / e2p1 **不**路由、不发 batch/chunk。
- **不是** npm `pulsar-client`（C++ 绑定）。CONNECT 可选 `token` / `jwt` / `authToken`（`auth_method_name=token`）；handshake ERROR → `E_AUTH`。无事务、无 JWKS。hermetic 为 **嵌入式 fake broker**（`listenFakeOfficialPulsarBroker`），不是 Testcontainers / 真 Apache broker。对真 6650 仅覆盖上述命令；对端若讲 E2P1 → `E_PROTOCOL` 并提示 `dialect: "e2p1"`。
- **`pulsar+ssl://`**：`tls.connect`；自签证书用 `tlsInsecure: true`。无客户端证书热重载。
- **`dialect: "e2p1"`**（或 `e2mcp-pulsar`）：旧 JSON 方言（magic `E2P1`）。`listenFakePulsarBroker` 仍给现有测试。e2p1 **无 TLS**（`pulsar+ssl://` + e2p1 → `E_UNSUPPORTED`）。
- `unsigned: true` + http endpoint 走简化 JSON REST，不是官方 `/admin/v2`
- Discovery 对单主机 **8080** 认 `/admin/v2/brokers/ready` 或 `/admin/v2/clusters`，对 **6650** 认含 `pulsar` 的长度前缀回包；**禁止 CIDR**

## schema_import：import-first RPC

以下 **没有独立 adapter**。`schema_import` 能识别文档，但 `registerable: false`，应先导出 OpenAPI（或给 Connect proto 配 `target` 走 `grpc`）：

| 表面 | 识别 | 怎么接 |
| --- | --- | --- |
| JSON:API | `"jsonapi": { "version" }` 载荷 | 为该 HTTP 表面导出 OpenAPI |
| OData | `edmx:Edmx` / `$metadata` | 许多服务另有 `/$openapi`；导入那个 |
| tRPC | `"trpc"` / procedures query\|mutation | `trpc-openapi` 导出后当 OpenAPI |
| Connect-RPC | proto 含 `connectrpc` | 导出 OpenAPI，或 `grpc` + `config.target` |

## FIX（Thin）

内存 loopback transport 上的最小 session：`disconnected` → `logon` → `logged_on`，heartbeat / logout，seq `nextSeq` / `lastInboundSeq`。`resend_request` **在线上发 35=2**；loopback 回 **SequenceReset 35=4 GapFill**。outbox 命中再以 **PossDupFlag=Y（43）** 重发；loopback 对 43=Y 不应答（避免二次 Logon）。缺失 seq 列入 `gaps`。不是匹配引擎 / drop-copy。

写闸（`allowWrite` 默认 false）：

| Tool | 闸 |
| --- | --- |
| `encode` `decode` `session_status` | 只读（本地编解码 / 快照） |
| `heartbeat` | 需已 logon；本身不闸（保活） |
| `logon` `logout` `resend_request` | **会话当写** — 需 `allowWrite=true` |
| `new_order_single` | 应用写 — 需 `allowWrite=true` 且已 logon |

## LDAP（Thin）

```json
{ "url": "ldap://127.0.0.1:389", "base": "dc=example,dc=com", "tls": false, "starttls": true, "allowWrite": false }
```

`tls: true` 把 `ldap://` 升为 `ldaps://`。`search` 支持 `attributes`（缺省属性填 `null`）、`pageSize`/`cookie`。`sasl_bind`：**PLAIN** 映射 simple bind；GSSAPI / DIGEST-MD5 → `E_UNSUPPORTED`。

| Tool | 闸 |
| --- | --- |
| `bind` `sasl_bind` `search` `compare` | 可读（bind 是认证，不是目录写） |
| `add` `modify` `delete` | 需 `allowWrite=true` |

hermetic 测试走注入 `LdapHandle`；live 用 `ldapts` `add`/`modify`/`del`。

## BACnet（Implemented — unicast Who-Is / 内存对象表）

```json
{ "host": "127.0.0.1", "port": 47808, "deviceId": 1001, "udp": true, "allowWrite": false }
```

Tools：`who_is` `i_am` `read_property` `list_objects` `write_property`。

- 默认内存设备表；`udp: true` 时 Who-Is/I-Am 走 BACnet/IP **Original-Unicast-NPDU**（BVLC `0x81 0x0A`），**永不** Original-Broadcast（`0x0B`），也绝不扫 CIDR。
- `read_property` / `list_objects` / `write_property` 走本地对象表。写入需 `allowWrite: true`。
- 无 BBMD、无 COV、无确认型 ReadProperty 上线。Discovery 对单主机 `:47808` 发 unicast Who-Is，解析 I-Am。

## EtherNet/IP / CIP（Thin）

```json
{ "host": "127.0.0.1", "port": 44818, "tcp": false, "allowWrite": false }
```

Tools：`list_identities` `list_tags` `read_tag` `write_tag`。别名 `enip`。

- 默认内存 identity + 符号 tag 表。`tcp: true` 时 `list_identities` 发 CIP encapsulation **List Identity (0x0063)** 到单主机 TCP 44818。
- `read_tag` / `write_tag` 走本地表，不是完整 CIP 服务。写入需 `allowWrite: true`。
- **不做** Forward Open、Class 1 I/O、CIP Security、网段 List Identity 广播。Discovery 对单主机 `:44818` 发 List Identity。

## Siemens S7（Thin）

```json
{ "host": "127.0.0.1", "port": 102, "rack": 0, "slot": 1, "tcp": false, "allowWrite": false }
```

Tools：`read` `list_areas` `write`。地址：`DB1.DBW0`、`MW10`、`I0.0`、`Q0.0`。

- 默认内存 DB/M/I/Q 映像。`tcp: true` 时走 ISO-on-TCP（RFC 1006）COTP + **S7comm Read Var** 单次。
- 写入需 `allowWrite: true`。无 TIA 优化块、无 PUT/GET 以外的 S7 服务。Discovery 对单主机 `:102` 发 COTP CR，认 CC。

## MTConnect（Thin）

```json
{ "url": "http://127.0.0.1:5000" }
```

或 fixture：`{ "fixture": "./examples/mtconnect-probe.xml", "currentFixture": "./examples/mtconnect-current.xml" }`。

Tools：`probe`（Devices）`current`（Streams）`sample`（current 的 count 切片）。

- HTTP GET `/probe` 与 `/current`。无 Assets、无 websocket、无 Agent 序列窗口。Discovery 对单主机 **5000 / 80** 拉 `/probe`，认 `MTConnectDevices`/`MTConnectStreams` XML。

## Redis（Implemented）

```json
{ "url": "redis://127.0.0.1:6379", "allowWrite": false }
```

可读：`get` `keys` `hget` `hgetall` `lrange` `xread` `subscribe_once`。写入（`set` `del` `hset` `lpush` `xadd` **`publish`**）需 `allowWrite: true`。无集群、无 Lua。

## 数据面关系型

推荐具体 id（不要新接入泛化 `sql`）：

```json
{ "protocol": "sqlite", "config": { "filename": ":memory:", "allowWrite": false } }
```

```json
{ "protocol": "postgres", "config": { "url": "postgres://127.0.0.1:5432/app", "simulator": true, "allowWrite": false } }
```

`mysql` / `mariadb` 同一实现（MariaDB 线协议兼容）。`sqlserver`、`duckdb` 为 Thin simulator。泛化 `sql` 仅按 `driver` 转发到上述引擎。

可选 **native** 路径（**不**进默认依赖；CI 仍 mock / `node:sqlite`）：

```json
{ "protocol": "postgres", "config": { "url": "postgres://127.0.0.1:5432/app", "native": true, "allowWrite": false } }
```

```json
{ "protocol": "mysql", "config": { "url": "mysql://127.0.0.1:3306/app", "driver": "native", "allowWrite": false } }
```

```json
{ "protocol": "sqlite", "config": { "filename": "./app.db", "native": true, "allowWrite": false } }
```

缺 `pg` / `mysql2` / `better-sqlite3` → `E_UNSUPPORTED`（提示 `npm i …`）。`native:true` 且无 `url`（postgres/mysql）→ `E_INVALID_CONFIG`。可选 `poolMax`（>1 走 `pg.Pool` / `mysql2.createPool`）、`ssl` / `rejectUnauthorized`、`statementTimeoutMs`（超时 `E_TIMEOUT` 并请求 cancel）。**CI 仍无** Postgres/MySQL 镜像；不是证书轮换。

## MongoDB / Elasticsearch / ClickHouse / Neo4j / Qdrant

可注册 MVP：CI `simulator: true` 内存实现。ClickHouse 有 `url` 时走 HTTP POST（`FORMAT JSONEachRow`）；INSERT/DDL 仍 `allowWrite`。Mongo：无 `url` / `simulator` 仍诚实内存；`url` 走 **OP_MSG** 子集（hello / find / insert / listCollections；自写 BSON，无官方驱动、无 aggregation）。Elasticsearch / OpenSearch：`url` 走 HTTP `_cat/indices` + `_search` + `_doc`。Neo4j：`http(s)` 走 `/db/{db}/tx/commit`；`bolt://` 仍 `E_UNSUPPORTED`（需注入）。Cassandra：无 host 内存 CQL；`host`/`url` 走 native v4 STARTUP/QUERY。CouchDB：`_all_dbs` / `_all_docs` / GET / PUT。写入一律 `allowWrite`。向量库选择 **Qdrant**（未做 ChromaDB）。

## SQL 门面（Thin，不推荐新集成）

```json
{ "driver": "sqlite", "filename": ":memory:", "allowWrite": false }
```

## S3 / MinIO

```json
{ "bucket": "artifacts", "endpoint": "memory://", "allowWrite": false }
```

`list` / `get` 只读默认可用。`put` / `delete` 需要 `allowWrite: true`。

- `memory://`（默认 CI）
- `unsigned: true` + endpoint：MinIO path-style，不签名
- `accessKey` + `secretKey` + endpoint：**AWS SigV4**（path-style；`region` 默认 `us-east-1`）。hermetic fake 校验 Authorization。无预签名 URL、无 session token、无 chunked upload。

## Prometheus

```json
{ "url": "http://127.0.0.1:9090", "timeoutMs": 2500, "allowWrite": false }
```

`query` → `GET /api/v1/query`；`query_range` → `GET /api/v1/query_range`。`remote_write` → `POST /api/v1/write`（protobuf WriteRequest + unframed snappy；需 `allowWrite: true`）。`simulator:true` 走内存序列，query 只按 `__name__` / 裸 metric 名过滤，**不是 PromQL 引擎**。经 `fetchSafe`（SSRF）。超时映射 `E_TIMEOUT`，PromQL/HTTP 错误映射 `E_PROTOCOL`。

## GCS

```json
{ "bucket": "artifacts", "endpoint": "memory://", "allowWrite": false }
```

Tools 与 S3 相同：`list` `get` `put` `delete`。`unsigned: true` 走 GCS JSON API 子集。`token` / `accessToken` + endpoint 加 **`Authorization: Bearer`**（无 refresh / 服务账号 JWT）。Discovery：单主机 **4443** `GET /storage/v1/b` 认 `storage#buckets`。

## Aliyun OSS

```json
{ "bucket": "artifacts", "endpoint": "memory://", "allowWrite": false }
```

同样 `list` `get` `put` `delete`。`unsigned: true` 走 path-style REST。`accessKey` + `secretKey` 走 **`Authorization: OSS AccessKeyId:Signature`**（HMAC-SHA1，Date + Content-Type + resource）。Discovery：HTTP 响应带 `x-oss-request-id` 或 `AliyunOSS`（单主机，禁 CIDR）。

## InfluxDB

```json
{ "bucket": "metrics", "org": "local", "url": "memory://", "allowWrite": false }
```

- `write_points`：line protocol（`lines`）或 `{ measurement, tags?, fields, timestamp? }[]`；需 `allowWrite: true`
- `delete_points`：`POST /api/v2/delete`；`start`/`stop` + `_measurement="…" AND tag="…"` 谓词子集；需 `allowWrite: true`
- `query`：**Flux**（`flux` / `query`）。内存后端不是 Flux 引擎，只按 `from(bucket:"…")` 与 `_measurement == "…"` 过滤
- **不做 InfluxQL**（1.x `/query`）
- HTTP：`POST /api/v2/write`、`POST /api/v2/delete`、`POST /api/v2/query`；可选 `token` → `Authorization: Token`
- Discovery：单主机 **8086** `/health`（body 含 `influxdb`）或 `/ping` 的 `X-Influxdb-Version`

## SNMP（Implemented — SNMPv2c 子集）

```json
{ "host": "127.0.0.1", "port": 161, "community": "public", "allowWrite": false }
```

`get` / `get_next` / `walk`（最多 32）只读。`set` 写 octet string，需 `allowWrite: true`。`simulator:true` 或无 host → 内存 MIB（sysDescr/sysObjectID/sysUpTime）。UDP 走真实 BER。**不是 SNMPv3 / USM / Trap 订阅。**

## WebDAV（Implemented — 子集）

```json
{ "url": "http://127.0.0.1:8080/dav", "allowWrite": false }
```

`propfind` / `get` 只读。`put` / `delete` / `mkcol` 需 `allowWrite`。无 url 或 `simulator:true` → 内存 VFS。HTTP 走 `fetchSafe`。**CalDAV / CardDAV 见独立协议 id。**

## FTP（Implemented — 控制通道 + PASV）

```json
{ "host": "127.0.0.1", "port": 21, "allowWrite": false }
```

`list` / `retr` 只读。`stor` / `dele` 需 `allowWrite`。无 host 或 `simulator:true` → 内存文件表。线上 USER/PASS + PASV。**不是 SFTP，不是 FTPS。**

## etcd（Thin — v3 HTTP KV）

```json
{ "url": "http://127.0.0.1:2379", "allowWrite": false }
```

`range`（可选 prefix）只读。`put` / `delete` 需 `allowWrite`。键值 UTF-8，线上走 `/v3/kv/range|put|deleterange`（base64）。**无 watch / lease / election / gRPC。**

## IMAP（Thin — IMAP4rev1 读优先）

```json
{ "host": "127.0.0.1", "port": 143, "allowWrite": false }
```

`list_mailboxes` / `select` / `fetch` / `search` 只读。`append` / `store_delete` / `expunge` 需 `allowWrite`。无 host 或 `simulator:true` → 内存 INBOX。**不是 SMTP 发信，不是 IDLE / QRESYNC / IMAPS-only。**

## POP3（Thin — 读优先）

```json
{ "host": "127.0.0.1", "port": 110, "allowWrite": false }
```

`stat` / `list` / `retr` 只读。`dele` / `rset` 需 `allowWrite`。**不是 SMTP。**

## Consul（Thin — HTTP API）

```json
{ "url": "http://127.0.0.1:8500", "allowWrite": false }
```

`kv_get` / `catalog_services` / `health_service` 只读。`kv_put` / `kv_delete` 需 `allowWrite`。可选 `X-Consul-Token`。**无 Connect / intentions。**

## Azure Blob（Thin — REST 子集）

```json
{ "container": "data", "endpoint": "http://127.0.0.1:10000", "unsigned": true, "allowWrite": false }
```

`list` / `get` 只读。`put` / `delete` 需 `allowWrite`。认证三选一：`unsigned:true`、`sasToken`（原样挂查询串，不本地签名）、`accountKey`（SharedKey HMAC-SHA256 **子集**：VERB + x-ms-date/version + `/account/container[/blob]`）。缺凭据 `E_UNSUPPORTED`。

## SMTP（Implemented — 发信边界）

```json
{ "host": "127.0.0.1", "port": 587, "from": "bot@example.com", "allowWrite": false }
```

`noop` 只读（EHLO 探活）。`send_mail` 需 `allowWrite`。`raw:true` 走 EHLO / MAIL / RCPT / DATA（不是 nodemailer MIME 全集）。`starttls:true` 仅当对端 EHLO 广告 `STARTTLS`；未广告则 `E_UNSUPPORTED` 并关掉套接字。同 socket 真 TLS 握手在 CI 易挂，**不作为验收**。**不是 IMAP/POP3，不代收信。**

## SFTP（Implemented — SSH-2 子系统）

```json
{ "host": "127.0.0.1", "port": 22, "user": "e2mcp", "password": "sftp", "allowWrite": false }
```

`list` / `get` 只读。`put` / `delete` 需 `allowWrite`。客户端为 **`ssh2`**（CJS `createRequire`）。无 host 或 `simulator:true` → 内存文件表。**不是 FTP，不是 FTPS。** Discovery 认 TCP 22 首包 `SSH-2.0-`。

## Memcached（Implemented — 文本协议）

```json
{ "host": "127.0.0.1", "port": 11211, "allowWrite": false }
```

`get` / `stats` 只读。`set` / `delete` 需 `allowWrite`。无 host 或 `simulator:true` → 内存 KV。线上 `GET`/`SET`/`DELETE`/`stats`。Discovery 认 11211 `STAT `。

## TFTP（Thin — RFC1350）

```json
{ "host": "127.0.0.1", "port": 69, "allowWrite": false }
```

`get`（RRQ）只读。`put`（WRQ）需 `allowWrite`。octet 模式；同一 UDP 4-tuple 会话。**不是 FTP/SFTP。** Discovery 认 UDP 69 RRQ → DATA 或 ERROR。

## CalDAV（Implemented — RFC4791 子集）

```json
{ "url": "http://127.0.0.1:5232", "allowWrite": false }
```

`propfind` / `report`（calendar-query，可选 text-match + `c:time-range`）/ `freebusy`（free-busy-query 子集）/ `get` 只读。`put` / `delete` / `mkcalendar` 需 `allowWrite`。`schedule`（完整 iTIP REQUEST/REPLY）为 `E_UNSUPPORTED`。无 url 或 `simulator:true` → 内存日历。HTTP 走 PROPFIND/REPORT。Discovery：OPTIONS `DAV: calendar-access`（含 5232）。

## CardDAV（Implemented — RFC6352 子集）

```json
{ "url": "http://127.0.0.1:5232", "allowWrite": false }
```

`propfind` / `report`（addressbook-query）/ `get` 只读。`put` / `delete` / `mkcol` 需 `allowWrite`。Discovery：OPTIONS `DAV: addressbook`。

## Beanstalkd（Implemented — 文本协议）

```json
{ "host": "127.0.0.1", "port": 11300, "allowWrite": false }
```

`stats` / `list_tubes` / `peek` 只读。`put` / `reserve` / `delete` 需 `allowWrite`（reserve 会改 ready 队列）。Discovery：11300 `stats` → `OK `。

## ZooKeeper（Thin — 四字 + 二进制子集）

```json
{ "host": "127.0.0.1", "port": 2181, "allowWrite": false }
```

`ruok` / `exists` / `get` / `get_children` / `watch_once`（GETDATA watch=1，一次性）只读。`create` / `set` / `delete` / `multi` 需 `allowWrite`。线上先 CONNECT 再 opcode。`set_acl` / `add_auth`（ACL / SASL）为 `E_UNSUPPORTED`。Discovery：2181 `ruok` → `imok`。

## DNS（Thin — 单播查询）

```json
{ "host": "127.0.0.1", "port": 53, "allowWrite": false }
```

`query`（`name` + `A|AAAA|TXT|PTR`）。`simulator:true` 或无 host → 内存记录。线上 UDP 单主机。**不是 AXFR，不是 mDNS 组播，不是 DNS-SD 浏览**（5353 仍走 `mdnsUnicastQuery`）。

## Cassandra（Thin — CQL 子集）

```json
{ "host": "127.0.0.1", "port": 9042, "allowWrite": false }
```

`list_keyspaces` / `list_tables` / `describe` / `cql`。内存或 native protocol v4 STARTUP/READY + QUERY/RESULT。**不是** prepared / batch / LWT / 完整 native 栈。写语句需 `allowWrite`。

## CouchDB（Thin — HTTP 文档）

```json
{ "url": "http://127.0.0.1:5984", "allowWrite": false }
```

`list_dbs` / `all_docs` / `get` / `put`。**不是** `_changes` / 附件 / `_bulk_docs`。`put` 需 `allowWrite`。

## Whois（Thin — TCP 43）

```json
{ "host": "127.0.0.1", "port": 43 }
```

`query` 只读。无写工具。

## Solr（Thin — HTTP select/update）

```json
{ "url": "http://127.0.0.1:8983", "allowWrite": false }
```

`list_cores` / `select`（`*:*` 或 `field:value`）/ `update`。**不是** SolrCloud collections admin / schema API。`update` 需 `allowWrite`。

## RabbitMQ management（Thin — HTTP `/api`）

```json
{ "url": "http://127.0.0.1:15672", "vhost": "/", "allowWrite": false }
```

`list_queues` / `list_exchanges` 只读。`publish` / `get`（ack_requeue_false）需 `allowWrite`。**这不是 AMQP 0-9-1**；线协议 publish/consume/ack 仍用 `protocol=amqp` 端口 5672。

## Kubernetes（Thin — 只读 API）

```json
{ "url": "http://127.0.0.1:6443", "namespace": "default" }
```

`list_pods` / `get_pod` / `list_services` / `get_service` / `list_configmaps` / `get_configmap`。`exec` / `apply` **恒** `E_UNSUPPORTED`（不是写闸可开）。别名 `k8s`。无 watch / 无 CRD。

## Planned leftover

仍不做：Kafka cooperative rebalance / 真事务协调器（hermetic ≠ 集群）、SQL CI 镜像（本环境无 Docker）、LDAP GSSAPI、gRPC remount 失败后的自动 mcp_update、SMTP 同 socket 真 TLS 握手（广告/拒绝已测）、mDNS 组播浏览、Mongo aggregation、PromQL 真引擎、CalDAV 完整 iTIP、ZooKeeper ACL/SASL、Neo4j 完整 Bolt、OPC-UA 完整 Subscription 服务集。新协议按 `src/adapters/<id>/` 注册即可。

## 如何再加一种协议

1. `src/adapters/<id>/index.ts` 实现 `ProtocolAdapter`
2. `registerAdapterFactory` 登记稳定 protocol id（`src/adapters/index.ts` + `packs.ts`）
3. `examples/` + hermetic `tests/`
4. 更新本表状态
