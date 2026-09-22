# 架构 — Everything2MCP

**当前快照：Phase U 已落地。** 单进程、五包分层。业务 tools 全部由适配器在运行时注册，MCP 工具名保持 `mcp_*` / `discovery_*` / `schema_import` 与 `{protocol}.{name}.{operation}`。下一阶段等用户 continue。

```
┌──────────────────────────────────────────────┐
│  MCP Client (Cursor / Claude / 其他 Agent)   │
│          stdio / Streamable HTTP / SSE        │
└──────────────────────┬───────────────────────┘
                       │
┌──────────────────────▼───────────────────────┐
│ transport   stdio（默认）· HTTP `/mcp`        │
│             · SSE `/sse` · `/ui` + `/api`     │
│             无业务逻辑（REST 转发 control）    │
└──────────────────────┬───────────────────────┘
                       │
┌──────────────────────▼───────────────────────┐
│ control     mcp_* · discovery_* · schema_import│
│             policy / security plane · REST     │
└───────────┬──────────────────────┬───────────┘
            │                      │
            ▼                      ▼
┌───────────────────┐   ┌──────────────────────┐
│ catalog           │   │ discovery            │
│ 注册表 · 持久化    │   │ host probe · suggest │
│ 校验 · list_changed│   │ schema_import        │
└─────────┬─────────┘   └──────────────────────┘
          │ factories via runtime/bootstrap
┌─────────▼────────────────────────────────────┐
│ runtime   types · errors · auth · load · log │
│           invoke middleware (timeout/normalize)
└─────────┬────────────────────────────────────┘
          │
┌─────────▼────────────────────────────────────┐
│ adapters  SPI + 扁平协议实现                  │
│           可选 pack：http / rpc / messaging / │
│           industrial / data                   │
└──────────────────────────────────────────────┘
```

## 依赖规则

允许的方向（箭头 = import）：

```
transport  →  control  →  catalog
control    →  discovery     （probe / scan / suggest / add_from_discovery / schema_import）
catalog    →  runtime/bootstrap  →  adapters   （工厂注册，不直接 import adapters/index 以外的实现）
adapters   →  runtime 叶子模块（types / errors / auth / load）
```

硬约束：

- **adapters 不得 import control 或 transport**
- **runtime 叶子模块不得 import adapters**（避免环）。唯一的 runtime→adapters 边是 `runtime/bootstrap.ts`
- **transport 不含注册表、协议或管理工具逻辑**；只负责把已创建的 MCP `Server` 接到某种传输上
- 进程入口 `src/index.ts` 调用 `transport.startFromConfig()`（默认 stdio；`EVERYTHING2MCP_TRANSPORT=http|sse` 则绑 HTTP 监听），由 transport 再调 `control.createEverything2McpServer`

`src/core/` 与 `src/management/` **shim 已删除**。入口与测试一律从 `transport` / `control` / `catalog` / `runtime` / `discovery` / `adapters` 导入。

## 1. transport

| 文件 | 职责 |
| --- | --- |
| `stdio.ts` | `attachStdio(server)` — 官方 `StdioServerTransport` |
| `http.ts` | `listenMcpHttp`：官方 `StreamableHTTPServerTransport`（`/mcp`）+ 遗留 `SSEServerTransport`（`/sse` + `/messages`）+ 同进程 `/ui` SPA 与 `/api/*`（转发 `handleConsoleRest`）；可选 Bearer / `x-api-key` |
| `static-ui.ts` | 从 `dist/ui` 提供控制台静态资源；未构建时返回 503 说明 |
| `index.ts` | `startStdio()` / `startHttp()` / `startFromConfig()` |

## 2. control

管理 MCP 工具（已全部挂上，不是 stub）：`mcp_list`、`mcp_add`、`mcp_update`、`mcp_remove`、`mcp_query_by_protocol`、`mcp_health`、`mcp_explain_tool`、`mcp_plan_bridge`、`mcp_add_from_discovery`、`mcp_blacklist_*`、`schema_import`、`discovery_probe`、`discovery_scan_host`、`discovery_suggest`。

- `server.ts`：ListTools / CallTool、`tools.listChanged`
- `tools.ts`：管理工具 schema 与实现；`mcp_list` 的 `audience=console` **仅**当 actor 是 console 时生效（防 Agent 伪造，ADR 0002）
- `layers.ts`：`_meta.layer` = management | business；`mcp_list { layer }`
- `policy.ts`：网段扫描拒绝；预留注册 allowlist hook（今日 no-op，闸在黑名单 + SSRF）
- `security/`：Policy Gateway（Safe/Full、内置模块、HMAC 完整性）；v1 只加载 builtins
- `rest.ts`：控制台 REST，复用 `callManagementTool`（入口强制 `actor.kind=console`）
- `redact.ts`：REST 响应密钥脱敏（含 `jwt` / `tlsKey`）

Agent 黄金路径（P5）：`mcp_plan_bridge` → `discovery_scan_host` → `mcp_add_from_discovery` / `schema_import` → `mcp_health` / `mcp_explain_tool`。证明：`tests/p5-golden-path.test.ts`。

## 3. catalog

- `registry.ts`：热注册、`{protocol}.{name}.{op}` 索引、调用时走 `invokeWithMiddleware`
- `store.ts`：`data/registrations.json`
- `validate.ts`：`mcp_add` 配置校验
- `config.ts`：`EVERYTHING2MCP_*` 环境变量

