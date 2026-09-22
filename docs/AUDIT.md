# 体检报告

**当前状态：Phase X（Partner + Compat）已落地。** 下文各「本轮」小节是当时快照。

## 本轮：Phase X（Partner 热集成）

南向 Partner → native OpenAPI → mcp_bridge 兜底。应用不实现 MCP。扫描不授予写/桌面/密钥。`GET /api/partner/v1/token` 跳过 REST 密钥脱敏（控制台要能复制本地 Partner token）。

| | suites | tests | pass | fail |
|---|---:|---:|---:|---:|
| Phase W | 124 | 522 | 522 | 0 |
| 本轮 `npm test` | **133** | **545** | **545** | **0** |

```
# tests 545
# suites 133
# pass 545
# fail 0
```

| | 说明 |
|---|---|
| 新协议 | partner, feishu, dingtalk, wecom, slack, notion, github, mcp_bridge |
| 新测试 | partner-lifecycle, compat-scan, 各 native adapter, mcp-bridge |
| 明确没有 | 个人微信私聊 Partner、支付/QQ 协议、mcp_bridge live spawn、Partner IPC invoke、S7+ WeChat tiers |

复跑：`npm run build && npm test`。

## 本轮：Phase W（能力积压 P1–P5）

**未再试** Kafka 真 EOS / SQL CI Docker / LDAP GSSAPI / v2/v3 真加载 / Agent 写 challenge。`allowWrite` 默认仍为 `false`。扫描从不打开 `allowShell`/`allowDesktop`/`allowReadSecrets`。无 CIDR UI、无 shim。Boot **不会**批量注册能力。IMDS 永不查询。

| | suites | tests | pass | fail |
|---|---:|---:|---:|---:|
| Phase V | 115 | 494 | 494 | 0 |
| 本轮 `npm test` | **124** | **522** | **522** | **0** |

增长：+9 suite（smb / nfs / vault / aws-iam / alertmanager / pubsub / jira / browser / discovery-phase-v）。以全量跑数为准。

```
# tests 522
# suites 124
# pass 522
# fail 0
```

复跑：`npm run build && npm test`。启动 UI：`EVERYTHING2MCP_TRANSPORT=http EVERYTHING2MCP_HTTP_PORT=8742 npm start` → http://127.0.0.1:8742/ui/#/capabilities

### Phase W — 已修 vs 仍欠

**已修：**

| 项 | 做到哪 |
| --- | --- |
| Docker/Podman | `logs` + podman docker-compat 工厂；`run` 仍 stub |
| SMB/CIFS | simulator list/get；live SMB2 NEGOTIATE；TREE_CONNECT 诚实缺口 |
| NFS | simulator exports；live NFSv3 NULL ping；SHOWMOUNT `E_UNSUPPORTED` |
| Journal | journal-export + Windows Event XML；journalctl/wevtutil 仍 stub |
| k8s logs | GET pod log tailLines |
| Vault/OpenBao | health / list_mounts / list_keys；`read_secret` 要 `allowReadSecrets` |
| aws_iam | 模拟器；live IMDS/STS `E_UNSUPPORTED` |
| Alertmanager / Pub/Sub / Jira | 只读 MVP；publish/silence 写闸 |
| OpenSearch | 同 ES 路径 + `cluster_health` |
| browser | `allowDesktop` 默认关；打开也不启 Chrome |
| suggest | 端口/包/云线索；从不拷密钥；从不开写/shell/desktop |
| 热卸载 | `unregister` hook + 审计；控制台确认；缺 id `E_NOT_FOUND`；黑名单不拦卸载 |

**仍欠（真缺口）：**

| 项 | 为何还欠 |
| --- | --- |
| Kafka 真 rebalance / EOS | 无集群；保留 hermetic group_status |
| SQL CI 真库 | 无 Docker 镜像 CI |
| LDAP GSSAPI / v2/v3 / Agent challenge | 有意不做 |
| 完整 CIFS / NFS 客户端 | 有意只做诚实 MVP |
| allowShell / allowDesktop 真执行 | 有意 stub |
| Slack webhook | 选了 Jira 只读 |

**不是债：** 无 CIDR UI；`ALLOW_SCAN` 死变量；默认 `allowWrite=false`；无 shim；transport 未改；Full 仍执行黑名单；Full ≠ 全局写；boot 不 bulk-register；scan ≠ write。

---

## 本轮之前：Phase V（最小核心 + 热加载 + 环境/平台）

**未再试** Kafka 真 EOS / SQL CI Docker / LDAP GSSAPI / v2/v3 真加载 / Agent 写 challenge。`allowWrite` 默认仍为 `false`。无 CIDR UI、无 shim。Full 仍执行黑名单。Full **不会**全局打开写。Boot **不会**批量注册能力。

