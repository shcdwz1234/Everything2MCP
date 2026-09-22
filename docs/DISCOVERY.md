# 发现（Discovery）

**当前快照：Phase X。** Environment Plane 是按需盘点。另见 `compat_scan`（[COMPAT.md](COMPAT.md)）与 Partner drops（[PARTNER.md](PARTNER.md)）。NFS 只有诚实 NULL ping。discovery **仍不**做组播。

默认：**单主机、有超时、有 SSRF 防护、拒绝 CIDR/网段**。mDNS 组播浏览不提供。NFS 组播/SHOWMOUNT 不提供。

## 管理工具

| Tool | 作用 |
| --- | --- |
| `discovery_probe` | 单 host+port 的 OpenAPI / WSDL / GraphQL 路径探测（兼容旧行为） |
| `discovery_scan_host` | 并行探测更多协议（见下） |
| `discovery_suggest` | 把候选变成 `mcp_add` 草案（protocol + name + config + confidence） |
| `mcp_add_from_discovery` | 一键按草案注册（与 `capability_register` 同一 `add()`） |
| `schema_import` | 从文件/URL 导入 OpenAPI、WSDL、proto、GraphQL SDL、AsyncAPI；识别 JSON:API/OData/tRPC/Connect 为 import-first |
| `environment_inventory` | 本机 OS/端口/运行时/容器/**云线索** → suggest + `compat` 块；从不 auto-register |
| `compat_scan` | Compat Catalog 分档建议（ingress）；P3 mcpServers 仅为 mcp_bridge 兜底 |
| `partner_list` | 列出 ingress=partner 的连接 |
| `capability_register` | 热加载（confirm 或 Safe+readonly auto；Partner write/desktop 不能 auto） |
| `capability_unregister` | 热卸载（与 `mcp_remove` 同一 `remove()`；不要求 allowWrite） |

关掉发现：`EVERYTHING2MCP_DISCOVERY_ENABLED=false`（`mcp_plan_bridge` / `schema_import` / `mcp_health` 仍可用）。

## discovery_scan_host

```json
{ "host": "127.0.0.1", "port": 8080, "protocols": ["openapi", "redis", "mqtt"] }
```

未指定 `port` 时，HTTP 走 80/8080/8000 与 443；其它协议走常见端口（6379 Redis、1883 MQTT、502 Modbus、5683 CoAP、4222 NATS、50051 gRPC、**9092 Kafka**、**5672 AMQP**、**4840 OPC-UA**、47808 BACnet/IP、**44818 EtherNet/IP**、**102 S7**、**5000 MTConnect**、**6650/8080 Pulsar**、**4443 GCS**、**8086 Influx**、**25/587 SMTP**、**21 FTP**、**22 SFTP/SSH-2**、**69 TFTP**、**11211 Memcached**、**161 SNMP**、**2379 etcd**、**143 IMAP**、**110 POP3**、**8500 Consul**、**10000 Azure Blob / Azurite**、**1900 SSDP 单播**、**5353 DNS-SD 单播**、**53 DNS 单播**、**5232 CalDAV/CardDAV**、**11300 Beanstalkd**、**2181 ZooKeeper**、**9042 Cassandra**、**5984 CouchDB**、**43 Whois**、**7474 Neo4j HTTP**、**8983 Solr**、**15672 RabbitMQ management**、**6443 Kubernetes**、**8200 Vault**、**9093 Alertmanager**、**2375 Docker Engine**）。`onlyGivenPort: true` 时只打给出的端口。

并行指纹：

| 协议 | 探测 |
| --- | --- |
| OpenAPI | 常见 `/openapi.json`、`/swagger.json`、`/v3/api-docs`、**`/.well-known/openapi.json`** 等 |
| SOAP | `/?wsdl`、`/service?wsdl` 等 |
| GraphQL | `POST /graphql` introspection |
| gRPC | Server Reflection `list_services`（可达才报告） |
| Redis | `PING` → `PONG` |
| MQTT | CONNECT → CONNACK |
| Modbus TCP | MBAP FC3 |
| CoAP | CON GET `/.well-known/core` |
| NATS | 首包 `INFO {…}` |
| JSON-RPC | `{"jsonrpc":"2.0",…}` 指纹 |
| XML-RPC | `system.listMethods` 指纹 |
| BACnet/IP | **unicast** Who-Is on UDP 47808 → I-Am（**不广播、不扫网段**） |
| EtherNet/IP | TCP 44818 CIP **List Identity**（encapsulation 0x0063；单主机，不广播） |
| S7 | TCP 102 ISO-on-TCP **COTP CR → CC** |
| MTConnect | HTTP GET `/probe` on 5000 与 80，认 `MTConnectDevices`/`Streams` XML |
| Pulsar | HTTP **8080** `/admin/v2/brokers/ready` 或 `/admin/v2/clusters`；TCP **6650** 长度前缀且回包含 `pulsar`（单主机，**禁 CIDR**） |
| GCS | HTTP **4443** `GET /storage/v1/b`，认 `storage#buckets` |
| OSS | HTTP 根路径带 `x-oss-request-id` / `AliyunOSS`（走当前 HTTP 端口，单主机） |
| InfluxDB | HTTP **8086** `/health`（`influxdb`）或 `/ping` `X-Influxdb-Version` |
| Prometheus | HTTP **9090** `/-/healthy` 或 `/api/v1/status/buildinfo`；草案 `allowWrite=false` |
| Kafka | TCP **9092** ApiVersions（correlation echo） |
| AMQP | TCP **5672** `AMQP` 协议头 |
| OPC-UA | TCP **4840** Hello → ACK/ERR（不是完整 SecureChannel） |
| SMTP | TCP **25 / 587** 服务端先发 `220 …` banner（不发邮件；写入仍 `allowWrite`） |
| FTP | TCP **21** `220` banner（含 FTP/ready；与 SMTP ESMTP 区分） |
| SNMP | UDP **161** SNMPv2c GetRequest `sysDescr.0`（community `public`） |
| etcd | HTTP **2379** `/version`（`etcdserver`）或 `/health` |
| WebDAV | HTTP `OPTIONS` 认 `DAV` / `Allow: PROPFIND`（`/` `/dav` `/webdav`） |
| SSDP | UDP **unicast** M-SEARCH `host:1900`（`upnp:rootdevice`）。**不**发 `239.255.255.250`，**不**组播浏览局域网 |
| IMAP | TCP **143** 首包 `* OK`（含 IMAP 或默认端口） |
| POP3 | TCP **110** 首包 `+OK`（含 POP 或默认端口） |
| Consul | HTTP **8500** `/v1/status/leader` 或 `/v1/agent/self` |
| Azure Blob | HTTP **10000** `?restype=container&comp=list` 认 `x-ms-request-id` / Azurite / EnumerationResults |
| DNS-SD / mDNS | UDP **unicast** PTR `host:5353`。**不**发 `224.0.0.251`；`mdnsMulticastBrowse()` / `mdnsDiscover()` 仍 `E_UNSUPPORTED` |
| SFTP | TCP **22** 首包 `SSH-2.0-`（不是 FTP 220） |
| Memcached | TCP **11211** `stats` → `STAT ` |
| TFTP | UDP **69** RRQ → DATA 或 ERROR |
| CalDAV | HTTP OPTIONS `DAV` 含 `calendar-access`（含 **5232**） |
| CardDAV | HTTP OPTIONS `DAV` 含 `addressbook` |
| Beanstalkd | TCP **11300** `stats` → `OK ` |
| ZooKeeper | TCP **2181** `ruok` → `imok` |
| DNS | UDP **53** 单播 query，认 QR 响应。**不是** AXFR，**不是** 224.0.0.251 |
| Cassandra | TCP **9042** native v4 STARTUP → READY / AUTHENTICATE |
| CouchDB | HTTP **5984** `GET /` 认 `"couchdb":"Welcome"` |
| Whois | TCP **43** 查询 `example.test`，认 Domain Name / No match |
| Neo4j HTTP | HTTP **7474** `GET /` 认 `neo4j_version` / `transaction` |
| Solr | HTTP **8983** `/solr/admin/info/system` 认 `solr_spec_version` / lucene |
| RabbitMQ management | HTTP **15672** `/api/overview` 认 `rabbitmq_version`（不是 AMQP 5672） |
| Kubernetes | HTTP **6443** `/version` 认 `gitVersion` / `major` |
| Vault / OpenBao | HTTP **8200** `/v1/sys/health` 认 `initialized`/`sealed`（无 token） |
| Alertmanager | HTTP **9093** `/api/v2/status` |
| Docker Engine | HTTP **2375** `/version` 认 `ApiVersion` |

每条探测都有 `timeoutMs`（默认 `EVERYTHING2MCP_DISCOVERY_TIMEOUT_MS=2500`）。

## 安全

| 行为 | 默认 |
| --- | --- |
| CIDR / `10.0.0.1-254` / `*` / 逗号列表 | **永远拒绝**。`EVERYTHING2MCP_DISCOVERY_ALLOW_SCAN` 是死变量：设置了只打 warning，`allowScan` 恒为 `false`；`assertHostProbeAllowed` 忽略第二参。循环扫描未实现 |
| 云 metadata IP（`169.254.169.254`、`169.254.170.2`、`100.100.100.200`、`metadata.google.internal`） | **拒绝**（SSRF） |
| HTTP 重定向到 metadata | **拒绝**（`redirect: manual` + 逐跳校验） |
| 端口全扫 1–65535 | 不提供 |
| mDNS 组播浏览 | **禁用**（会变成网段发现）。用 `mdnsUnicastQuery` 打单个 `host:5353` |
| SSDP | **单主机 unicast M-SEARCH :1900**；`mdnsDiscover()` 仍 `E_UNSUPPORTED` |
| NFS | **无 SHOWMOUNT / 无组播指纹**。适配器 live 仅 NFSv3 NULL ping（需热加载，不是 scan 默认） |

`looksLikeNetworkRange()` 与 `assertHostAllowed()` 在管理入口和 `scanHost`/`probeHost` 都会跑。

探测会向目标发真实报文。只对你有权访问的主机使用。这不是攻击面测绘工具。

## 建议 → 注册

`discovery_suggest` / `discovery_scan_host` 返回：

```json
{
  "suggestions": [
    {
      "protocol": "openapi",
      "name": "openapi-Widget-API",
      "config": { "spec": "http://127.0.0.1:8080/openapi.json" },
      "confidence": 0.95,
      "reason": "mcp_add protocol=openapi config.spec=<url>"
    }
  ]
}
```

然后 `mcp_add_from_discovery` 传入整个 suggestion 对象（`{ suggestion: scan.suggestions[0] }`），**不要**传 `pick: 0`。

黑名单命中的候选仍出现在 `candidates` 上（`blacklisted: true` + `blacklistId`），但 **不会进入 `suggestions`**，因此不能一键注册。`blocked` / `hiddenBlacklisted` 给出被过滤条数。控制台 Discovery 行可以「加入黑名单」。匹配规则见 [BLACKLIST.md](BLACKLIST.md)。

## 工具分层（management vs business）

MCP `tools/list` 会列出两层，用 `_meta.layer` 区分：

| layer | 谁 | 例子 |
| --- | --- | --- |
| `management` | 目录 / 发现 / 热加载 | `mcp_plan_bridge` `discovery_scan_host` `environment_inventory` `capability_register` `schema_import` |
| `business` | 已注册适配器 | `openapi.widgets.listWidgets` `os_info.local.uname` |

`mcp_list` 默认 `layer=business`（只返回业务 tools + 管理工具**名称**列表）。`layer=management` / `all` 可显式展开。`mcp_explain_tool` 的 `layer` 字段与此一致。

## schema_import

```json
{ "source": "./examples/petstore.openapi.json", "register": true, "name": "widgets" }
```

| kind | 注册为 | 额外需要 |
| --- | --- | --- |
| openapi | `openapi` `config.spec`；若 `servers[0].url` 绝对地址则填 `baseUrl` | — |
| wsdl | `soap` `config.wsdl` | — |
| proto | `grpc` `config.proto` | `target`；或改用 `reflection: true` |
| graphql SDL | `graphql` `config.sdl` | `url` |
| asyncapi | `asyncapi` `config.spec` | 可选 `brokerUrl` |
| jsonapi / odata / trpc | **不注册**（import-first） | 导出 OpenAPI 再导入 |
| connectrpc | `grpc` `config.proto`，默认不注册 | `target` 或改导出 OpenAPI |

## Agent 推荐路径

1. `mcp_plan_bridge` `{ "goal": "把 10.0.0.8 上的 REST 和 MQTT 接进来" }`
2. `discovery_scan_host` `{ "host": "10.0.0.8" }`
3. `mcp_add_from_discovery` 选 confidence 最高的 suggestion
4. `mcp_health` / `mcp_explain_tool` 确认

认证探测不在范围内：需要 header 才能 GET `/openapi.json` 时，直接把已知 URL 交给 `schema_import` 或 `mcp_add`。

本机环境（不是远端 host）走 **Environment Plane**：`environment_inventory` → 建议列表 → `capability_register`（confirm，或 Safe+只读 `auto:true`）。热卸载走 `capability_unregister`。控制台同一条路：`#/capabilities`。

## Environment inventory（按需，不是 deploy hook）

`environment_inventory` 盘点当前进程所在机器，**只产出 suggest**（`autoRegistered` 恒为空数组）。从不在 boot 调用，从不把 `allowWrite` / `allowShell` / `allowDesktop` / `allowReadSecrets` 设为 `true`。**从不请求 IMDS（169.254.169.254）**。

返回字段（诚实缺口写在 `gaps[]`，不假装跨平台 API 都成功）：

| 字段 | 内容 |
| --- | --- |
| `os` | platform / arch / distro 线索（Linux `/etc/os-release`） |
| `permissions` | uid/gid/username；elevated hint（uid 0 / Windows 管理员线索） |
| `listeningPorts` | Linux 解析 `/proc/net/tcp{,6}` `/udp{,6}`；其它 OS 标 gap |
| `runtimes` | PATH 上的 node/python/java/docker/podman/kubectl/vault/smbclient 等 |
| `container` | `/.dockerenv`、k8s 环境变量、docker.sock / podman.sock |
| `configPaths` | syslog / kubeconfig / aws-config / vault-token **存在与否**（不读 token 内容） |
| `cloud` | aws/gcp/azure/vault 线索与 **host-only** `VAULT_ADDR`；`tokenEnvPresent` 只列变量名 |
| `suggestions` | 平台适配器 + 端口/包命中；config 强制只读闸 |

建议列表 **不会**批量 `mcp_add`。热加载必须再走 `capability_register` 或控制台确认。