某个端点 restore 失败不会拖垮进程，会以 `restore_failed` 出现在 `mcp_list`。

## 4. discovery

- `probe.ts`：单主机 OpenAPI / SOAP / GraphQL 短超时探测；网段默认拒绝
- `scan` / 指纹：单主机并行探测（端口表见 `docs/DISCOVERY.md`，含 Phase U：Solr 8983、RabbitMQ management 15672、Kubernetes 6443）
- `suggest.ts`：把 candidate 映射成 `mcp_add` 形状；已挂成 MCP 工具 `discovery_suggest`
- `import.ts`：`schema_import` 解析 OpenAPI / WSDL / proto / GraphQL SDL / AsyncAPI，可随后走同一 `mcp_add` 闸

mDNS **组播浏览**仍禁用（单播 `host:5353` 已有）。SSDP 是对单主机 **unicast M-SEARCH :1900**（不是 `239.255.255.250`）。不扫描 CIDR。`allowRegistration` 仍是预留 no-op。NFS 无适配器。

## 5. runtime + adapters

### runtime

共享内核，无协议实现：

- `types.ts` / `errors.ts` / `auth.ts` / `load.ts` / `log.ts`
- `invoke.ts`：`AdapterError.from` + 可选 `timeoutMs` + invoke success/fail 审计计数（`runtime/metrics.ts`）
- 错误码表：`docs/ERRORS.md`
- `bootstrap.ts`：`registerBuiltinAdapters` / `createAdapter` / `knownProtocols`

认证是占位 hook：适配器把 bearer / apiKey / basic 写进 header。没有密钥保险箱。

### Adapter SPI

```ts
interface ProtocolAdapter {
  readonly id: string;
  readonly protocol: string;
  connect(config: Record<string, unknown>): Promise<void>;
  disconnect(): Promise<void>;
  discover?(): Promise<DiscoveredTool[]>;
  listTools(): Promise<McpToolSchema[]>;
  invoke(toolName: string, args: Record<string, unknown>): Promise<unknown>;
  health?(): Promise<{ ok: boolean; detail?: string }>;
}
```

工厂：`registerAdapterFactory("openapi", (id) => new OpenApiAdapter(id))`。

`mcp_add` 用 `protocol` 找到工厂、`connect(config)`、把 `listTools()` 本地名加上前缀：

```
{protocol}.{name}.{operationId}     例如 openapi.widgets.getWidget
```

注册 id：`{protocol}:{name}`。

协议实现目录保持扁平：`src/adapters/<protocol>/`。`src/adapters/packs.ts` 只做分组 overlay：

| Pack | protocols（`src/adapters/packs.ts` overlay，实现仍扁平） |
| --- | --- |
| http | openapi, http, graphql, soap, webdav, caldav, carddav |
| rpc | grpc, xmlrpc, jsonrpc |
| messaging | mqtt, amqp, kafka, nats, websocket, ws, asyncapi, sparkplug, sqs, pulsar, imap, pop3, **rabbitmq（management HTTP，不是 AMQP）** |
| industrial | opcua, modbus, coap, fix, bacnet, ethernetip, s7, mtconnect, snmp |
| data | sqlite/postgres/mysql/…、mongodb、redis、elasticsearch/opensearch、clickhouse、neo4j、qdrant、s3/gcs/oss、influx、prometheus、smtp、ldap、ftp、etcd、consul、azureblob、sftp、memcached、tftp、beanstalkd、zookeeper、dns、cassandra、couchdb、whois、**solr**、**kubernetes / k8s** |

新增协议 = 实现 SPI + 一行 `registerAdapterFactory`。不要改 server 的业务 tool 列表。

## 热更新语义

| 动作 | 行为 |
| --- | --- |
| add | connect → 建 tool 索引 → 写 store → list_changed |
| update | disconnect → 合并 config → connect → 替换索引 |
| remove | disconnect → 删索引 → 删 store |

不需要重启 Node 进程。MCP 客户端是否立刻刷新工具列表取决于它是否处理 `list_changed`；即使不处理，下一次 `tools/list` 也会是新集合。

## 数据流（调用）

1. Client `tools/call` `openapi.widgets.getWidget` `{ "id": "1" }`
2. Catalog 查索引 → `openapi:widgets` + 本地名 `getWidget`
3. `invokeWithMiddleware` → OpenAPI 适配器填 path/query/header，带 auth 发 HTTP
4. 结果 JSON 文本作为 MCP `content[].text` 返回

## 非目标

这些是产品硬约束或有意不做，不是「还没写到」：

- 多租户、完整 OAuth、密钥保险箱（同进程 `/ui` 控制台已做；无独立 GUI 进程）
- 主动全网扫描 / CIDR UI / 复活 `ALLOW_SCAN`
- 为每个协议都做完整实现（见 `PROTOCOLS.md` Implemented vs Thin）
- Kafka 真 EOS / cooperative rebalance、SQL CI Docker 真库、LDAP GSSAPI
- v2/v3 外部安全插件加载、Agent 写 challenge、NFS、mDNS 组播浏览
- 重新引入 `src/core` / `src/management` shim

AsyncAPI、Sparkplug、`mcp_plan_bridge` / `discovery_suggest` / `mcp_add_from_discovery` **已经落地**（早期 ADR 里「推迟」是历史，见 `docs/adr/0001-five-package-layout.md`）。
