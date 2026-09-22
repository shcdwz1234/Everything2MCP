# Everything2MCP 0.1 — 发布说明

从空仓库做到可跑的协议→MCP 桥 + 同进程 Web 控制台。默认 **stdio MCP**；HTTP 时同一进程挂 `/mcp`、`/sse`、`/ui`、`/api`。

**当前快照：Phase U 已落地。** 测试基线全量绿 **`110` suites / `477` tests**（Phase T 为 **106 / 467**）。下一阶段 **pending user continue**，不自动开新协议。本文件即变更记录（无单独 `CHANGELOG.md`）。

## 如何启动

```bash
npm install
npm run build
npm test

# 默认：stdio MCP（给 Cursor / Claude Desktop）
npm start

# 控制台 + Streamable HTTP + 遗留 SSE（推荐本地看 UI）
EVERYTHING2MCP_TRANSPORT=http EVERYTHING2MCP_HTTP_PORT=8742 npm start
```

浏览器打开 **http://127.0.0.1:8742/ui/**（`GET /` 会 302 到 `/ui/`）。  
可选 `EVERYTHING2MCP_HTTP_TOKEN`，顶栏胶囊贴同一 token。`GET /health` 与 `/ui` 不鉴权。

详见 [CONSOLE.md](CONSOLE.md)。产品约束：[ROADMAP.md](ROADMAP.md)。协议边界：[PROTOCOLS.md](PROTOCOLS.md)。债：[AUDIT.md](AUDIT.md)。

## 用户可见能力（按时间）

### MVP / P0–P6

- 热注册 catalog：`mcp_add` / `mcp_update` / `mcp_remove`，持久化 JSON，热重载
- MCP **stdio**（默认）+ **Streamable HTTP** `/mcp` + 遗留 **SSE** `/sse`
- 分层 tools：`management` vs `business`；`mcp_plan_bridge` 带 hints
- 单主机 discovery（禁止 CIDR）；SSRF 拦 metadata / link-local
- 数据面默认 **`allowWrite=false`**
- 协议面：OpenAPI/HTTP、MQTT、SOAP、gRPC（含 session bidi）、GraphQL、AMQP、Kafka（one-shot）、WebSocket、JSON-RPC、XML-RPC、FIX、Redis、SMTP、LDAP、OPC-UA、Modbus（TCP+RTU）、CoAP、NATS、BACnet unicast、EtherNet/IP、S7、MTConnect、SQS、Pulsar（内存 / unsigned HTTP / 官方 PulsarApi / e2p1）、S3/GCS/OSS、Prometheus、Influx、Sparkplug B protobuf、关系型（sqlite 真引擎 + 其余 simulator）

### 控制台 W1–W3

| 波次 | 用户能做什么 |
| --- | --- |
| **W1** | 同进程 `/ui` SPA + `/api/*`；Dashboard / Adapters CRUD / Tools / Settings；密钥脱敏；深色 infra |
| **W2** | Discovery 向导、Schema Import、只读试调用（写要 `confirm:true`）、协议矩阵 |
| **W3** | `#/audit` 调用时间线、`#/plan` 计划桥、`GET /api/errors`、SMTP 25/587 指纹 |

没有 CIDR 扫描 UI。写操作永远还要适配器 `allowWrite`。

### Phase F（中等债）

- LDAP `add` / `modify` / `delete` + 写闸（hermetic）
- FIX：`logon` / `logout` / NOS 当写；encode/decode/status 只读
- TLS：共享 PEM 加载；`mcp_update` **reconnect 重读文件**（无 watch）
- Kafka：`group_status` 诚实标明无事务 / 无生效 static membership

### Phase G（大山的诚实增量，不是完整产品）

- Pulsar **LOOKUP** 命令/响应（Connect / Failed / Redirect）；当时 **不 chase Redirect**（Phase I 已跟跳）
- SQL `native:true`：可选动态 `pg` / `mysql2` / `better-sqlite3`；缺包 `E_UNSUPPORTED`；CI 仍 mock
- Kafka：事务 tool 一律 `E_UNSUPPORTED`；`idempotent` 只是 KafkaJS producer 标志，**不是 EOS**

### Phase H（收口）