| | suites | tests | pass | fail |
|---|---:|---:|---:|---:|
| Phase U | 110 | 477 | 477 | 0 |
| 本轮 `npm test` | **115** | **494** | **494** | **0** |

增长：+5 suite（capability-lifecycle / environment-inventory / platform-adapter / docker / journal）。以全量跑数为准。

```
# tests 494
# suites 115
# pass 494
# fail 0
```

复跑：`npm run build && npm test`。启动 UI：`EVERYTHING2MCP_TRANSPORT=http EVERYTHING2MCP_HTTP_PORT=8742 npm start` → http://127.0.0.1:8742/ui/#/capabilities

### Phase V — 已修 vs 仍欠

**已修：**

| 项 | 做到哪 |
| --- | --- |
| 热加载管道 | inventory/validate → suggest → policy → confirm/auto-readonly → Catalog.add → live → unregister |
| 双入口 | 控制台 `#/capabilities` + Agent `capability_*` / `environment_inventory` |
| 环境盘点 | OS/arch/distro、权限 hint、Linux `/proc/net` 监听端口、PATH 运行时、容器线索 |
| 平台只读 | os_info / gated fs / process_list / service_list；Win+Linux 代码；macOS best-effort |
| Docker / journal | HTTP+simulator 只读；syslog 文件读 |
| 写闸 stub | allowWrite / allowShell；shell_exec 与 docker run 不真执行 |

**仍欠（真缺口）：**

| 项 | 为何还欠 |
| --- | --- |
| Kafka 真 rebalance / EOS | 无集群 |
| SQL CI 真库 | 无 Docker 镜像 CI |
| LDAP GSSAPI / v2/v3 / Agent challenge | 有意不做 |
| SMB/CIFS | V4 选了 Docker/journal |
| allowShell 真执行 | 有意 stub |
| NFS / mDNS 组播 | 有意不做 |

**不是债：** 无 CIDR UI；`ALLOW_SCAN` 死变量；默认 `allowWrite=false`；无 shim；transport 未改；Full 仍执行黑名单；Full ≠ 全局写；boot 不 bulk-register。

---

## 本轮之前：Phase U（Solr / RabbitMQ management / Kubernetes 只读）

**未再试** Kafka 真 EOS / SQL CI Docker / LDAP GSSAPI / v2/v3 真加载 / Agent 写 challenge。`allowWrite` 默认仍为 `false`。无 CIDR UI、无 shim。Full 仍执行黑名单。Full **不会**全局打开写。

| | suites | tests | pass | fail |
|---|---:|---:|---:|---:|
| Phase T | 106 | 467 | 467 | 0 |
| 本轮 `npm run build && npm test` | **110** | **477** | **477** | **0** |

增长：+4 suite（solr / rabbitmq / kubernetes / discovery-phase-u）。以全量跑数为准。

```
# tests 477
# suites 110
# pass 477
# fail 0
```

复跑：`npm run build && npm test`。启动 UI：`EVERYTHING2MCP_TRANSPORT=http EVERYTHING2MCP_HTTP_PORT=8742 npm start` → http://127.0.0.1:8742/ui/

### Phase U — 已修 vs 仍欠（不硬凑）

**已修：**

| 项 | 做到哪 |
| --- | --- |
| Solr | HTTP select/update；写闸 |
| RabbitMQ management | `/api/queues` `/exchanges` publish/get；不是 AMQP 线协议 |
| Kubernetes | 只读 list/get pods/services/configmaps；exec/apply 恒 E_UNSUPPORTED |
| 发现 / 矩阵 | 8983 / 15672 / 6443；plan_bridge 默认只读 |
| Neo4j Bolt | 仍 E_UNSUPPORTED（HTTP tx 已在 T） |
| OpenSearch | 与 ES 同 HTTP 路径，只补文档 |

**仍欠（真缺口）：**

| 项 | 为何还欠 |
| --- | --- |
| Kafka 真 rebalance / EOS | 无 JoinGroup / 事务协调器 |
| SQL CI 真库 | 无 Docker |
| LDAP GSSAPI / v2/v3 / Agent challenge | 有意不做 |
| Neo4j 完整 Bolt | HTTP transactional 可测；Bolt 需注入 |
| SolrCloud admin / k8s watch / CRD | 子集 |
| mDNS 组播浏览 | 有意不做 |
| NFS | 有意不做（无适配器） |

**不是债：** 无 CIDR UI；`ALLOW_SCAN` 死变量；默认 `allowWrite=false`；无 shim；transport 未改；Full 仍执行黑名单；Full ≠ 全局写。

