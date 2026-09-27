# Roadmap — 按阶段顺序推进

**当前状态：Phase X（Partner 热集成 + Compat Catalog + native 应用适配器）已落地。** 南向不是 MCP-by-default。下一阶段等用户明确 continue。不重开安全决策。

产品目标：把尽可能多的协议变成 MCP tools，并让 Agent **自动发现、建议、一键注册**。  
约束（全程有效）：**Agent 工具禁止网段 / CIDR 扫描**（控制台私网自动发现除外，见「控制台改版」）；**SSRF 拦截云 metadata / link-local**；数据面 **默认 `allowWrite=false`（只读）**；**Full 仍执行黑名单**；**Full ≠ 全局写**；无 shim；transport 合同不变。

P0–P6 与后续 Phase F–U 都是**已完成历史**（下方勾选保留）。未完成上一阶段验收项时，**不跳阶段、不堆无关协议**。测试与功能并行：每个引擎至少 `config validation` + `success` + `failure`（含 `allowWrite=false`）。当前测试基线见 [RELEASE_NOTES.md](RELEASE_NOTES.md) / [AUDIT.md](AUDIT.md)（Phase X：**133 suites / 545 tests**）。

---

## P0 — 收尾与测试基线

- [x] 删除 `src/core` / `src/management` shim（证明：`tests/p0-baseline.test.ts`）
- [x] 加厚 opcua / fix / coap / nats / ldap / asyncapi / sparkplug（各有 `tests/*-adapter.test.ts`）
- [x] 每个已有 adapter：config validation + success + failure（`validate.test.ts` + `adapter-contract.test.ts`）
- [x] discovery SSRF / timeout 回归（`ssrf.test.ts` + `discovery-scan.test.ts`）
- [x] catalog hot-reload（`catalog-hot-reload.test.ts`）

验收：`npm run build && npm test` 绿。不再重新引入 shim。

---

## P1 — 数据面多引擎（顺序固定；sqlite 真文件，其余 mock）

- [x] `sqlite` — `node:sqlite`；磁盘文件；默认只读（`tests/p1-sqlite.test.ts`）
- [x] `postgres`（别名 `pg` / `postgresql`）— simulator + 注入；live 无 `pg` → `E_UNSUPPORTED`（`tests/p1-postgres.test.ts`）
- [x] `mysql` / `mariadb` — 同上（`tests/p1-mysql.test.ts`）
- [x] `duckdb` — simulator；无 duckdb 包 → `E_UNSUPPORTED`（`tests/p1-duckdb.test.ts`）
- [x] `sqlserver` — simulator；无 TDS 客户端（`tests/p1-sqlserver.test.ts`）
- [x] `mongodb` — 内存；`insert_one` 负例（`tests/p1-mongodb.test.ts`）
- [x] Redis 增强 hash / list / stream；写路径需 `allowWrite`（`tests/redis-adapter.test.ts`）
- [x] `elasticsearch` / `opensearch`（`tests/p1-elasticsearch.test.ts`）
- [x] `clickhouse`（`tests/p1-clickhouse.test.ts`）
- [x] `neo4j`（`tests/p1-neo4j.test.ts`）
- [x] `qdrant`（选 Qdrant，**不做 ChromaDB**）（`tests/p1-qdrant.test.ts`）
- [x] 可选 `sql` driver 门面（`tests/p1-sql-facade.test.ts`）
- [x] discovery 端口指纹 5432/3306/1433/27017/9200/8123/7687/6333/6379，suggest `allowWrite: false`

---

## P2 — 对象存储与可观测

- [x] `s3` / MinIO：`list` `get` `put` `delete`；默认 `allowWrite=false`；内存 + unsigned path-style HTTP + **SigV4**（`accessKey`/`secretKey`）（`tests/s3-adapter.test.ts`）
- [x] `prometheus`：instant + range + **remote_write**（protobuf+snappy）；mock HTTP；`E_PROTOCOL` / `E_TIMEOUT`（`tests/prometheus-adapter.test.ts`）
- [x] discovery 指纹 9000（MinIO）/ 9090（Prometheus）；仍禁止网段扫
- [x] gcs / oss / influx（内存 + unsigned HTTP mock；GCS **Bearer token**；OSS **AccessKey HMAC-SHA1**；默认 `allowWrite=false`；discovery 4443/8086 + OSS HTTP 头）

---

## P3 — 工业总线