- 本文件 + AUDIT 优先级刷新
- README / CONSOLE 启动句对齐
- Sparkplug **Host STATE 只读订阅 stub**（`spBv1.0/STATE/{hostId}` JSON）；不是 Host Application

### 黑名单

- `dataDir/blacklist.json` 与 registrations 同级；匹配键 `canonical protocol + 规范化 host + port`（或规范化 url），见 [BLACKLIST.md](BLACKLIST.md)
- `mcp_add` / POST `/api/adapters` / 发现一键注册命中则 `E_BLACKLISTED`（403）；已挂载实例 invoke 同样拒绝
- Discovery 候选标记 `blacklisted`，suggestions 省略；控制台 `#/blacklist` + Discovery「加入黑名单」
- MCP：`mcp_blacklist_list` / `mcp_blacklist_add` / `mcp_blacklist_remove`；REST：`GET/POST/DELETE /api/blacklist`
- **没有 CIDR 扫描**

### S1 安全平面

- `src/control/security/`：deny-wins 网关；`safe`/`full` 热切换写入 `security.json`；审计 `mode_change`
- Full **仍执行** `builtin-blacklist`（`bypassInFullControl=false`）；`allow-write` / `dangerous-tools` / `rate-limit` 可在 Full 跳过平面层（适配器写闸仍在）
- CIDR 永不放行（`core-integrity` + `discovery-scope` + `assertHostProbeAllowed`）
- Agent `tools/list` / `mcp_list` 隐藏已拉黑业务 tools；控制台列表仍可见
- `#/security` + `GET/PUT /api/security/mode`（`confirm:true`）；模式不是 MCP tool
- v1 只加载 builtin；`inject`/`replace` 非 builtin → `E_UNSUPPORTED`
- 见 [SECURITY_ARCHITECTURE.md](SECURITY_ARCHITECTURE.md)

### S1 R4

- `core-integrity`：`dataDir/integrity.json` 对 `security.json` / `blacklist.json` 做 SHA-256 账本（首次见到即封存；错哈希 / 封后丢失 → `E_UNSUPPORTED`）。**不是 HMAC**
- `GET /api/security` 带 `integrity` 快照与 `fullDoesNotEnableWrite`
- `EVERYTHING2MCP_DISCOVERY_ALLOW_SCAN` **死变量**：env 与 `discovery.allowScan` override 都不能打开 CIDR
- 文档锁定 **Full ≠ 全局写**：平面 `allow-write` 可 bypass；适配器 `assertCanWrite` 不 bypass
- Agent `tools/list` / `mcp_list` 默认 audience=`agent`；`GET /api/tools` 固定 `console`

### S2 加固

- 可选 HMAC-SHA256：`EVERYTHING2MCP_INTEGRITY_KEY` 或 `dataDir/.integrity-key`；账本带 `mac`。无密钥保持 SHA-256
- `registrations.json` 纳入完整性账本
- `dataDir/audit.jsonl` 追加写入，启动重载；`#/audit` 读持久化；密钥字段脱敏
- `rate-limit` 滑窗（默认 60 invoke / 20 discover 每分钟）；Full 跳过
- `secret-redact` 成为内置模块；`tls-material` 当时仅预留 register 钩子（**文件 watch + gRPC remount 在 Phase J/K 落地**，见 [TLS.md](TLS.md)）

### Phase I（三大山诚实增量）

- Pulsar LOOKUP **follow Redirect**（默认 3 跳；环/超限 `E_UNSUPPORTED`；死 hop `E_PROTOCOL`）；CONNECT 可选 `token` / `jwt` / `authToken`
- 跟到 owner 后 **该 topic 的 publish/consume 改走 owner hop**（其它 topic 仍走原 session）
- Kafka hermetic `InitProducerId` 状态机 + 内存 static-member 旗；**live KafkaJS 事务 tool 仍 `E_UNSUPPORTED`**
- SQL native：`poolMax` / `ssl` / `statementTimeoutMs`（注入 fake；**无** CI 镜像）

### Phase J