---

## 本轮之前：Phase T（Cassandra CQL / CouchDB HTTP / Whois / Neo4j HTTP / ES HTTP）

**未再试** Kafka 真 EOS / SQL CI Docker / LDAP GSSAPI / v2/v3 真加载 / Agent 写 challenge。`allowWrite` 默认仍为 `false`。无 CIDR UI、无 shim。Full 仍执行黑名单。Full **不会**全局打开写。

| | suites | tests | pass | fail |
|---|---:|---:|---:|---:|
| Phase S | 102 | 454 | 454 | 0 |
| 本轮 `npm run build && npm test` | **106** | **467** | **467** | **0** |

增长：+4 suite（cassandra / couchdb / whois / discovery-phase-t）+ Neo4j HTTP + ES HTTP。以全量跑数为准。

```
# tests 467
# suites 106
# pass 467
# fail 0
```

复跑：`npm run build && npm test`。启动 UI：`EVERYTHING2MCP_TRANSPORT=http EVERYTHING2MCP_HTTP_PORT=8742 npm start` → http://127.0.0.1:8742/ui/

### Phase T — 已修 vs 仍欠（不硬凑）

**已修：**

| 项 | 做到哪 |
| --- | --- |
| Cassandra CQL | 内存 + native v4 STARTUP/QUERY/RESULT；写闸 |
| CouchDB | `_all_dbs` / `_all_docs` / GET / PUT；写闸 |
| Neo4j HTTP | `/db/{db}/tx/commit`；Bolt 仍 E_UNSUPPORTED |
| Whois | TCP 43 只读 query |
| Elasticsearch HTTP | `_cat/indices` / `_search` / `_doc` |
| 发现 / 矩阵 | 9042 / 5984 / 43 / 7474；plan_bridge `allowWrite=false` |

**仍欠（真缺口）：**

| 项 | 为何还欠 |
| --- | --- |
| Kafka 真 rebalance / EOS | 无 JoinGroup / 事务协调器 |
| SQL CI 真库 | 无 Docker |
| LDAP GSSAPI / v2/v3 / Agent challenge | 有意不做 |
| Neo4j 完整 Bolt | HTTP transactional 可测；Bolt 需注入 |
| Cassandra prepared / LWT | 子集 |
| Solr / RabbitMQ management / k8s | 本轮未做 |
| mDNS 组播浏览 | 有意不做 |

**不是债：** 无 CIDR UI；`ALLOW_SCAN` 死变量；默认 `allowWrite=false`；无 shim；transport 未改；Full 仍执行黑名单；Full ≠ 全局写。

---

## 本轮之前：Phase S（NATS JetStream / AMQP ack / OPC-UA monitored / GraphQL-WS / DNS）

**未再试** Kafka 真 EOS / SQL CI Docker / LDAP GSSAPI / v2/v3 真加载 / Agent 写 challenge。`allowWrite` 默认仍为 `false`。无 CIDR UI、无 shim。Full 仍执行黑名单。Full **不会**全局打开写。

| | suites | tests | pass | fail |
|---|---:|---:|---:|---:|
| Phase R | 100 | 446 | 446 | 0 |
| 本轮 `npm run build && npm test` | **102** | **454** | **454** | **0** |

增长：+2 suite（dns / discovery-phase-s）+ NATS/AMQP/OPC-UA/GraphQL 加深。以全量跑数为准。

```
# tests 454
# suites 102
# pass 454
# fail 0
```

复跑：`npm run build && npm test`。启动 UI：`EVERYTHING2MCP_TRANSPORT=http EVERYTHING2MCP_HTTP_PORT=8742 npm start` → http://127.0.0.1:8742/ui/

### Phase S — 已修 vs 仍欠（不硬凑）

**已修：**

| 项 | 做到哪 |
| --- | --- |
| NATS JetStream | 内存 consumer + interest + fetch/ack/nack；写闸 |
| AMQP | 内存 Basic.Get + ack/nack requeue；写闸 |
| OPC-UA | 内存 monitored-item + wait_data_change；subscribe_once 仍一次性 |
| GraphQL subscription | graphql-ws 一发 next；simulator bus；无 wsUrl → E_UNSUPPORTED |
| DNS | 单播 A/AAAA/TXT/PTR；UDP loopback；无 AXFR |
| 发现 / 矩阵 | 53 指纹 `allowWrite=false`；plan_bridge / 控制台 help |

**仍欠（真缺口）：**