- [x] bacnet 加厚：Who-Is/I-Am codec、`read_property`、`list_objects`、`write_property`；默认 `allowWrite=false`（`tests/bacnet-adapter.test.ts`）
- [x] BACnet/IP UDP **unicast** Who-Is / I-Am（BVLC Original-Unicast-NPDU `0x0A`；**不**发 Original-Broadcast、**不**扫网段）；discovery 指纹 **47808**
- [x] OPC-UA `subscribe_once`（simulator one-shot，非 monitored-item；`tests/opcua-adapter.test.ts`）
- [x] Modbus FC15 Write Multiple Coils / FC16 Write Multiple Registers / FC23 Read/Write Multiple Registers；**RTU**（CRC16 + `mode: "rtu"` + virtual serial / memory duplex）；编解码单测 + `allowWrite=false` 负例（`tests/modbus-adapter.test.ts`）
- [x] EtherNet/IP / S7 / MTConnect（P6 之后的工业积压；见下节，不是重开 P0–P6）

验收：`npm run build && npm test` 绿。P4 消息 / RPC 见下。

---

## P4 — 消息 / RPC 补全

- [x] schema_import 负例 / OpenAPI `servers` 反推（`tests/schema-import.test.ts`）
- [x] JSON:API / OData / tRPC / Connect-RPC 识别为 **import-first**（导出 OpenAPI 再导入；无独立 adapter）
- [x] `sqs` 内存 + unsigned JSON HTTP mock：`list_queues` `send` `receive` `delete`；默认 `allowWrite=false`（`tests/sqs-adapter.test.ts`）
- [x] Kafka 消费组最小 `consume_once` + 只读 `group_status`（`groupId` 偏移；one-shot join，**无** cooperative rebalance；`tests/kafka-adapter.test.ts`）
- [x] AMQP RPC request/reply（`correlationId` + `replyTo`；`tests/amqp-adapter.test.ts`）
- [x] MQTT 5 `$share/{group}/{filter}` 匹配（`tests/mqtt-adapter.test.ts`）
- [x] gRPC unary + server/client/one-shot **bidi** + **session bidi**（`bidi_open` / `bidi_send` / `bidi_recv` / `bidi_close` / `bidi_status`；取消 / 背压 pause / `maxMessages` / `E_TIMEOUT`；写侧仍 `allowWrite`）+ reflection v1→v1alpha + 自定义 PEM + `tlsWatch` 进程内 remount（**无** CI 内 mTLS 握手）（`tests/grpc-adapter.test.ts`）
- [x] Sparkplug 官方 protobuf Payload（Eclipse Tahu `sparkplug_b.proto`；默认 protobuf，json-compat 为 fallback；**Template / DataSet / PropertySet** metric 往返；`tests/sparkplug-adapter.test.ts`）
- [x] Pulsar 内存 + unsigned JSON HTTP + **官方 PulsarApi**（`pulsar://` / `pulsar+ssl://` 子集：CONNECT / PRODUCER / SEND / SUBSCRIBE / FLOW / MESSAGE / ACK / GetTopicsOfNamespace；嵌入式 fake，非 testcontainers）+ **e2p1** 方言（`dialect: e2p1`）（`tests/pulsar-adapter.test.ts`）

验收：`npm run build && npm test` 绿。P5 agent e2e 见下。

---

## P5 — Agent 自主权 + e2e

- [x] 专用 e2e：`mcp_plan_bridge` → `discovery_scan_host` → `mcp_add_from_discovery` → `mcp_health` / `mcp_explain_tool`（另含 `schema_import`；`tests/p5-golden-path.test.ts`）
- [x] 工具分层：`_meta.layer` = `management` | `business`；`mcp_list { layer }` 默认只列业务 tools，避免把管理面冲进 Agent 上下文
- [x] `mcp_plan_bridge` / `mcp_health` 缺配置与空注册表时给出 **hints**（含 allowWrite=false 提醒）
- [x] plan 输出 `policy.allowWriteDefault=false` / 禁止 CIDR

验收：`npm run build && npm test` 绿。P6 SSE / HTTP transport 见下。

---

## P6 — 传输、错误码、审计

- [x] Streamable HTTP + 遗留 SSE MCP transport（官方 `@modelcontextprotocol/sdk`；stdio 仍为默认）（`tests/p6-http-transport.test.ts`）
- [x] 配置 / 文档：`EVERYTHING2MCP_TRANSPORT=stdio|http|sse`、端口、可选 token header
- [x] 统一错误码文档（`docs/ERRORS.md`）+ 适配器 invoke success/fail 计数（`mcp_health.invokeAudit`）
- [x] 无 shim 回流（P0 守门；`http.ts` stub 已删除）

---

## 工业积压（P6 之后；不重开 P0–P6）