- Pulsar **PARTITIONED_METADATA**（只报分区数）；inbound **batch** 逐条展开；**chunk** / publish batch → `E_UNSUPPORTED`
- `watchTlsMaterial` 文件 watch 热重读（删文件可测失败）；gRPC 活连接仍要 `mcp_update`
- Sparkplug Host Application MVP：retain `host_online`/`host_offline` + `rebirth` NCMD
- Kafka hermetic `generation`（不是 cooperative rebalance）
- SQL CI 真库：**跳过**（无 Docker / 无 `pg` / 无 `mysql2`）
- FIX `resend_request` 本地 outbox 回放；LDAP SASL **PLAIN only**

### Phase K

- Pulsar **`-partition-N` 路由**（PARTITIONED_METADATA；hash key / round-robin）；父 topic consume fan-in
- Official **outbound batch**；inbound **chunk uuid 重组**（最多 8）；官方 `chunks[]` 发 outbound chunk；`chunk:true` 无 parts 仍 `E_UNSUPPORTED`
- gRPC `tlsWatch` **进程内 remount** ChannelCredentials（不必 mcp_update；bidi session 会断）
- FIX `resend_request` 线上 35=2 → loopback **SequenceReset 35=4 GapFill**
- Kafka `cluster.eos=false` 诚实字段；LDAP GSSAPI 仍 `E_UNSUPPORTED`；SQL CI 仍跳过（无 Docker）

### Phase L

- Pulsar **`chunk:true` 隐式切分**：UTF-8 `chunkSize` 默认 256，最多 8 帧；单片不 chunk；超限 `E_UNSUPPORTED`
- FIX outbox 命中线上 **PossDupFlag=Y**；loopback 忽略 43=Y
- PROTOCOLS Redis `publish` 与 allowWrite 闸对齐；控制台设置页写清 gRPC remount

### Phase M

- **Audience 绑定 actor**：Agent 不能靠 `mcp_list { audience: "console" }` 看见已拉黑 tools；REST 入口强制 console
- `mcp_explain_tool` / `mcp_query_by_protocol` / `mcp_health` 对 Agent 藏名；`hiddenBlacklisted` 仅操作员可见
- 脱敏补 `jwt` / `tlsKey`；审查纪要 `docs/PHASE_M_REVIEW.md`

### Phase N

- 单机发现加厚：`/.well-known/openapi.json`、FTP/SNMP/etcd/WebDAV 指纹、**SSDP 单播 1900**（禁止组播）
- 新协议 MVP：`snmp`（SNMPv2c BER）`webdav` `ftp`（PASV）`etcd`（v3 HTTP KV）；默认 `allowWrite=false`
- `mcp_plan_bridge` 认上述协议；控制台发现页对齐

### Phase O

- 新协议 MVP：`imap`（IMAP4rev1 读；写闸）`pop3`（读；写闸）`consul`（HTTP KV/catalog/health）`azureblob`（REST + SharedKey 子集 / SAS）
- ClickHouse：`url` 走真 HTTP POST（不再对 live URL 直接 `E_UNSUPPORTED`）；INSERT/DDL 仍闸
- 发现：DNS-SD / mDNS **单播** 5353；组播仍 `E_UNSUPPORTED`；IMAP 143 / POP3 110 / Consul 8500 / Azure 10000 指纹
- **跳过** SFTP 与 Mongo live wire；不把 FTP 冒充 SFTP

### Phase P

- **SFTP**（`ssh2` 真 SSH-2，不是 FTP）；**Mongo OP_MSG** 子集；**SMTP** raw 提交 + `noop` + STARTTLS 广告闸
- **Memcached** 文本协议；**TFTP** RFC1350
- 发现：SSH-2 / 11211 / TFTP 69；plan_bridge 对齐

### Phase Q

- **CalDAV** / **CardDAV**（PROPFIND/REPORT/GET/PUT，写闸）；**Beanstalkd** 文本协议；**ZooKeeper** ruok + 二进制子集
- Redis Streams：XGROUP / XREADGROUP / XACK
- SMTP STARTTLS 仍广告/拒绝（真握手不稳）
- 发现：5232 / 11300 / 2181；plan_bridge 对齐

### Phase R

- **Prometheus remote_write**（protobuf + unframed snappy，写闸）；内存 query 按 metric 名
- **ZooKeeper** `watch_once` + `multi`；ACL/SASL `E_UNSUPPORTED`
- **CalDAV** time-range REPORT + freebusy；iTIP schedule `E_UNSUPPORTED`
- **Influx** `delete_points` / `/api/v2/delete`
- 发现 9090 + plan_bridge `allowWrite=false`；控制台矩阵对齐