| 项 | 为何还欠 |
| --- | --- |
| Kafka 真 rebalance / EOS | 无 JoinGroup / 事务协调器 |
| SQL CI 真库 | 无 Docker |
| LDAP GSSAPI / v2/v3 / Agent challenge | 有意不做 |
| Cassandra / CouchDB / Whois / Neo4j Bolt | 本轮未做（协议过重或价值低于上述五项） |
| OPC-UA 完整 Subscription/Publish 服务集 | 仅内存 monitored-item |
| GraphQL 持久 subscription | 一次 next 后 complete |
| mDNS 组播浏览 | 有意不做 |

**不是债：** 无 CIDR UI；`ALLOW_SCAN` 死变量；默认 `allowWrite=false`；无 shim；transport 未改；Full 仍执行黑名单；Full ≠ 全局写。

---

## 本轮之前：Phase R（Prometheus remote_write / ZK watch+multi / CalDAV time-range / Influx delete）

**未再试** Kafka 真 EOS / SQL CI Docker / LDAP GSSAPI / v2/v3 真加载 / Agent 写 challenge。`allowWrite` 默认仍为 `false`。无 CIDR UI、无 shim。Full 仍执行黑名单。Full **不会**全局打开写。

| | suites | tests | pass | fail |
|---|---:|---:|---:|---:|
| Phase Q | 99 | 436 | 436 | 0 |
| 本轮 `npm run build && npm test` | **100** | **446** | **446** | **0** |

增长：+1 suite（discovery-phase-r）+ Prom/ZK/CalDAV/Influx 加深。以全量跑数为准。

```
# tests 446
# suites 100
# pass 446
# fail 0
```

复跑：`npm run build && npm test`。启动 UI：`EVERYTHING2MCP_TRANSPORT=http EVERYTHING2MCP_HTTP_PORT=8742 npm start` → http://127.0.0.1:8742/ui/

### Phase R — 已修 vs 仍欠（不硬凑）

**已修：**

| 项 | 做到哪 |
| --- | --- |
| Prometheus remote_write | protobuf WriteRequest + unframed snappy；`POST /api/v1/write`；写闸；loopback 写后按名 query |
| ZooKeeper watch / multi | `watch_once` + `multi` 内存与 TCP loopback；ACL/SASL `E_UNSUPPORTED` |
| CalDAV time-range / scheduling | REPORT `c:time-range` + free-busy-query；iTIP schedule `E_UNSUPPORTED` |
| Influx delete | `delete_points` → `/api/v2/delete`；谓词 + [start, stop)；写闸 |
| 发现 / 矩阵 | 9090 指纹 `allowWrite=false`；plan_bridge / 控制台矩阵 help |

**仍欠（真缺口）：**

| 项 | 为何还欠 |
| --- | --- |
| Kafka 真 rebalance / EOS | 无 JoinGroup / 事务协调器 |
| SQL CI 真库 | 无 Docker |
| LDAP GSSAPI / v2/v3 / Agent challenge | 有意不做 |
| PromQL 真引擎 | 内存只按 metric 名过滤 |
| CalDAV 完整 iTIP | REQUEST/REPLY 未做 |
| ZooKeeper ACL / SASL | 诚实 `E_UNSUPPORTED` |
| GraphQL subscription | 未做 |
| SMTP 真 TLS 握手 | 同 socket wrap 在 CI 易挂 |
| mDNS 组播浏览 | 有意不做 |

**不是债：** 无 CIDR UI；`ALLOW_SCAN` 死变量；默认 `allowWrite=false`；无 shim；transport 未改；Full 仍执行黑名单；Full ≠ 全局写。

---

## 本轮之前：Phase Q（CalDAV / CardDAV / Beanstalkd / ZooKeeper / Redis Streams）

**未再试** Kafka 真 EOS / SQL CI Docker / LDAP GSSAPI / v2/v3 真加载 / Agent 写 challenge。`allowWrite` 默认仍为 `false`。无 CIDR UI、无 shim。Full 仍执行黑名单。Full **不会**全局打开写。

| | suites | tests | pass | fail |
|---|---:|---:|---:|---:|
| Phase P | 94 | 426 | 426 | 0 |
| 本轮 `npm run build && npm test` | **99** | **436** | **436** | **0** |

增长：+5 suite（caldav / carddav / beanstalkd / zookeeper / discovery-phase-q）+ Redis Streams。以全量跑数为准。

```
# tests 436
# suites 99
# pass 436
# fail 0
```

复跑：`npm run build && npm test`。启动 UI：`EVERYTHING2MCP_TRANSPORT=http EVERYTHING2MCP_HTTP_PORT=8742 npm start` → http://127.0.0.1:8742/ui/

### Phase Q — 已修 vs 仍欠（不硬凑）

**已修：**