- [x] `ethernetip`（别名 `enip`）：CIP List Identity + 本地 `read_tag`；默认 `allowWrite=false`；可选 TCP 44818（`tests/ethernetip-adapter.test.ts`）
- [x] `s7`：ISO-TCP/S7comm Read Var 子集（DB/M/I/Q）；默认只读（`tests/s7-adapter.test.ts`）
- [x] `mtconnect`：HTTP `/probe` `/current` + XML fixture（`tests/mtconnect-adapter.test.ts`）
- [x] discovery 单主机指纹：44818 EtherNet/IP List Identity、102 S7 COTP CC、5000/80 MTConnect `/probe`（禁止网段/广播）

## 债项修补（不重开新协议）

- [x] RPC 写闸启发式（jsonrpc / xmlrpc / soap / grpc 只读动词放行，未知 fail-closed）
- [x] Sparkplug connect 默认不再设 MQTT LWT NDEATH
- [x] GraphQL `query` 只认操作级 mutation/subscription（忽略注释/字符串）
- [x] discovery 指纹 Kafka 9092 / AMQP 5672 / OPC-UA 4840
- [x] 合同测试补 grpc / modbus / jsonrpc / xmlrpc / graphql hermetic

## P2 大债（部分落地）

- [x] 官方 Apache PulsarApi 二进制子集 + `pulsar+ssl://`（TLS `tlsInsecure`；CONNECT 可选 token/JWT；LOOKUP 跟跳 + owner hop；**PARTITIONED_METADATA** + `-partition-N` 路由 / 父 topic fan-in；inbound batch 展开；chunk uuid 重组≤8；official outbound batch / `chunks[]` / **`chunk:true` UTF-8 切分**）
- [x] gRPC 长连接 session bidi（open/send/recv/close；`tlsWatch` 热重读 PEM 并进程内 remount ChannelCredentials；bidi session 会断）
- [x] Sparkplug Template / DataSet / PropertySet metric 编解码 + Host Application MVP（retain STATE + rebirth NCMD）
- [x] Modbus RTU（CRC16 + virtual serial；无捆绑 `serialport`）
- [x] 对象存储真签名：S3 SigV4、GCS Bearer、OSS AccessKey（仍保留 unsigned/memory）
- [ ] Kafka cooperative rebalance / **真** static membership / **事务/EOS**（Phase I：hermetic `InitProducerId` 状态机 + 内存 static-member 旗；**live KafkaJS 事务 tool 仍 `E_UNSUPPORTED`**；`idempotent` ≠ EOS）
- [x] Live SQL **可选** native 路径（`pg` / `mysql2` / `better-sqlite3` 动态 import；CI 仍 mock；缺包 `E_UNSUPPORTED`）— Phase I 加深 pool/SSL/statement timeout；**无** CI 镜像
- [x] LDAP add/modify/delete + allowWrite（hermetic mock）
- [x] FIX 会话当写：logon/logout/NOS 闸；encode/decode/status 只读
- [x] SMTP 25/587 指纹（`220` banner；单主机）
- [x] TLS PEM 共享加载 + `watchTlsMaterial` 文件 watch 热重读 + gRPC 进程内 remount

## W1 — Web Console（同进程）

- [x] 同进程挂载 `/ui` SPA + `/api/*` REST，复用 `callManagementTool` / catalog（`src/control/rest.ts`）
- [x] 页面：Dashboard / Adapters CRUD / Tools（business|management|all）/ Settings（只读）
- [x] API：`GET /api/health` `/api/adapters` `/api/adapters/:id` POST/PUT/DELETE、可选 ping、`GET /api/tools` `/api/tools/:name`
- [x] HTTP token 与 MCP 共用；密钥脱敏（`src/control/redact.ts`）
- [x] 深色 infra：`#0B0F14` / `#121820` / `#3DD6C6`；侧栏 + 顶栏胶囊 + 协议徽章 + 状态点
- [x] `npm run ui:build` 产物进 `dist/ui`；`npm run build` 一并构建
- [x] W1 不做 CIDR 扫描 UI；Discovery / Import / 试调用入口留给 W2（现已接通，见下）

验收：`tests/console-rest.test.ts` + `npm run build && npm test` 绿。

## W2 — Discovery / Import / 只读试调用

