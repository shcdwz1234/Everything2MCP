# 发现（Discovery）

<!-- bilingual-header:v1 -->

**语言 / Language:** 正文以中文为主；下方为 English summary。

**English summary:** Two paths — console private-range auto-discovery (auto/manual/off) and agent **single-host** probes. Never CIDR from agent tools; never scan link-local / cloud metadata. Candidates are read-only until explicitly enabled.

---
**当前快照：控制台改版。** 两条路径：

1. **Agent / 单主机发现**（不变）：`discovery_scan_host` 等管理工具只扫**一个** host，有超时、有 SSRF 防护，**拒绝 CIDR / 网段 / 通配符**。Agent 不能借它扫网段。
2. **控制台自动发现**（新）：进程内调度器按 [下文规则](#自动发现auto-discovery) 扫**私网**，把结果列进「能力 → 可支持能力 → 已发现，可一键启用」。模式 自动 / 手动 / 关闭，默认自动（测试运行时默认关闭）。它把范围展开成单个主机，逐个走同一套单主机探测。

另见 `compat_scan`（[COMPAT.md](COMPAT.md)）与 Partner drops（[PARTNER.md](PARTNER.md)）。NFS 只有诚实 NULL ping。Environment Plane 是按需盘点。

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

关掉发现：`EVERYTHING2MCP_DISCOVERY_ENABLED=false`（同时强制自动发现为 `off`；`mcp_plan_bridge` / `schema_import` / `mcp_health` 仍可用）。只关自动发现：`EVERYTHING2MCP_DISCOVERY_MODE=off` 或在「设置」里选 **关闭**。

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
| SSDP | UDP **unicast** M-SEARCH `host:1900`（`upnp:rootdevice`）。单主机工具**不**发 `239.255.255.250`（组播只在自动发现里、且有界） |
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
| CIDR / `10.0.0.1-254` / `*` / 逗号列表（Agent 工具与单主机向导） | **永远拒绝**。`EVERYTHING2MCP_DISCOVERY_ALLOW_SCAN` 是死变量：设置了只打 warning，`allowScan` 恒为 `false`；`assertHostProbeAllowed` 忽略第二参 |
| 私网范围扫描 | 只有控制台 **自动发现** 调度器会做，规则见 [自动发现](#自动发现auto-discovery)（私网、网卡 ≤ /24、手动 ≤ /16、每轮主机上限、公网需 `allowPublic`） |
| 云 metadata IP（`169.254.169.254`、`169.254.170.2`、`100.100.100.200`、`metadata.google.internal`） | **拒绝**（SSRF）；自动发现逐主机过滤，即使落在 CGNAT 私网范围内也不扫 |
| HTTP 重定向到 metadata | **拒绝**（`redirect: manual` + 逐跳校验） |
| 端口全扫 1–65535 | 不提供 |
| mDNS 组播浏览 | Agent 工具仍**不提供**（`mdnsDiscover()` 仍 `E_UNSUPPORTED`），单主机用 `mdnsUnicastQuery` 打 `host:5353`。自动发现在 `multicast` 开启时发一次有界查询（TTL=1，只收私网应答者） |
| SSDP | Agent 工具：**单主机 unicast M-SEARCH :1900**。自动发现：同上有界组播 `ssdp:all` |
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

本机环境（不是远端 host）走 **Environment Plane**：`environment_inventory` → 建议列表 → `capability_register`（confirm，或 Safe+只读 `auto:true`）。热卸载走 `capability_unregister`。控制台同一条路：「高级 → 热加载」`#/hotload`（原 `#/capabilities`）。

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

## 自动发现（Auto-discovery）

实现：`src/control/auto-discovery.ts`（调度、候选、启用）、`src/discovery/netscope.ts`（范围规则）、`src/discovery/multicast.ts`（有界组播）。设置持久化在 `dataDir/discovery.json`。

### 模式

| 模式 | 行为 |
| --- | --- |
| **自动** `auto`（默认） | 启动后跑一次，然后每 `intervalMinutes`（默认 30，范围 5–1440）跑一次 |
| **手动** `manual` | 只在点「立即扫描」或 `POST /api/discovery/run` 时运行 |
| **关闭** `off` | 不做任何网络发现（单主机向导仍可用） |

默认值来源（优先级从高到低）：`EVERYTHING2MCP_DISCOVERY_ENABLED=false` → 强制 `off`；`EVERYTHING2MCP_DISCOVERY_MODE`（启动时生效，之后在 UI 保存设置即以保存值为准）；`dataDir/discovery.json`；否则 `auto`。在 `node --test` 下（`NODE_TEST_CONTEXT`）默认 `off`，测试不会扫网。

### 扫什么（范围规则）

- **私网地址**：`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`（RFC 1918）、`100.64.0.0/10`（CGNAT，按私网处理）、`127.0.0.0/8`、`fc00::/7`（ULA，仅单主机）。
- **永不扫描**（即使 `allowPublic`）：`169.254.0.0/16` link-local、`fe80::/10`、云元数据地址（`169.254.169.254`、`fd00:ec2::254`、`metadata.google.internal` 等）。
- **本机** `127.0.0.1`（`includeLocalhost`，默认开）。
- **网卡所在私网**（`includeInterfaces`，默认开）：每块网卡的私网子网，最多 **/24**（更大的网段只取本机所在的 /24）。
- **mDNS / SSDP 组播**（`multicast`，默认开）：向 `224.0.0.251:5353` 发 `_services._dns-sd._udp.local` 查询、向 `239.255.255.250:1900` 发 `ssdp:all`，TTL=1，只等待有限时间；**只接受私网应答者**，应答者作为待探测主机加入本轮。
- **手动范围** `scopes`：主机、域名或 CIDR，CIDR 最大 **/16**。公网地址默认拒绝，需显式打开 `allowPublic`（仅对你有权扫描的网络）。
- **排除** `exclude`：主机或 CIDR，优先于以上所有来源。
- **每轮主机上限** `hostCap`（默认 256，最大 1024），超出部分截断并在运行记录标 `truncated`；并发 `concurrency`（默认 16）；单端口超时 `timeoutMs`（默认 800 ms）。
- **协议** `protocols`：默认 openapi / graphql / grpc / redis / mqtt / nats / postgres / mysql / sqlserver / mongodb / elasticsearch / clickhouse / qdrant / s3 / prometheus / kafka / amqp / opcua / modbus / consul / etcd / couchdb / influx / rabbitmq，只打这些协议的常见端口（不是全端口扫描）。

每个主机仍走 `discovery_scan_host` 同一实现（含 SSRF / metadata 拦截）。安全平面 `discover` 钩子**每轮评估一次**（不是每个主机一次，避免一轮扫描耗尽每分钟配额）；黑名单按目标逐个过滤。

### 候选

- 每个 `(protocol, host, port)` 一条候选，记录首次 / 最近发现、在线状态；连续 10 轮未见且未启用的候选被清理。
- 草案一律 `allowWrite=false`。
- 命中黑名单（目标级）的候选不出现。
- **需要配置**：通常需要凭据的协议（postgres / mysql / sqlserver / s3 / amqp）在没有凭据时、草案缺必填字段时、或探测看到鉴权提示时。卡片只出缺的字段（例如用户名 / 密码，会合并进 URL 或 config）。
- **一键启用** 走 `capability_register`（同 `mcp_add`：校验、SSRF、安全钩子、黑名单）。失败时原因（错误码 + 信息，不含密钥）留在候选卡片上并标 **启用失败**（例如某些适配器只有 simulator、没有 live 客户端），成功后清除。
- **自动启用**（`autoEnable`，默认开）：只会自动启用「无需配置 + 只读」的候选。
- **本机平台能力**：每轮发现还会把环境盘点（`environment_inventory` / `suggestFromEnvironment`）里的本地能力并入候选——至少 `os_info`，以及 `platform_fs` / `platform_process` / `platform_service`；检测到浏览器时加入 `browser`（`allowDesktop` 恒为 false，不静默开桌面）。这些不是端口指纹命中；稳定 id 为 `protocol|local`，与网卡别名去重互不干扰。只读且无需凭据的仍走 `autoEnable`。
- **忽略** 把候选移出列表（可恢复）；**加入黑名单** 以后不再出现。
- 每轮运行写一条审计事件（kind=`discovery`），在「活动」和「设置 → 运行历史」可见。

### 环境变量

| 变量 | 作用 |
| --- | --- |
| `EVERYTHING2MCP_DISCOVERY_MODE` | `auto` / `manual` / `off` |
| `EVERYTHING2MCP_DISCOVERY_INTERVAL_MIN` | 自动模式间隔（分钟，5–1440，默认 30） |
| `EVERYTHING2MCP_DISCOVERY_SCOPES` | 额外手动范围，逗号或空白分隔 |
| `EVERYTHING2MCP_DISCOVERY_EXCLUDE` | 排除列表，逗号或空白分隔 |
| `EVERYTHING2MCP_DISCOVERY_ENABLED=false` | 关闭所有发现（含自动发现） |

`EVERYTHING2MCP_DISCOVERY_ALLOW_SCAN` 仍是死变量：它**不能**让 Agent 工具接受 CIDR；自动发现的范围只由上面的设置控制。

### REST

`GET/PUT /api/discovery/settings`、`GET /api/discovery/status`、`GET /api/discovery/candidates`、`POST /api/discovery/run`、`GET /api/discovery/runs`、`POST /api/discovery/candidates/:id/enable|dismiss|restore`。见 [CONSOLE.md](CONSOLE.md#rest)。