| 项 | 做到哪 |
| --- | --- |
| CalDAV | RFC4791 PROPFIND/REPORT/GET/PUT/MKCALENDAR；内存 + HTTP loopback；写闸 |
| CardDAV | RFC6352 PROPFIND/REPORT/GET/PUT；内存 + HTTP loopback；写闸 |
| Beanstalkd | 文本协议 put/reserve/delete/stats；写闸 |
| ZooKeeper | ruok + 二进制 connect/get/create/exists/getChildren；写闸 |
| Redis Streams | XGROUP / XREADGROUP / XACK；写闸 |
| SMTP STARTTLS | 仍广告/拒绝；未做同 socket 真握手 |
| 发现 | 5232 CalDAV/CardDAV OPTIONS / 11300 stats / 2181 ruok；plan_bridge |

**仍欠（真缺口）：**

| 项 | 为何还欠 |
| --- | --- |
| Kafka 真 rebalance / EOS | 无 JoinGroup / 事务协调器 |
| SQL CI 真库 | 无 Docker |
| LDAP GSSAPI / v2/v3 / Agent challenge | 有意不做 |
| SMTP 真 TLS 握手 | 同 socket wrap 在 CI 易挂；广告/拒绝路径已测 |
| mDNS 组播浏览 | 有意不做 |
| Prometheus remote_write / NFS | 本轮未做（snappy/过重） |

**不是债：** 无 CIDR UI；`ALLOW_SCAN` 死变量；默认 `allowWrite=false`；无 shim；transport 未改；Full 仍执行黑名单；Full ≠ 全局写。

---

## 本轮之前：Phase P（SFTP / Mongo OP_MSG / SMTP 加厚 / Memcached / TFTP）

**未再试** Kafka 真 EOS / SQL CI Docker / LDAP GSSAPI / v2/v3 真加载 / Agent 写 challenge。`allowWrite` 默认仍为 `false`。无 CIDR UI、无 shim。Full 仍执行黑名单。Full **不会**全局打开写。

| | suites | tests | pass | fail |
|---|---:|---:|---:|---:|
| Phase O | 90 | 413 | 413 | 0 |
| 本轮 `npm run build && npm test` | **94** | **426** | **426** | **0** |

增长：+4 suite（sftp / memcached / tftp / discovery-phase-p）+ SMTP/Mongo 加厚。以全量跑数为准。

```
# tests 426
# suites 94
# pass 426
# fail 0
```

复跑：`npm run build && npm test`。启动 UI：`EVERYTHING2MCP_TRANSPORT=http EVERYTHING2MCP_HTTP_PORT=8742 npm start` → http://127.0.0.1:8742/ui/

### Phase P — 已修 vs 仍欠（不硬凑）

**已修：**

| 项 | 做到哪 |
| --- | --- |
| SFTP | `ssh2` SSH-2 SFTP 子系统；内存 + 真 loopback；写闸；**不是 FTP** |
| Mongo | OP_MSG hello/find/insert/listCollections；BSON 子集；无 url 仍诚实内存 |
| SMTP | raw MAIL/DATA loopback；`noop` 只读；STARTTLS 未广告 → `E_UNSUPPORTED`；发信写闸 |
| Memcached | 文本协议 GET/SET/DELETE/STATS |
| TFTP | RFC1350 RRQ/WRQ；单 UDP session；不是 FTP |
| 发现 | 22 SSH banner / 11211 STAT / 69 TFTP DATA\|ERROR；plan_bridge |

**仍欠（真缺口）：**

| 项 | 为何还欠 |
| --- | --- |
| Kafka 真 rebalance / EOS | 无 JoinGroup / 事务协调器 |
| SQL CI 真库 | 无 Docker |
| LDAP GSSAPI / v2/v3 / Agent challenge | 有意不做 |
| SMTP 真 TLS 握手 | 同 socket wrap 在 CI 易挂；广告/拒绝路径已测 |
| mDNS 组播浏览 | 有意不做 |
| Mongo aggregation / 官方驱动 | OP_MSG 子集足够 hermetic |

**不是债：** 无 CIDR UI；`ALLOW_SCAN` 死变量；默认 `allowWrite=false`；无 shim；transport 未改；Full 仍执行黑名单；Full ≠ 全局写。

---

## 本轮之前：Phase O（IMAP/POP3/Consul/Azure Blob/ClickHouse HTTP + DNS-SD 单播）

**未再试** Kafka 真 EOS / SQL CI Docker / LDAP GSSAPI / v2/v3 真加载 / Agent 写 challenge。**未做** SFTP（无 ssh2，不冒充 FTP）。Mongo 保持诚实内存，无假 wire。`allowWrite` 默认仍为 `false`。无 CIDR UI、无 shim。Full 仍执行黑名单。Full **不会**全局打开写。