- [x] Discovery 向导 API+UI（`POST /api/discovery/scan|probe|suggest|register`）；单主机，拒绝 CIDR
- [x] Schema Import（`POST /api/import` → `schema_import`）
- [x] 只读试调用（`POST /api/tools/:name/invoke`）；写操作需 `confirm:true` 且仍受 `allowWrite`
- [x] 协议矩阵只读页（`GET /api/matrix`）
- [x] ~~CIDR 扫描 UI（明确不做）~~ → 控制台改版以「设置 → 自动发现」私网范围替代（L5 修订）
- [ ] 默认打开 allowWrite（**明确不做**）

## W3 — 审计时间线 + 计划桥

- [x] `GET /api/audit`：`invokeAudit` 计数 + 环形事件（tool / protocol / code）
- [x] 审计页：成功/失败时间线；空态引导试调用
- [x] `POST /api/plan` → `mcp_plan_bridge`；步骤可跳 Discovery / Import
- [x] Toast、窄屏汉堡菜单、空态 CTA
- [x] `GET /api/errors` 与协议矩阵 help 对齐（Phase E）

验收：`tests/console-w3.test.ts` + 全量绿。

## Phase F — 中等债（LDAP 写 / FIX 闸 / TLS / Kafka 诚实边界）

- [x] LDAP `add` `modify` `delete` + `allowWrite` + hermetic mock
- [x] FIX 写闸语义（会话 logon/logout 当写；文档 + 测试）
- [x] TLS：`tls-material` 共享加载；`mcp_update` 重连重读文件；`docs/TLS.md`
- [x] Kafka `group_status` 标明无事务 / 无生效 static membership / 无 cooperative rebalance
- [x] CONSOLE / ROADMAP 同步 W3 + 本阶段

大山只估工、不装完：Pulsar 分区 Redirect 路由、完整 live SQL 池/镜像、Kafka 完整 rebalance / EOS。

## Phase G — 大山诚实可测增量（不是完整产品）

- [x] Pulsar 官方 LOOKUP / LOOKUP_RESPONSE（type 23/24）；fake broker Connect / Failed / Redirect；Phase I **跟 Redirect（临时 hop，上限 `maxLookupRedirects`）**；失败码 `E_NOT_FOUND` / `E_PROTOCOL` / `E_UNSUPPORTED`
- [x] SQL `native:true` / `driver:"native"`：可选 `pg`、`mysql2`、`better-sqlite3`；CI 默认 simulator / `node:sqlite`；缺驱动友好 `E_UNSUPPORTED`
- [x] Kafka：事务 tool 一律 `E_UNSUPPORTED`；`transactionalId` 只记录；`idempotent` 可交给 KafkaJS（hermetic 测 flags）；**不是 EOS**
- [x] AUDIT / ROADMAP / PROTOCOLS 同步本阶段

仍是大山：真 SQL CI 镜像、Kafka JoinGroup / 真事务协调器、分区 metadata / batch。

## Phase H — 过夜收口（历史；已完成，其后由用户批准开了 I–U）

- [x] `docs/RELEASE_NOTES.md`：MVP → W1–W3 → F/G/H
- [x] AUDIT 已完成 / 仍开放优先级
- [x] README / CONSOLE 启动句对齐
- [x] Sparkplug Host STATE 只读订阅 stub（`host_state`；当时不是 Host Application；Host MVP 在 Phase J）
- [x] 全量 `npm run build && npm test` 绿

当时停在 H、不自动开 I。用户批准后已继续到 **Phase U**。不要把本段读成当前停点。

## Phase I — 三大山诚实增量（不是完整产品）

- [x] Pulsar LOOKUP **follow Redirect**（默认最多 3 跳；环/超限 `E_UNSUPPORTED`；死 hop `E_PROTOCOL`）；CONNECT 可选 `token` / `jwt` / `authToken`
- [x] Kafka hermetic `createHermeticKafkaHandle`：`InitProducerId` 状态机 + 内存 `group.instance.id` 旗；live KafkaJS 事务 tool 仍 `E_UNSUPPORTED`
- [x] SQL native：`poolMax` / `ssl` / `statementTimeoutMs`（注入 fake Client/Pool；**无** Postgres/MySQL CI 镜像）
- [x] AUDIT / ROADMAP / PROTOCOLS / RELEASE_NOTES 同步
- [x] 自动第二轮：LOOKUP 跟到 owner 后 **该 topic 的 publish/consume 改走 owner hop**（其它 topic 仍走原 session）

仍是大山：Docker 真库、Kafka 真 rebalance/EOS。

## Phase J — 分区 / 证书 watch / Host Application

