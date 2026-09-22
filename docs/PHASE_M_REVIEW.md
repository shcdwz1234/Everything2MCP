# Phase M — 审查与设计补充

> **历史纪要（Phase M）。** 当前产品已推进到 **Phase W**（热加载核心 + 能力积压 P1–P5）。本页只记录 M 当时的可证伪结论，不当成最新协议矩阵。最新状态见 [ROADMAP.md](ROADMAP.md)、[PROTOCOLS.md](PROTOCOLS.md)、[AUDIT.md](AUDIT.md)。

对照 `ARCHITECTURE` / `SECURITY_ARCHITECTURE` / `AUDIT` / `PROTOCOLS` 的实现审查。只记**可证伪**结论。状态三档：**已实现** / **有意不做** / **需环境**。

## 本轮修了什么（已实现）

| 缺口 | 证据 | 修复 |
| --- | --- | --- |
| Agent 伪造 `mcp_list { audience: "console" }` 看见已拉黑 tools | `callManagementTool` 只看 `args.audience`，不看 `actor.kind` | 操作员视图 = `actor.kind === "console"` **且** `audience === "console"`。MCP stdio 固定 `mcp-stdio`；REST 入口强制 `console` |
| `mcp_explain_tool` 返回已拉黑业务 tool 的 schema | Agent 知道全名就能读 inputSchema | 非 console actor → `assertNotBlacklisted` → `E_BLACKLISTED` |
| `mcp_query_by_protocol` / `mcp_health` / `mcp_list` 的 `adapters[].tools` 漏出已隐藏名 | list 过滤了 `tools[]`，适配器行仍带全名 | Agent 视图同步剥 `adapters[].tools` / `toolCount` |
| `mcp_health.toolLayers.hiddenBlacklisted` 向 Agent 泄露隐藏数量 | 计数本身是情报 | 仅 console 返回该字段；Agent 的 `business`/`toolCount` 用可见数 |
| `jwt` / `tlsKey` 未脱敏 | `isSecretKey` 不匹配 | 精确加入 `EXACT_SECRET`（不泛化 `key`，避免 `partitionKey`） |
| `ARCHITECTURE` 仍写 `import.ts` stub | `schema_import` 已走 `discovery/import.ts` | 文档改成已实现 |

证明：`tests/security-plane.test.ts`（spoof / explain / query / health / REST 仍列黑名单 tools）、`tests/console-rest.test.ts` + `tests/s2-hardening.test.ts`（jwt/tlsKey）。

## 结构性约定（ADR 短文）

详见 [adr/0002-actor-bound-audience.md](adr/0002-actor-bound-audience.md)。

**Audience 不是请求参数，是 actor 属性。** Agent 传 `audience: "console"` 无效。控制台 REST 不依赖查询串；`handleConsoleRest` 写入 `actor.kind=console`。

**完整性账本不封 `audit.jsonl`。** `INTEGRITY_WATCH` = `security.json` / `blacklist.json` / `registrations.json`。审计是追加日志，封账会要求轮转或把每次 append 当变异文件——**有意不做**。无密钥时 SHA-256 仍可双写伪造（已文档）。

**`allowRegistration` 仍是 no-op hook。** 真正闸在黑名单 + SSRF + `assertConfigTargetsAllowed`。**有意不做**平行 allowlist（未提需求）。

## 对照后未改（不是漏修）

| 项 | 档 | 理由 |
| --- | --- | --- |
| Kafka 真 EOS / rebalance | 需环境 | 无集群；live 事务保持 `E_UNSUPPORTED` |
| SQL CI Docker 真库 | 需环境 | 无 Docker / `pg` / `mysql2` |
| LDAP GSSAPI | 有意不做 | 无 Kerberos 依赖，不 stub |
| v2 本地 JS / v3 npm | 有意不做 | loader 钩子在；非 builtin → `E_UNSUPPORTED` |
| MCP Agent 写 challenge | 有意不做 | 控制台才有 `confirm:true` |
| CIDR / `ALLOW_SCAN` | 有意不做 | 死变量；Safe 与 Full 都拒网段 |
| Full 打开全局写 | 有意不做 | 适配器 `assertCanWrite` 不 bypass |
| 账本覆盖 audit.jsonl | 有意不做 | 见上 |
| mDNS 组播 / SSDP 组播 | 有意不做 | **组播浏览**仍关。Phase N/O 已加 **SSDP 单播 M-SEARCH :1900** 与 **mDNS 单播 host:5353**；`mdnsMulticastBrowse()` 仍 `E_UNSUPPORTED` |

## 仍欠（仅真缺口）

与 Phase L 相同的环境/产品边界，**没有**新的可测代码债：

1. Kafka 真协调器（需集群）
2. SQL 真库 CI（需 Docker 与驱动）
3. LDAP GSSAPI（需 Kerberos，明确不做）
4. v2/v3 外部模块真加载（明确不做）
5. Agent 写 challenge（明确不做）

无 CIDR UI。默认 `allowWrite=false`。无 shim。transport 未改。NFS 无适配器（后续阶段也未做）。