| | suites | tests | pass | fail |
|---|---:|---:|---:|---:|
| Phase N | 85 | 396 | 396 | 0 |
| 本轮 `npm run build && npm test` | **90** | **413** | **413** | **0** |

增长：+5 suite（imap / pop3 / consul / azureblob / discovery-dnssd）+ ClickHouse HTTP + IMAP APPEND / Azure SharedKey 线上校验 / POP3 DELE。以全量跑数为准。

```
# tests 413
# suites 90
# pass 413
# fail 0
```

复跑：`npm run build && npm test`。启动 UI：`EVERYTHING2MCP_TRANSPORT=http EVERYTHING2MCP_HTTP_PORT=8742 npm start` → http://127.0.0.1:8742/ui/

### Phase O — 已修 vs 仍欠（不硬凑）

**已修：**

| 项 | 做到哪 |
| --- | --- |
| IMAP | IMAP4rev1 读 + APPEND/STORE/EXPUNGE 写闸；内存 + TCP loopback（含 APPENDUID）；不是 SMTP/IDLE/QRESYNC |
| POP3 | STAT/LIST/RETR + DELE/RSET 写闸；内存 + TCP loopback；不是 SMTP |
| Consul | HTTP `/v1/kv` `/v1/catalog/services` `/v1/health/service`；写闸；无 Connect |
| Azure Blob | list/get/put/delete；SharedKey HMAC-SHA256 **子集**（无完整 2015+ query canonical）或 `sasToken` 查询串；缺凭据 `E_UNSUPPORTED`；loopback 验签 GET/PUT |
| ClickHouse | `url` 走 HTTP POST + JSONEachRow；INSERT/DDL 仍 `allowWrite`；无 url / `simulator` 仍内存 |
| DNS-SD | 单播 PTR `host:5353`；组播 `224.0.0.251` / CIDR 拒；编解码单测；候选进 plan/suggest |
| 跳过 | Mongo live wire；SFTP |

**仍欠（真缺口）：**

| 项 | 为何还欠 |
| --- | --- |
| Kafka 真 rebalance / EOS | 无 JoinGroup / 事务协调器；hermetic ≠ 集群 |
| SQL CI 真库 | 无 Docker / testcontainers |
| LDAP GSSAPI / v2/v3 / Agent challenge | 有意不做 |
| SFTP | 需可靠 SSH 栈；本环境无 ssh2 |
| Mongo 真 wire | 无官方驱动；不冒充网络 |
| mDNS 组播浏览 | 有意不做（等于扫网） |
| Azure SharedKey 完整 canonical query | 子集（VERB + x-ms-date/version + resource）；SAS 不本地签名 |

**不是债：** 无 CIDR UI；`ALLOW_SCAN` 死变量；默认 `allowWrite=false`；无 shim；transport 未改；Full 仍执行黑名单；Full ≠ 全局写。

---

## 本轮之前：Phase N（发现加厚 + SNMP/WebDAV/FTP/etcd）

**未再试** Kafka 真 EOS / SQL CI Docker / LDAP GSSAPI / v2/v3 真加载 / Agent 写 challenge。`allowWrite` 默认仍为 `false`。无 CIDR UI、无 shim。Full 仍执行黑名单。Full **不会**全局打开写。

| | suites | tests | pass | fail |
|---|---:|---:|---:|---:|
| Phase M | 80 | 380 | 380 | 0 |
| 本轮 `npm run build && npm test` | **85** | **396** | **396** | **0** |

增长：+5 suite（snmp / webdav / ftp / etcd / discovery-ssdp）+ 新指纹与 plan 用例。以全量跑数为准。

```
# tests 396
# suites 85
# pass 396
# fail 0
```

复跑：`npm run build && npm test`。启动 UI：`EVERYTHING2MCP_TRANSPORT=http EVERYTHING2MCP_HTTP_PORT=8742 npm start` → http://127.0.0.1:8742/ui/

### Phase N — 已修 vs 仍欠（不硬凑）

**已修：**

| 项 | 做到哪 |
| --- | --- |
| 单机指纹 | FTP 21、SNMP 161 Get sysDescr、etcd `/version`、WebDAV OPTIONS DAV、`/.well-known/openapi.json` |
| SSDP | **unicast** M-SEARCH `host:1900`；组播 / CIDR 仍拒；`mdnsDiscover()` 仍 `E_UNSUPPORTED` |
| SNMP | SNMPv2c BER Get/GetNext/walk/Set；内存 MIB + UDP loopback；无 v3 |
| WebDAV | PROPFIND/GET/PUT/DELETE/MKCOL；内存 + HTTP |
| FTP | LIST/RETR/STOR/DELE；内存 + PASV loopback；不是 SFTP |
| etcd | v3 HTTP KV range/put/delete；内存 + HTTP；无 watch |
| Agent 计划 | `mcp_plan_bridge` 认上述协议；建议 `allowWrite=false` |