- [x] Pulsar `PARTITIONED_METADATA`（type 37/38）报分区数；**不**路由 `-partition-N`；inbound batch 逐条展开；chunk / publish batch → `E_UNSUPPORTED`
- [x] `watchTlsMaterial`：文件变更热重读；删文件 `E_INVALID_CONFIG` 可测；gRPC `tlsWatch:true` 只刷新缓存
- [x] Sparkplug Host Application MVP：`host_online` / `host_offline`（retain STATE）+ `rebirth` NCMD；observer `host_state` 仍只读
- [x] Kafka hermetic `generation`（成员 instance 变化 +1）；**不是** cooperative rebalance / 真 EOS
- [x] SQL CI 真库：**跳过**（本环境无 Docker / 无 `pg` / 无 `mysql2`）
- [x] 自动第二轮：FIX 本地 outbox `resend_request`；LDAP SASL **PLAIN only**
- [x] AUDIT / ROADMAP / PROTOCOLS / RELEASE_NOTES / TLS 同步

## Phase K — 分区路由 / 活证 remount / 线上 SequenceReset

- [x] Pulsar `-partition-N` 路由（PARTITIONED_METADATA + hash key / round-robin）；父 topic consume fan-in；official outbound batch；inbound/outbound chunk uuid（最多 8 显式 `chunks[]`）；`chunk:true` 无 parts 仍 `E_UNSUPPORTED`
- [x] gRPC `tlsWatch` **进程内 remount** ChannelCredentials（不必 mcp_update；打开的 bidi 会断；失败才要 mcp_update）
- [x] FIX loopback：`resend_request` 线上 35=2 → SequenceReset 35=4 GapFill；本地 outbox + gaps 仍在
- [x] Kafka hermetic 诚实边界加深（`cluster.eos=false`）；真 rebalance/EOS **仍欠集群**
- [x] LDAP GSSAPI 保持 `E_UNSUPPORTED`（PLAIN only，无 stub）
- [x] SQL CI 真库：**跳过**（本环境无 Docker / 无 `pg` / 无 `mysql2`）
- [x] AUDIT / ROADMAP / PROTOCOLS / RELEASE_NOTES / TLS 同步
- [x] 自动第二轮：官方 `publish chunks[]` 多帧 outbound chunk（隐式 `chunk:true` 切分仍 `E_UNSUPPORTED`）

## Phase L — 隐式切分 / 诚实边界 / 文档债

- [x] Pulsar `chunk:true`：UTF-8 按 `chunkSize`（默认 256）切成最多 8 帧；单片不 chunk；超限 `E_UNSUPPORTED`；撕码点回退到字符边界
- [x] FIX `resend_request` 对 outbox 命中发 **PossDupFlag=Y**；loopback 忽略 43=Y
- [x] PROTOCOLS Redis：`publish` 与实现一致（写入闸）；控制台设置页写清 gRPC remount
- [x] AUDIT / ROADMAP / PROTOCOLS / RELEASE_NOTES 同步

## Phase M — 审查 / 查漏 / 设计补充

- [x] Agent `audience=console` 伪造无效；REST 强制 `actor.kind=console`
- [x] `mcp_explain_tool` / query / health 不再向 Agent 漏黑名单工具名或隐藏计数
- [x] `jwt` / `tlsKey` 脱敏（不泛化 `key`）
- [x] 设计补充：`docs/PHASE_M_REVIEW.md` + ADR 0002；ARCHITECTURE `schema_import` 不再写成 stub
- [x] 未再试 Kafka 真 EOS / SQL CI Docker / LDAP GSSAPI / v2/v3 / Agent challenge

## Phase N — 发现加厚 + 新协议 MVP

- [x] 单机发现：`/.well-known/openapi.json`；FTP 21 / SNMP 161 / etcd 2379 / WebDAV OPTIONS；**SSDP unicast M-SEARCH :1900**（禁止组播 / CIDR）
- [x] `mcp_plan_bridge` 认 snmp / ftp / webdav / etcd；建议默认 `allowWrite=false`
- [x] 新协议 hermetic MVP：`snmp`（SNMPv2c BER）`webdav` `ftp`（PASV）`etcd`（v3 HTTP KV）
- [x] 控制台发现页写清新指纹；协议矩阵随 `knownProtocols()` 自动对齐
- [x] 未再试 Kafka 真 EOS / SQL CI Docker / LDAP GSSAPI / v2/v3 / Agent challenge / SFTP / IMAP / Azure Blob

## Phase O — 协议覆盖 + 发现继续加厚