### Phase S

- **NATS JetStream** consumer/ack/nack + interest；**AMQP** get/ack/nack
- **OPC-UA** memory monitored-item / wait_data_change
- **GraphQL** graphql-ws `subscribe_once`
- **DNS** 单播查询（无 AXFR / 无组播）
- 发现 53 + plan_bridge `allowWrite=false`

### Phase T

- **Cassandra CQL** native v4 STARTUP/QUERY 子集；写闸
- **CouchDB** HTTP `_all_docs` / get / put
- **Neo4j** HTTP transactional（Bolt 仍 E_UNSUPPORTED）
- **Whois** TCP 43 只读
- **Elasticsearch** HTTP `_search` / `_doc`
- 发现 9042 / 5984 / 43 / 7474 + plan_bridge `allowWrite=false`

### Phase U

- **Solr** HTTP select/update；写闸
- **RabbitMQ management** HTTP `/api`（不是 AMQP 0-9-1）
- **Kubernetes** 只读 list/get；exec/apply `E_UNSUPPORTED`
- 发现 8983 / 15672 / 6443 + plan_bridge 默认只读

## 测试数（历史）

| 里程碑 | suites | tests |
| ---: | ---: | ---: |
| P0/P1 债修补 | 72 | 299 |
| P2 PulsarApi + session bidi | 72 | 306 |
| Template / RTU / 签名 | 73 | 315 |
| W1/W2 控制台 | 74 | 321 |
| W3 + SMTP 指纹 | 75 | 325 |
| Phase F | 76 | 330 |
| Phase G | 77 | 339 |
| **Phase H 收口** | **77** | **340** |
| **黑名单** | **78** | **346** |
| **S1 安全平面** | **79** | **350** |
| **S1 R4 完整性 + ALLOW_SCAN 死变量** | **79** | **354** |
| **S2 HMAC / 审计 / 限流** | **80** | **361** |
| **Phase I LOOKUP follow / Kafka hermetic / SQL pool** | **80** | **369** |
| **Phase I + owner hop** | **80** | **370** |
| **Phase J partitions / TLS watch / Host MVP** | **80** | **373** |
| **Phase J + FIX resend / LDAP SASL PLAIN** | **80** | **375** |
| **Phase K partition route / gRPC remount / FIX SequenceReset** | **80** | **378** |
| **Phase L implicit chunk / PossDup / docs** | **80** | **379** |
| **Phase M audience / explain / redact** | **80** | **380** |
| **Phase N discovery + snmp/webdav/ftp/etcd** | **85** | **396** |
| **Phase O imap/pop3/consul/azureblob/CH HTTP/DNS-SD** | **90** | **413** |
| **Phase P sftp/mongo OP_MSG/smtp/memcached/tftp** | **94** | **426** |
| **Phase Q caldav/carddav/beanstalkd/zk/redis streams** | **99** | **436** |
| **Phase R prom remote_write / zk watch+multi / caldav range / influx delete** | **100** | **446** |
| **Phase S nats js / amqp ack / opcua mon / graphql-ws / dns** | **102** | **454** |
| **Phase T cassandra / couchdb / whois / neo4j HTTP / es HTTP** | **106** | **467** |
| **Phase U solr / rabbitmq mgmt / kubernetes RO** | **110** | **477** |

复跑：`npm run build && npm test`。

## 本版明确没有

- 默认网段 / CIDR 扫描、默认 `allowWrite=true`、`src/core` / `src/management` shim
- Kafka 完整 rebalance / 真事务协调器 / EOS（需真集群）
- SQL CI 真 Postgres/MySQL 镜像（本环境无 Docker）
- LDAP GSSAPI；安全平面 v2/v3 外部模块真加载；MCP Agent 写 challenge
- NFS 适配器；mDNS 组播浏览（单播 5353 已有）
- Sparkplug 完整 Host（自动 rebirth 循环 / 全量 NCMD）
- Neo4j 完整 Bolt；k8s exec/apply/watch；SolrCloud admin
- ChromaDB