**仍欠（真缺口）：**

| 项 | 为何还欠 |
| --- | --- |
| Kafka 真 rebalance / EOS | 无 JoinGroup / 事务协调器；hermetic ≠ 集群 |
| SQL CI 真库 | 无 Docker / testcontainers |
| LDAP GSSAPI / v2/v3 / Agent challenge | 有意不做 |
| SFTP / IMAP / Azure Blob / Consul | 本轮未做（SFTP 需 SSH 栈；未硬凑假客户端） |
| mDNS 组播浏览 | 有意不做（等于扫网） |

**不是债：** 无 CIDR UI；`ALLOW_SCAN` 死变量；默认 `allowWrite=false`；无 shim；transport 未改；Full 仍执行黑名单；Full ≠ 全局写。

---

## 本轮之前：Phase M（审查 / 查漏 / 设计补充）

**未开新协议。未再试** Kafka 真 EOS / SQL CI Docker / LDAP GSSAPI / v2/v3 真加载 / Agent 写 challenge。`allowWrite` 默认仍为 `false`。无 CIDR UI、无 shim。Full 仍执行黑名单。Full **不会**全局打开写。

| | suites | tests | pass | fail |
|---|---:|---:|---:|---:|
| Phase L | 80 | 379 | 379 | 0 |
| 本轮 `npm run build && npm test` | **80** | **380** | **380** | **0** |

增长：+0 suite / +1 test（audience spoof + explain/query 藏名；jwt/tlsKey 叠在现有 redact 用例）。以全量跑数为准。

```
# tests 380
# suites 80
# pass 380
# fail 0
```

复跑：`npm run build && npm test`。启动 UI：`EVERYTHING2MCP_TRANSPORT=http EVERYTHING2MCP_HTTP_PORT=8742 npm start` → http://127.0.0.1:8742/ui/

审查纪要：[PHASE_M_REVIEW.md](PHASE_M_REVIEW.md)。ADR：[adr/0002-actor-bound-audience.md](adr/0002-actor-bound-audience.md)。

### Phase M — 已修 vs 仍欠（不硬凑）

**已修：**

| 项 | 做到哪 |
| --- | --- |
| audience 伪造 | 操作员视图绑定 `actor.kind=console`；MCP stdio 固定 agent；REST 入口写入 console |
| explain / query / health 漏网 | Agent 对已拉黑 tool：`E_BLACKLISTED` / 剥 `adapters[].tools` / 不返回 `hiddenBlacklisted` |
| jwt / tlsKey 脱敏 | `EXACT_SECRET`；不泛化 `key` |
| 文档漂移 | `ARCHITECTURE` schema_import 已实现；账本不封 `audit.jsonl` 标为有意不做 |

**仍欠（真缺口）：**

| 项 | 为何还欠 |
| --- | --- |
| Kafka 真 rebalance / EOS | 无 JoinGroup / 事务协调器；hermetic ≠ 集群 |
| SQL CI 真库 | 无 Docker / testcontainers；`sqlserver`/`duckdb` 仅 simulator |
| LDAP GSSAPI | 无 Kerberos / GSS 依赖，不 stub |
| v2 本地 JS / v3 npm 模块 | loader 钩子在；非 builtin → `E_UNSUPPORTED`（明确不做） |
| MCP Agent 写操作 challenge | 有意不做 |
| 无密钥时的 SHA-256 双写伪造 | 已文档，不是漏做 |

**不是债：** 无 CIDR UI；`ALLOW_SCAN` 死变量；默认 `allowWrite=false`；无 shim；transport 未改；Full 仍执行黑名单；Full ≠ 全局写。

---

### Phase L — 已修 vs 仍欠（历史）

**已修：**

| 项 | 做到哪 |
| --- | --- |
| Pulsar `chunk:true` | UTF-8 按 `chunkSize`（默认 256，1–1MiB）切最多 8 帧；单片不带 chunk metadata；>8 片 `E_UNSUPPORTED`；单码点大于 size → `E_INVALID_ARGUMENT`；不撕码点 |
| FIX PossDup | outbox 命中以 43=Y 重发；loopback 忽略 PossDup（不二次 Logon） |
| Redis 文档 | `publish` 与实现一致：写入闸 |
| 控制台文案 | 设置页写清 gRPC `tlsWatch` remount |
| ROADMAP gRPC | 去掉过期「无证书热重载」 |

**仍欠（真缺口）：**