- [x] IMAP4rev1 读（LIST/SELECT/UID FETCH/SEARCH）+ APPEND/STORE/EXPUNGE `allowWrite`；不是 SMTP
- [x] POP3 STAT/LIST/RETR + DELE/RSET `allowWrite`；不是 SMTP
- [x] Consul HTTP KV / catalog / health；写闸
- [x] Azure Blob REST list/get；SharedKey HMAC-SHA256 子集或 SAS 查询串；写闸；无假客户端
- [x] ClickHouse 真 HTTP POST `query`（`FORMAT JSONEachRow`）；INSERT/DDL 仍闸；simulator 仍默认
- [x] DNS-SD / mDNS **单播** `host:5353`；组播 `224.0.0.251` 仍 `E_UNSUPPORTED` + 编解码单测
- [x] 指纹 + `mcp_plan_bridge` / `add_from_discovery` 金路径；控制台发现文案对齐
- [x] **跳过** Mongo live wire（无官方驱动；保持诚实内存）；**跳过** SFTP（无 ssh2；不把 FTP 冒充 SFTP）
- [x] 未再试 Kafka 真 EOS / SQL CI Docker / LDAP GSSAPI / v2/v3 / Agent challenge

## Phase P — SFTP / Mongo wire / SMTP 加厚 / Memcached / TFTP

- [x] **SFTP**：`ssh2` 真 SSH-2 子系统；内存 + loopback LIST/GET/PUT；写闸；**不是 FTP**
- [x] **MongoDB OP_MSG**：hello / find / insert / listCollections；BSON 子集 + TCP loopback；无 url 仍内存；无 aggregation
- [x] **SMTP**：raw EHLO/MAIL/RCPT/DATA loopback；`noop` 只读；`starttls:true` 若对端未广告则 `E_UNSUPPORTED`；发信仍 `allowWrite`；不是 IMAP/POP3
- [x] **Memcached** 文本 GET/SET/DELETE/STATS
- [x] **TFTP** RFC1350 RRQ/WRQ（不是 FTP/SFTP）
- [x] 指纹 22 / 11211 / 69 + plan_bridge；mDNS 组播仍 `E_UNSUPPORTED`
- [x] 未再试 Kafka 真 EOS / SQL CI Docker / LDAP GSSAPI / v2/v3 / Agent challenge

## Phase Q — CalDAV / CardDAV / Beanstalkd / ZooKeeper / Redis Streams

- [x] **CalDAV**：PROPFIND / REPORT calendar-query / GET / PUT / MKCALENDAR；写闸；HTTP loopback
- [x] **CardDAV**：PROPFIND / REPORT addressbook-query / GET / PUT；写闸；HTTP loopback
- [x] **Beanstalkd** 文本 put/reserve/delete/stats
- [x] **ZooKeeper**：四字 ruok + 二进制 connect/get/create/exists/getChildren 子集
- [x] **Redis Streams**：XGROUP CREATE / XREADGROUP / XACK（写闸）
- [x] SMTP STARTTLS：仍保持广告/拒绝边界（同 socket 真握手 CI 不稳，不硬凑）
- [x] 指纹 5232 / 11300 / 2181 + plan_bridge；mDNS 组播仍 `E_UNSUPPORTED`
- [x] 未再试 Kafka 真 EOS / SQL CI Docker / LDAP GSSAPI / v2/v3 / Agent challenge

## Phase R — Prometheus remote_write / ZK watch+multi / CalDAV time-range / Influx delete

- [x] **Prometheus remote_write**：WriteRequest protobuf + unframed snappy；`POST /api/v1/write`；写闸；内存 query 按 metric 名可读
- [x] **ZooKeeper**：一次性 `watch_once`（GETDATA watch=1）+ `multi` create/set/delete；ACL/SASL 诚实 `E_UNSUPPORTED`
- [x] **CalDAV**：`c:time-range` REPORT + `free-busy-query`；完整 iTIP `schedule` → `E_UNSUPPORTED`
- [x] **Influx**：`delete_points` → `/api/v2/delete`（谓词 + [start, stop)）；写闸
- [x] 指纹 9090 + plan_bridge `allowWrite=false`；控制台矩阵 help 对齐
- [x] 未再试 Kafka 真 EOS / SQL CI Docker / LDAP GSSAPI / v2/v3 / Agent challenge / GraphQL subscription / NFS / mDNS 组播

## Phase S — NATS JetStream / AMQP ack / OPC-UA monitored / GraphQL-WS / DNS

- [x] **NATS JetStream**：内存 simulator；`js_consumer_add` / `js_next` / `js_ack` / `js_nack`；interest filter；写闸
- [x] **AMQP 0-9-1**：内存 `get`/`ack`/`nack`（requeue）；publish/rpc/ack 写闸
- [x] **OPC-UA**：`create_monitored_item` + `wait_data_change`（内存 monitored-item）；`subscribe_once` 仍一次性
- [x] **GraphQL subscription**：graphql-ws（`wsUrl`）+ simulator `publish_event`；无 wsUrl → `E_UNSUPPORTED`
- [x] **DNS**：单播 A/AAAA/TXT/PTR；无 AXFR / 无组播
- [x] 指纹 53 + plan_bridge `allowWrite=false`；控制台矩阵对齐
- [x] 未再试 Kafka 真 EOS / SQL CI Docker / LDAP GSSAPI / v2/v3 / Agent challenge / Cassandra / CouchDB / Whois / Neo4j Bolt / NFS / mDNS 组播

## Phase T — Cassandra / CouchDB / Whois / Neo4j HTTP / ES HTTP

- [x] **Cassandra CQL**：内存 + native protocol v4 STARTUP/QUERY/RESULT 子集；写闸
- [x] **CouchDB HTTP**：`_all_dbs` / `_all_docs` / GET / PUT；写闸；HTTP loopback
- [x] **Neo4j HTTP transactional**：`POST /db/{db}/tx/commit`；Bolt 仍 `E_UNSUPPORTED`（无注入 connectFn）
- [x] **Whois**：TCP 43 只读 query；loopback
- [x] **Elasticsearch HTTP**：`_cat/indices` / `_search` / `_doc`；OpenSearch 同路径
- [x] 指纹 9042 / 5984 / 43 / 7474 + plan_bridge `allowWrite=false`；控制台矩阵对齐
- [x] 未再试 Kafka 真 EOS / SQL CI Docker / LDAP GSSAPI / v2/v3 / Agent challenge / Solr / RabbitMQ management / k8s / NFS / mDNS 组播

## Phase U — Solr / RabbitMQ management / Kubernetes 只读

- [x] **Solr HTTP**：`list_cores` / `select` / `update`；写闸；HTTP loopback
- [x] **RabbitMQ management**：`/api/queues` `/api/exchanges` publish/get；写闸；**不是** AMQP 0-9-1（线协议仍 `amqp`）
- [x] **Kubernetes**：只读 list/get pods/services/configmaps；`exec`/`apply` 恒 `E_UNSUPPORTED`；别名 `k8s`
- [x] Neo4j Bolt 仍 `E_UNSUPPORTED`（HTTP transactional 已在 Phase T）；OpenSearch 与 ES 同路径，只补文档
- [x] 指纹 8983 / 15672 / 6443 + plan_bridge `allowWrite=false`；控制台矩阵对齐
- [x] 未再试 Kafka 真 EOS / SQL CI Docker / LDAP GSSAPI / v2/v3 / Agent challenge / NFS / mDNS 组播

## Phase V — 最小核心 + 热加载 + 环境/平台

- [x] V0 文档：平面 vs 五包；最小核心；热加载状态机；非目标
- [x] V1 Capability Lifecycle：`catalog/lifecycle.ts`；`capability_register/unregister/configure`；控制台 `#/capabilities` 热加载+热卸载；与 `mcp_add`/`mcp_remove` 同一 Policy Gateway；auto 仅 Safe+readonly+非黑名单；boot 不批量注册；unregister 不要求 allowWrite
- [x] V2 `environment_inventory` 按需盘点（OS/权限/监听端口/运行时/容器/配置路径）；只产出 suggest
- [x] V3 平台只读：`os_info` `platform_fs` `platform_process` `platform_service`（Win+Linux 代码路径；macOS best-effort；缺工具 `E_UNSUPPORTED`）
- [x] V4 Docker Engine HTTP 只读 + journal 文件读（跳过 SMB/CIFS、Kafka EOS、NFS、LDAP GSSAPI）
- [x] V5 `allowWrite` / `allowShell` 闸；`shell_exec` / `docker run` 仍是 stub，不全局打开写
- [x] 未再试 Kafka 真 EOS / SQL CI Docker / LDAP GSSAPI / v2/v3 / Agent challenge / mDNS 组播

## Phase W — 能力积压 P1–P5（热加载，不在 boot 挂载）