| 项 | 为何还欠 |
| --- | --- |
| Kafka 真 rebalance / EOS | 无 JoinGroup / 事务协调器；hermetic ≠ 集群 |
| SQL CI 真库 | 无 Docker / testcontainers；`sqlserver`/`duckdb` 仅 simulator |
| LDAP GSSAPI | 无 Kerberos / GSS 依赖，不 stub |
| v2 本地 JS / v3 npm 模块 | loader 钩子在；非 builtin → `E_UNSUPPORTED`（明确不做） |
| MCP Agent 写操作 challenge | 有意不做 |
| 无密钥时的 SHA-256 双写伪造 | 已文档，不是漏做 |

**不是债：** 无 CIDR UI；`ALLOW_SCAN` 死变量；默认 `allowWrite=false`；无 shim；transport 未改；Full 仍执行黑名单；Full ≠ 全局写。

---

## 已完成（按优先级）

### P0 — 产品面，可给用户用

| 项 | 状态 |
|---|---|
| MCP stdio + HTTP `/mcp` + SSE `/sse` | 完成 |
| 热注册 catalog、分层 tools、plan hints | 完成 |
| 单主机 discovery + SSRF；禁止 CIDR | 完成 |
| 默认 `allowWrite=false` | 完成 |
| 同进程控制台 W1–W3（`/ui` `#/audit` `#/plan`） | 完成 |
| 操作员黑名单（store + MCP/REST + `#/blacklist`；invoke 也拒绝） | 完成 |
| S1 安全平面（Safe/Full、Agent list 过滤、`#/security`） | 完成 |
| S2 HMAC / registrations 账本 / 审计 JSONL / 真限流 / secret-redact | 完成 |
| 发布说明 + 启动句 | 完成（`docs/RELEASE_NOTES.md`） |

### P1 — 协议主路径（有测试）

关系型 sqlite 真引擎 + 其余 simulator；OpenAPI/MQTT/SOAP/gRPC session bidi/GraphQL/AMQP/Kafka one-shot + hermetic txn/generation/FIX 写闸+PossDup/LDAP 写/Redis/SMTP/工业总线（含 Modbus RTU）/对象存储签名/Pulsar 官方子集 + LOOKUP follow + PARTITIONED_METADATA + `-partition-N` 路由 + inbound/outbound batch/chunk（含 `chunk:true`）/Sparkplug protobuf + Host Application MVP。

### P2 — 诚实增量（不是完整产品）

| 项 | 做到哪 |
|---|---|
| Pulsar LOOKUP | 跟跳 + owner hop；token/JWT on CONNECT |
| Pulsar partitions / batch / chunk | 路由 `-partition-N`；official outbound batch；chunk uuid 重组≤8；`chunks[]` + `chunk:true` 切分 |
| SQL native | `poolMax`/`ssl`/`statementTimeoutMs`；CI 无镜像（Docker 不可用） |
| Kafka EOS | live 事务 tool `E_UNSUPPORTED`；hermetic InitProducerId + generation；`cluster.eos=false` |
| TLS | `watchTlsMaterial` 热重读；gRPC 进程内 remount |
| Sparkplug Host | retain STATE + rebirth NCMD MVP |
| FIX resend | 线上 35=2 → loopback 35=4 GapFill + PossDupFlag=Y + 本地 outbox |

---

## 仍开放（醒来后不要当已完成）

| 优先级 | 债 | 估计 | 现状 |
|---|---|---|---|
| **高** | **Kafka 完整 rebalance + 真事务/EOS** | 很大 | hermetic generation only；live one-shot；需真集群 |
| **高** | **SQL CI 真库**（需 Docker + 驱动包） | 很大 | 本环境阻塞：无 Docker、无 `pg`/`mysql2` |
| 低 | LDAP GSSAPI | 小 | 无 Kerberos 依赖；PLAIN only |
| 不做 | CIDR UI、默认 allowWrite、shim、ChromaDB、discovery 网段、v2/v3、Agent challenge | — | 产品拒绝 |

---

## 历史数字

| 轮次 | suites | tests |
|---|---:|---:|
| 债修补 P0/P1 | 72 | 299 |
| Phase H | 77 | 340 |
| 黑名单 | 78 | 346 |
| S1 | 79 | 350 |
| S1 R4 | 79 | 354 |
| S2 | 80 | 361 |
| Phase I | 80 | 369 |
| Phase I + owner hop | 80 | 370 |
| Phase J 主项 | 80 | 373 |
| Phase J + FIX/LDAP | 80 | 375 |
| Phase K | 80 | 378 |
| **Phase L** | **80** | **379** |
| **Phase M** | **80** | **380** |
| **Phase N** | **85** | **396** |