- [x] P1 Docker/Podman `logs`；SMB2 NEGOTIATE MVP；journal export / Event XML；k8s `logs`；port/package/cloud suggest 质量
- [x] P2 Vault/OpenBao health+list keys（`allowReadSecrets` 默认关）；`aws_iam` 模拟器；IMDS 线索不取 169.254.169.254、suggest 不含密钥
- [x] P3 NFSv3 NULL ping + simulator exports；Kafka 仍是 one-shot `group_status`（**跳过真 EOS**）；SQS 已有；OpenSearch `cluster_health`；Alertmanager；Pub/Sub emulator
- [x] P4 Jira REST 只读；`browser` 头less stub（`allowDesktop` 默认关，打开也不启 Chrome）
- [x] P5 `allowWrite` / `allowShell` / `allowDesktop` 闸；扫描/suggest **从不**自动打开
- [x] 热卸载一等公民：`unregister` hook + 审计；控制台 `#/capabilities` 热卸载（confirm）；Agent `capability_unregister`；缺 id `E_NOT_FOUND`；可再热加载
- [x] 未再试 Kafka 真 EOS / SQL CI Docker / LDAP GSSAPI / v2/v3 / Agent challenge / mDNS 组播 / 完整 CIFS TREE_CONNECT / 真 journalctl/wevtutil

## Phase X — Partner 热集成 + Compat（已落地）

- [x] Partner protocol v1：Manifest JSON Schema、REST register/unregister/heartbeat、drops、Catalog `partner.{id}.{op}`
- [x] Demo `examples/partner-demo-chat/`（非 MCP）
- [x] SDK `sdk/partner`（Node）+ Python stub
- [x] 控制台 `#/partner`、ingress 徽章、本地 token
- [x] Compat Catalog + `compat_scan`（P0–P4；mcpServers = 兜底）
- [x] Native：feishu / dingtalk / wecom / slack / notion / github（sim + allowWrite 闸）
- [x] `mcp_bridge` 兜底（prefixed tools；live spawn `E_UNSUPPORTED`）
- [x] 个人微信 / 支付 / 个人 QQ：诚实非宣称

## 控制台改版（Console Redesign）

- [x] S1 每协议 `configSchema`（字段类型 / 必填 / oneOf / 密钥 / 高级）+ `GET /api/protocols`、`POST /api/protocols/:id/validate`、`POST /api/adapters/test`（不落盘的测试连接）
- [x] S2 UI：能力（当前能力 / 可支持能力 / 黑名单 三 tab + 摘要条）/ 活动 / 设置，旧页收进「高级」；schema 表单向导；能力启用开关（停用保留注册）；PUT 保留脱敏密钥
- [x] S3 黑名单三种粒度：目标 / 能力实例 / 工具 glob；v1 文件兼容
- [x] S4 私网自动发现：自动 / 手动 / 关闭；候选、一键启用、需要配置；有界 mDNS / SSDP 组播
- [x] S5 跨平台构建与测试脚本；去掉重复文档；报告 [CONSOLE_REDESIGN_REPORT.md](CONSOLE_REDESIGN_REPORT.md)

**约束放宽（用户批准）：** 「默认网段扫描」与「mDNS 组播浏览」从「明确不会做」移出，改为**只在控制台自动发现里**、按私网规则做（RFC1918 / CGNAT / 本机；网卡 ≤ /24；手动 ≤ /16；每轮主机上限；公网需 `allowPublic`；link-local 与云 metadata 永不扫描；组播 TTL=1 且只收私网应答者）。Agent 工具仍然只接受单主机，`ALLOW_SCAN` 仍是死变量。见 [SECURITY_ARCHITECTURE.md](SECURITY_ARCHITECTURE.md) L5 修订、[DISCOVERY.md](DISCOVERY.md#自动发现auto-discovery)。

## 当前停点

**Phase X + 控制台改版已落地。** 下一阶段 **pending user continue**。不要自动开下一协议宇宙 / 不要重开 Agent 侧 CIDR、`ALLOW_SCAN`、shim、全局写、Agent challenge、v2/v3 外部插件、部署时 bulk-register。不要把南向默认改成 MCP。

## 明确不会做

- 全端口扫描；Agent 工具扫网段（私网自动发现只在控制台，见上）
- adapters 引用 control / transport
- 重新引入 `src/core` / `src/management`
- ChromaDB
- 默认 `allowWrite=true` / shim
- Kafka **真** EOS / cooperative rebalance（需集群）
- SQL CI Docker 真库（本环境无 Docker）
- LDAP GSSAPI
- v2 本地 JS / v3 npm 外部安全模块真加载
- MCP Agent 写 challenge
- NFS **完整**客户端 / multicast SHOWMOUNT（NULL ping + simulator 已有）
- 部署时 bulk-register / 静默全局写 / 默认桌面控制
- `allowShell` 真 shell / `allowDesktop` 真浏览器
- SMB/CIFS **完整** TREE_CONNECT 文件客户端（NEGOTIATE + simulator 已有）
