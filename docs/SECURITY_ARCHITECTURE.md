# 安全架构

**当前快照：控制台改版。** 黑名单扩展为目标 / 能力实例 / 工具三种粒度（仍在 Full 下生效）；新增控制台私网**自动发现**（L5 修订，见下）；能力可**停用**（保留注册）。热加载走 Policy Gateway。`auto:true` **不能**在 Full / 可写 / Partner `riskCeiling=write|desktop` / 黑名单时自动注册。扫描与 Compat **不**授予 write/desktop/secrets。个人微信私聊不是 Partner 兼容面。

S1 **已落地** Policy Gateway（`src/control/security/`）：`safe`/`full` 热切换、内置模块、Agent `tools/list` 过滤。R4 补了 SHA-256 账本并硬关掉 `ALLOW_SCAN`。S2 补了可选 HMAC、`registrations.json` 入账、审计 JSONL、真限流、`secret-redact` 模块。Phase M 把 audience 绑到 actor。本文仍是实现合同；**S3/S4（外部 JS/npm）有意不做**（v1 builtins only）。不重开 `ALLOW_SCAN` / shim / 全局写；Agent 侧 CIDR 仍永不放行（控制台自动发现见 L5 修订）。

原则：

- **默认 Safe**。数据面默认 `allowWrite=false`（自动发现的候选也一律只读）。
- **deny-wins**：任一模块 `deny` 即拒绝。
- **锁定模块不可关、不可在 Full 下 bypass**：`core-auth` / `core-audit` / `core-integrity`。
- **内置黑名单在 Full 下同样生效**（`bypassInFullControl: false`）。不是 core 锁定模块（控制台仍可增删条目），但模式不能跳过它。
- **Agent 侧 CIDR 永不放行**（Safe 与 Full 一样）。`EVERYTHING2MCP_DISCOVERY_ALLOW_SCAN` 是**死变量**：`loadAppConfig` 与 `createEverything2McpServer` 强制 `allowScan=false`，`assertHostProbeAllowed` 忽略第二参。网段只在控制台**自动发现**里、按私网规则展开（L5 修订）。
- **Full ≠ 全局可写**（L6）。平面 `allow-write` 可在 Full 跳过；适配器 `assertCanWrite` / `allowWriteFrom` **仍闸写**。
- **热加载优先**：模式、安全模块、黑名单条目都不要求重启进程。
- **不把 mode 暴露成普通 MCP tool**。

相关现状：[BLACKLIST.md](BLACKLIST.md)、[DISCOVERY.md](DISCOVERY.md)、[CONSOLE.md](CONSOLE.md)、[ERRORS.md](ERRORS.md)、[ARCHITECTURE.md](ARCHITECTURE.md)。

---

## 锁定决策

以下已拍板，后续实现与文档不得再写成「建议 / 待决 / Full 可跳过黑名单」。

| # | 决策 |
| --- | --- |
| L1 | **Full 仍执行黑名单。** 内置模块 id 建议 `builtin-blacklist`（下文亦写 `blacklist`）。`bypassInFullControl` **必须为 `false`**。`locked` 为 `false`：操作员可通过控制台管理条目，但不能靠切 Full 关掉评估。 |
| L2 | **黑名单语义（Safe 与 Full 相同）：** ① 不能再 `mcp_add` / `capability_register` / POST `/api/adapters` / POST `/api/capabilities/register` / 发现一键注册命中目标；② **不对 Agent 暴露**这些适配器的业务 tools：`tools/list` / `mcp_list` 过滤掉，`invoke` / `tools/call` deny（`E_BLACKLISTED`）；③ **控制台**可以列表、加入、解除拉黑（「能力 → 黑名单」tab 与 `mcp_blacklist_*` / `/api/blacklist`；另有能力实例与工具粒度，见 BLACKLIST.md）。 |
| L3 | **插件 SPI 按可对外 inject / replace 设计。** v1 **只交付内置模块**；加载器与配置钩子（`inject` / `replace` / `remove` / `security.json` 的 `modules[]`）先留接口，拒绝非 builtin 源，不实现本地 JS / npm 执行。 |
| L4 | **热加载优先：** 改 mode、inject/replace 模块、增删黑名单，均在下一跳 hook（及下一次 `tools/list`）生效，不重启进程。黑名单文件与内存 store 以热读为准。 |
| L5 | **Agent 侧 CIDR 永不放行**（两模式）。`discovery_scan_host` / `discovery_probe` / 单主机向导只接受一个 host；`EVERYTHING2MCP_DISCOVERY_ALLOW_SCAN` 不能重新打开。**修订（控制台改版，用户批准）：** 控制台「设置 → 自动发现」可以扫私网——RFC1918 / CGNAT / 本机，网卡子网 ≤ /24，手动 CIDR ≤ /16，每轮主机上限（默认 256，最大 1024），公网需显式 `allowPublic`；link-local 与云 metadata 永不扫描；mDNS / SSDP 组播有界（TTL=1，只收私网应答者）。范围只能由控制台（actor=console）或启动环境变量配置，Agent 没有入口；每轮过 `discover` 钩子一次；发现结果只进候选列表、只读，默认不自动启用。规则见 [DISCOVERY.md](DISCOVERY.md#自动发现auto-discovery)。 |
| L6 | **Full ≠ 全局写开。** 平面模块 `allow-write` 标了 `bypassInFullControl`（Full 跳过平面层 deny）。适配器仍走 `assertCanWrite` / `allowWriteFrom`，默认 `allowWrite=false`。切 Full **不得**把现有注册改成可写，也不得省略适配器写闸。 |

与旧脑暴稿不一致处（例如「Full 可 bypass 黑名单」「Full 下新建可不拦」「切 Full 等于 root / 全局 allowWrite」）作废，以本表为准。

---

## 1. Safe vs Full Control

进程有一个控制面模式：`safe` | `full`。建议默认 **`safe`**，写入 `dataDir/security.json`（与 `registrations.json` / `blacklist.json` 同级），**热切换**后下一跳 hook 立即按新模式评估。

| | Safe（默认） | Full Control |
| --- | --- | --- |
| 意图 | 给 Agent / 共享控制台用：发现、注册、调用都被策略闸住 | 给操作员本地排障：少挡「已知目标」中**标了 `bypassInFullControl` 的模块**，**不是**关掉安全平面 |
| Token | 若配置了 `EVERYTHING2MCP_HTTP_TOKEN`，`/api` 与 MCP HTTP/SSE **仍要** | **仍要**（`core-auth` 锁定） |
| 审计 | invoke / 管理变更写入审计 | **仍要**（`core-audit` 锁定） |
| Integrity | 目录与安全状态校验 | **仍要**（`core-integrity` 锁定） |
| `bypassInFullControl` 模块 | 全部生效 | 可跳过（见 §5）。**未**标 bypass 的模块照常评估 |
| CIDR / 网段 / `*` / 逗号列表（Agent 工具） | 拒绝 | **仍拒绝**。Full 不能让 Agent 扫网段 |
| 控制台自动发现 | 按私网规则（L5 修订） | 同 Safe，Full 不放宽范围规则 |
| 黑名单 `builtin-blacklist` | 拦新建、发现一键添加、**从 Agent 工具列表隐藏**、**invoke deny** | **同样全部生效**（L1 / L2）。Full 不跳过 |
| `allowWrite` | 适配器未显式 `true` 则写路径失败 | **仍尊重**每适配器 `allowWrite`（L6）。平面 `allow-write` 在 Full 跳过；`assertCanWrite` 不跳过 |

Full **不是** root：不能关 Token、不能关审计、不能关 integrity、不能让 Agent 做 CIDR、**不能跳过黑名单**、**不能全局打开写**。能做的是跳过标了 `bypassInFullControl` 的**其它**策略模块（`allow-write` 平面层、`dangerous-tools` challenge、`rate-limit` stub）。写路径最后一道闸永远是适配器 `assertCanWrite`。

切换必须：

1. 控制台「安全」页或专用 REST（建议 `POST /api/security/mode`），**不是** `mcp_*` 业务/普通管理 tool。
2. 二次确认 + 现有 HTTP token。
3. 记一条 `modeChange` 审计（谁、从哪到哪、何时）。
4. **热切换**，不重启。stdio 宿主若没有控制台，用环境变量只作**启动初值**，运行中仍走同一 REST / 本地文件，避免 Agent 自行改模式。

---

## 2. Security Plane 与 Hook

安全平面是 control 里的一条评估链，挂在现有入口之外，**不**另起进程、不复制 catalog。

```
transport（token）     → hook: auth
discovery_scan/probe   → hook: discover
mcp_add / update       → hook: register
mcp_remove / unregister → hook: unregister
schema_import          → hook: import
tools/list · mcp_list  → hook: list
ToolRegistry.invoke    → hook: invoke
控制台改模式           → hook: modeChange
模块 inject/replace    → 热加载后对后续 hook 生效
```

| Hook | 何时 | 落点 |
| --- | --- | --- |
| `auth` | HTTP/SSE `/api`、`/mcp`、`/sse` 在进业务前 | `src/transport/http.ts`：`EVERYTHING2MCP_HTTP_TOKEN`；`GET /health` 与静态 `/ui` 仍不鉴权 |
| `discover` | `discovery_scan_host` / `discovery_probe` / `discovery_suggest`（先扫再建议时） | 平面 `assert` + `assertProbeTarget(host, false)` + SSRF；黑名单 `decorateCandidates` |
| `register` | `mcp_add` / `mcp_update` / `mcp_add_from_discovery` / `capability_register` / POST `/api/adapters` / POST `/api/capabilities/register` | 平面 `assert` + `assertConfigTargetsAllowed` + `assertNotBlacklisted` + `validateRegistration`。`auto:true` 额外要求 Safe + `allowWrite`/`allowShell`/`allowDesktop`/`allowReadSecrets` 非 true |
| `unregister` | `mcp_remove` / `capability_unregister` / POST `/api/capabilities/unregister` / DELETE `/api/capabilities/:id` / DELETE `/api/adapters/:id` | 平面 `assert`（`core-audit` / `core-integrity` / `secret-redact`）。**不**跑黑名单 deny、**不**要求 `allowWrite`。控制台 REST 要 `confirm:true`。缺 id → `E_NOT_FOUND`。成功记审计 `kind=unregister` |
| `import` | `schema_import` 解析与（可选）随后 `add` | 平面 `assert` + `discovery/import` 然后走同一 `register` |
| `list` | MCP `tools/list`、`mcp_list`（默认 audience=`agent`） | `SecurityPlane.hideAgentTools`。操作员视图要求 `actor.kind=console`（REST 入口写入）。Agent 传 `audience: "console"` **无效**。`mcp_explain_tool` / `mcp_query_by_protocol` / `mcp_health` 对 Agent 同样藏名 |
| `invoke` | 业务 `tools/call` 与 `POST /api/tools/:name/invoke` | 平面 `assert`（含 integrity + 黑名单）→ `ToolRegistry.invoke`（再拦黑名单）→ 适配器 `assertCanWrite` / RPC 写闸；控制台写还要 `confirm:true` |
| `modeChange` | 操作员改 Safe/Full | `PUT /api/security/mode` + `confirm:true`。**不是** MCP tool |

建议顺序（每个 hook 内）：锁定模块 → 其他模块 → deny-wins 折叠。`core-audit` 在决策**之后**也记一笔（允许 / 拒绝 / challenge），避免「被 deny 就没日志」。

`list` 的 deny 含义是「从返回列表里拿掉」，不是 403 整张表。过滤后 Agent 看不见黑名单目标上的 `protocol.name.*`。控制台适配器页仍可显示「已拉黑」标记（操作员视图，不是 Agent 工具面）。

```
                    ┌─────────────┐
   MCP / REST 入口 ─►│ Security    │
                    │ Plane       │
                    │ evaluate()  │
                    └──────┬──────┘
           allow           │ deny / challenge
             │             │
             ▼             ▼
        原 control     AdapterError
        业务路径       或控制台二次确认
        list 则剔除    （list：静默过滤）
```

---

## 3. SecurityModule SPI

类型在 `src/control/security/types.ts`。adapters **不得** import 本目录。

```ts
export type ControlMode = "safe" | "full";

export type SecurityHook =
  | "auth"
  | "discover"
  | "register"
  | "unregister"
  | "invoke"
  | "import"
  | "list"
  | "modeChange";

export type PolicyEffect = "allow" | "deny" | "challenge";

export type ModuleSource = "builtin" | "file" | "package";

export interface PolicyContext {
  mode: ControlMode;
  hook: SecurityHook;
  requestId?: string;
  actor: {
    kind: "http-token" | "mcp-stdio" | "console";
    tokenPresent: boolean;
  };
  target?: {
    protocol?: string;
    host?: string;
    port?: number;
    url?: string;
    adapterId?: string;
    blacklistId?: string;
  };
  tool?: {
    name: string;
    layer: "management" | "business";
    write?: boolean;
  };
  /** list hook：待过滤的业务 tool 快照 */
  listedTools?: Array<{ name: string; adapterId?: string; protocol?: string }>;
  config?: Record<string, unknown>;
  /** 操作员在 challenge 之后回传，例如控制台 confirm:true */
  challengeSatisfied?: boolean;
}

export interface PolicyDecision {
  effect: PolicyEffect;
  /** 与 docs/ERRORS.md 对齐；deny 时必填（list 过滤可用 E_BLACKLISTED 仅作原因，不整表失败） */
  code?: string;
  reason: string;
  moduleId: string;
  /** list hook：要从 Agent 视图拿掉的 tool 名 */
  hideTools?: string[];
  challenge?: {
    kind: "confirm" | "reauth";
    hint: string;
  };
}

export interface SecurityModule {
  readonly id: string;
  readonly hooks: readonly SecurityHook[];
  /** 不可禁用、不可在 Full 下 bypass；插件不得自称 locked */
  readonly locked?: boolean;
  /** 仅当 mode=full 且 locked≠true 时跳过 evaluate。builtin-blacklist 必须为 false */
  readonly bypassInFullControl?: boolean;
  evaluate(ctx: PolicyContext): Promise<PolicyDecision>;
}

/** 对外 inject / replace。v1 只接受 source=builtin */
export interface SecurityModuleLoader {
  list(): Array<{ id: string; source: ModuleSource; builtin: boolean }>;
  /** 注入；同 id 且 replace≠true 则冲突 */
  inject(module: SecurityModule, opts?: { source?: ModuleSource; replace?: boolean }): Promise<void>;
  replace(id: string, module: SecurityModule): Promise<void>;
  /** 不可 remove locked；v1 对非 builtin 直接 E_UNSUPPORTED */
  remove(id: string): Promise<void>;
  /** 热加载：重新读 security.json / 模块表，不重启 */
  reload(): Promise<void>;
}

export interface SecurityPlane {
  mode(): ControlMode;
  setMode(next: ControlMode, ctx: PolicyContext): Promise<PolicyDecision>;
  evaluate(ctx: PolicyContext): Promise<PolicyDecision>;
  loader: SecurityModuleLoader;
}

/** dataDir/security.json — v1 只认 mode；modules[] 预留 */
export interface SecurityFile {
  version: 1;
  mode: ControlMode;
  modules?: Array<{
    id: string;
    enabled?: boolean;
    source?: ModuleSource;
    path?: string;
    package?: string;
  }>;
}
```

`challenge`：Safe 下写操作 / 危险 tool 先返回 challenge，控制台已有原型（`confirm:true`）。未满足则当 deny（`E_INVALID_ARGUMENT` 或日后 `E_CHALLENGE`）。MCP Agent 默认拿不到「点确认」——这是有意的，避免模型自己点过闸。

---

## 4. 组合规则与锁定模块

**deny-wins**（同一 hook）：

1. 收集所有应当运行的模块决策（Full 下跳过 `bypassInFullControl && !locked`）。`builtin-blacklist` **始终进入收集**。
2. 任一 `deny` → 整单 `deny`，带上**第一个**（或最严重的）`code` / `reason`。`list` hook 把各模块 `hideTools` 并集掉，不因过滤而 fail 整次 list。
3. 否则任一 `challenge` 且未 `challengeSatisfied` → `challenge`。
4. 否则 `allow`。

没有「一票允许」。模块不能互相 override deny。插件不能把锁定模块或 `builtin-blacklist` 的 deny 改成 allow（replace 锁定 id → 失败）。

| 锁定 id | 职责 | Full 下 |
| --- | --- | --- |
| `core-auth` | HTTP token 比对；stdio 视为本机信任但仍记 actor | 不可 bypass |
| `core-audit` | 计数 + 进程内环形（截断 200）+ `dataDir/audit.jsonl` 追加持久化 | 不可 bypass、不可静音 |
| `core-integrity` | `security.json` / `blacklist.json` / `registrations.json` 的 SHA-256 账本；有密钥时 HMAC-SHA256 + 账本 MAC | 不可 bypass；损坏则拒绝 restore / reload / discover / register / import / invoke / modeChange |

`builtin-blacklist` **不是**上表锁定模块：控制台可以改条目。它也 **不是** Full-bypass 模块：评估永不因 mode=full 而跳过。

禁用、卸载、降级锁定模块 → 启动失败或 `E_UNSUPPORTED`。锁定名单写死在平面里，不从插件配置读取。v1 `remove('builtin-blacklist')` 建议拒绝（模块常驻，只热加载条目）。

---

## 5. 内置模块与现有能力映射

「现状」= 模块已注册进 `SecurityPlane` 的行为。

| 模块 id | Hooks | `bypassInFullControl` | locked | 现状映射 |
| --- | --- | --- | --- | --- |
| `core-auth` | auth | 否 | 是 | `EVERYTHING2MCP_HTTP_TOKEN` + Bearer / `x-api-key`；未配置 token 时开站（与今相同） |
| `core-audit` | 全部（决策后记 `policy` / `mode_change`） | 否 | 是 | `src/runtime/metrics.ts` `invokeAudit` + `dataDir/audit.jsonl` 追加（启动重载）；`GET /api/audit` / `#/audit`。进程内环形截断 200 条作即时视图；**账本不封 audit.jsonl**（有意） |
| `core-integrity` | discover, register, import, invoke, modeChange + 启动 restore / reload | 否 | 是 | `IntegrityLedger`：默认 SHA-256（无密钥时首次见到封存）。`EVERYTHING2MCP_INTEGRITY_KEY` 或 `dataDir/.integrity-key` → HMAC-SHA256，账本带 `mac`；改目标或 `integrity.json` 都失败。监视 `security.json` / `blacklist.json` / `registrations.json` |
| `allow-write` | invoke | **是**（仅平面层） | 否 | 平面 deny「`allowWrite` 不是 true」。Full 跳过**这一层**。适配器 `assertCanWrite` **仍闸**（L6） |
| `builtin-blacklist` | discover, register, list, invoke | **否（L1）** | 否 | `BlacklistStore`（kind = target / capability / tool）、`assertNotBlacklisted`、`matchSubject`、`decorateCandidates`、`hideAgentTools`；tool glob 只在 list / invoke 生效；`E_BLACKLISTED` |
| `ssrf` | discover, register, import | 否 | 否（默认永不关） | `src/runtime/ssrf.ts`：云 metadata / link-local |
| `discovery-scope` | discover | **否（Agent 侧 CIDR 永不放行）** | 视为产品硬约束 | `looksLikeNetworkRange` + `assertHostProbeAllowed`；`allowScan` 死变量。控制台自动发现的范围规则在 `src/discovery/netscope.ts`（L5 修订） |
| `dangerous-tools` | invoke | 是（跳过 challenge） | 否 | 控制台 REST 仍要求 `confirm:true`（在平面之外）；MCP Agent 没有确认 UI |
| `secret-redact` | register, invoke, import, list, modeChange | 否 | 否 | 审计 JSONL / 进程日志 / REST 响应走 `redactSecrets`（token、password 等） |
| `rate-limit` | invoke, discover | **是**（L：Full 可跳过） | 否 | 滑窗：默认 60 invoke / 20 discover 每分钟；`0` = 不限；env `EVERYTHING2MCP_RATE_LIMIT_*` |
| `tls-material` | register | 否 | 否 | `watchTlsMaterial` 热重读 PEM；gRPC `tlsWatch` 进程内 remount ChannelCredentials（bidi 会断）；remount 失败才要 `mcp_update`（见 `docs/TLS.md`） |

管理工具分层（`_meta.layer=management`）继续避免把 `mcp_*` 冲进 Agent 默认列表。黑名单**管理**工具（`mcp_blacklist_*`）给控制台 / 带 token 的操作员用，默认不要进 Agent 业务层。这是目录卫生，与 L2「对 Agent 隐藏已拉黑目标的**业务** tools」互补。

---

## 6. 插件加载演进

平面只加载**声明了 `SecurityModule` 的策略**，不加载适配器、不 `eval` 业务协议。SPI 按外部 **inject / replace** 设计（L3）；**v1 只注册内置表**，调用 `inject({ source: 'file' \| 'package' })` 或配置里的非 builtin 源 → `E_UNSUPPORTED`，钩子留下给 S3/S4。

| 阶段 | 来源 | 约束 |
| --- | --- | --- |
| **v1 内置** | `registerBuiltinSecurityModules()` | 无动态代码。`SecurityModuleLoader` 与 `security.json.modules[]` **接口保留**。锁定模块与 `builtin-blacklist` 只存在于此 |
| **v2 本地 JS** | `dataDir/security-modules/*.js`（或显式路径白名单） | 走已留的 `inject`/`replace`/`reload`；ESM；只能 import 平面公开的 `types`；**禁止** import `adapters` / `transport`；超时 + 无网；签名/哈希列入 `core-integrity` |
| **v3 npm 包** | `package.json` 的 `everything2mcp.securityModules` 或 `EVERYTHING2MCP_SECURITY_PACKAGES` | 同一 loader；仅允许 scoped / 钉版本；同样不能碰 adapters；安装与校验在进程外完成 |

热加载（L4）：`loader.reload()` / `inject` / `replace` 更新内存表后，不必重启；已建立的 MCP 会话在下一次 `tools/list` 或 `invoke` 看到新决策。黑名单 store 增删同样热生效（与现 `BlacklistStore` 内存+JSON 一致）。

加载失败：该插件视为 `deny` 还是跳过？**建议默认 fail-closed（当 deny）**，锁定模块加载失败则拒绝启动。v1 因为没有外部模块，这条只约束预留钩子的错误处理。

插件不能设置 `locked: true`（忽略或启动失败）。不能 `replace('core-auth' | …)`。不能把 `discovery-scope` 改成允许 CIDR。不能把 `builtin-blacklist.bypassInFullControl` 改成 `true`。

---

## 7. 控制台「安全」设置与模式 UX

`#/security`（侧栏「安全」）S1 已落地，深色风格与现控制台一致（`#0B0F14` / `#121820` / `#3DD6C6`）。

| 区块 | 内容 |
| --- | --- |
| 模式 | 大号 Safe / Full 开关。当前模式胶囊（顶栏亦可：`SAFE` / `FULL`） |
| 切换 | 必须二次确认文案：「Full 仍要 Token、审计与**黑名单**；不会让 Agent 扫网段。」确认后 `POST` 专用 API（热生效） |
| 锁定模块 | 只读表：auth / audit / integrity 永远开 |
| 可 bypass 模块 | 列出 **rate-limit 等**及「Full 下是否跳过」。**不要**把黑名单画成可跳过 |
| 黑名单 | 链到 **能力 → 黑名单** tab（L2：控制台可管理）。写明「Agent 看不到已拉黑目标 / 能力 / 工具」 |
| 模块 | v1 只读内置表；预留「加载外部模块」灰态 |
| CIDR | 安全页与单主机向导**没有网段输入**。私网范围只在「设置 → 自动发现」（L5 修订） |
| 审计 | 最近 `modeChange` / 模块 reload + 链到 `#/audit` |

「设置」页可改自动发现设置并提供 Safe / Full 切换入口（同一二次确认 + 专用 API）；Discovery 页（高级）继续只有单个 host。

模式**不**出现在 `mcp_list` 默认业务层，也**不**做成 `mcp_set_mode` 一类普通管理 tool。若日后必须给自动化用，走带 token 的 REST，且默认不进 Agent 工具列表。

---

## 8. 威胁模型（简表）

| ID | 威胁 | 主要控制 | 现状 |
| --- | --- | --- | --- |
| T1 | 未授权 HTTP 调用管理/业务 API | `core-auth` token | 有（可选 token） |
| T2 | Agent 扫网段 / 打 metadata | `discovery-scope` + `ssrf` + netscope | 有；`ALLOW_SCAN` **硬禁用**（env / override 都不能让 Agent 做 CIDR）。自动发现只扫私网、永不扫 link-local / metadata，范围只能由控制台设置 |
| T3 | 把危险主机一键注册进 catalog | `builtin-blacklist` + `ssrf` on register | 有黑名单 + SSRF |
| T4 | 已挂载实例仍被调用或出现在 tools/list | `builtin-blacklist` on list + invoke；`allow-write` | Agent list 隐藏；控制台仍可见；invoke deny |
| T5 | 模型乱写（SQL / RPC / 队列） | `allow-write` + `dangerous-tools` + 控制台 challenge | 有硬闸；challenge 仅控制台 |
| T6 | 关掉审计后「没发生过」 | `core-audit` 锁定 | 有计数 + `audit.jsonl`；环形仍截断 200 条 |
| T7 | 改 `security.json` / `blacklist.json` / `registrations.json` 关策略 | `core-integrity` SHA-256；可选 HMAC | **有**。无密钥时双写账本仍可伪造；有密钥则账本 MAC 失败 |
| T8 | Agent 把模式打成 Full 以躲黑名单 | mode 非 MCP tool；**Full 仍执行黑名单**（L1） | **无模式**；黑名单两模式都将生效 |
| T9 | 插件/包逃逸进 adapters | v1 不加载外部代码；日后 v2/v3 沙箱 | loader 钩子预留、未执行外部模块 |
| T10 | 密钥出现在 REST / 审计 | `secret-redact` | REST 脱敏；审计不写密钥 |

不在范围内：把 Everything2MCP 当漏洞扫描器、默认全端口、默认 `allowWrite=true`、Host Application / 完整 Kafka EOS 等产品债（见 ROADMAP「明确不会做」）。

---

## 9. 阶段 S0–S4 与待决项

| 阶段 | 做什么 | 验收 |
| --- | --- | --- |
| **S0** | 本文（含锁定决策）；README / CONSOLE 已链到此处 | 完成 |
| **S1** | `SecurityPlane` + 预留 `SecurityModuleLoader`；内置模块；`list` 按 L2 过滤；`#/security` + `GET/PUT /api/security` | **完成**（`tests/security-plane.test.ts`）。Full 仍执行黑名单；CIDR 永不放行；非 builtin `inject` → `E_UNSUPPORTED` |
| **S2** | HMAC 可选、registrations 入账、审计 JSONL、真限流、secret-redact 进平面 | **完成**（`tests/s2-hardening.test.ts`） |
| **S3** | v2 本地 JS：真正执行已留的 inject/replace |
| **S4** | v3 npm 包 |

S1 已完成 list 过滤。R4 已完成轻量文件哈希 + ALLOW_SCAN 硬禁用。S2 已完成上表。未完成 S3 时不执行外部 JS。不改黑名单匹配规则（除非测红）。

**S2 之后仍欠（有意不做，不是漏实现）：** v2/v3 外部模块只留钩子；MCP Agent 写操作 challenge。无密钥时 SHA-256 账本仍可双写伪造（已文档）。gRPC `tlsWatch` 已进程内 remount ChannelCredentials。`tls-material` 热重读已落地。

Phase M 补强：audience 绑定 actor；explain/query/health 不再向 Agent 漏黑名单工具名；`jwt`/`tlsKey` 脱敏。审查纪要见 [PHASE_M_REVIEW.md](PHASE_M_REVIEW.md)。

### 已锁定（不再待决）

| 项 | 约定 |
| --- | --- |
| Full 与 `allowWrite` | **L6**：不全局打开写；平面 `allow-write` 可 bypass；适配器 `assertCanWrite` 不 bypass |
| `allowScan` 环境变量 | **死变量**。设置了只打 warning；`allowScan` 恒为 `false` |
| `list` 过滤是否也藏控制台适配器行 | 否。`GET /api/tools` 由 REST 写入 `actor.kind=console`；只对 **Agent 工具面**隐藏。Agent 不能靠 `audience` 参数升级 |
| 完整性账本是否封 `audit.jsonl` | **否（有意不做）**。`INTEGRITY_WATCH` 仅 security / blacklist / registrations。审计是追加日志 |
| `core-integrity` 算法 | 默认 SHA-256；有密钥则 HMAC-SHA256 + 账本 MAC |
| `rate-limit` | Safe 生效；**可以** `bypassInFullControl`（Full 跳过） |
| `tls-material` watch | **已做**：热重读 PEM；gRPC 进程内 remount；不是待决项 |

### 仍待决（产品债，不是安全平面缺口）

| 项 | 约定 |
| --- | --- |
| 外部模块 fail-closed | 加载失败当 deny；v1 碰非 builtin 源直接 `E_UNSUPPORTED`。**S3/S4 真加载有意不做** |
| MCP Agent 写 challenge | **有意不做**。只有控制台 `confirm:true` |
| `tls-material` watch | **已做**（不再待决）：热重读 PEM；gRPC `tlsWatch` 进程内 remount ChannelCredentials（打开的 bidi 会断）；remount 失败才要 `mcp_update`。见 [TLS.md](TLS.md) |

---

## 10. 与黑名单功能的关系

黑名单已经落地（`docs/BLACKLIST.md`）：`dataDir/blacklist.json`，匹配 `canonical protocol + 规范化 host + port`（或规范化 url），REST `/api/blacklist`，MCP `mcp_blacklist_*`，控制台「能力 → 黑名单」tab、当前能力行 / tools 抽屉 / 发现候选上的「加入黑名单」。改版后另有 `kind=capability`（`cap|<adapterId>`）与 `kind=tool`（glob）。

在本架构里它是 **`builtin-blacklist` 模块**，不是平行宇宙，也不是 Full 逃生口：

| 问题 | 约定（锁定） |
| --- | --- |
| Full 能否跳过？ | **不能**（L1）。`bypassInFullControl: false` |
| 算不算 core 锁定模块？ | **否**。控制台可增删条目（L2③）；模块本身 v1 常驻、不可 `remove` |
| 对 Agent | **不能添加**命中目标；**tools/list 不出现**其业务 tools；**invoke deny**（L2①②） |
| 对控制台 | 可以管理黑名单；适配器页可标「已拉黑」 |
| CIDR | **不能**靠黑名单反选整段。发现仍是单主机；CIDR 永不放行（L5） |
| 热加载 | 增删条目立即作用于后续 discover / register / list / invoke（L4） |
| Hook | `discover`（标记 / 从 suggestions 拿掉）、`register`（`E_BLACKLISTED`）、`list`（隐藏 tools）、`invoke`（同码） |
| 匹配规则 | 不要无故改（除非回归测红）。S1 已把 `assertNotBlacklisted` / `decorateCandidates` 收进模块 `evaluate`；`E_BLACKLISTED` 不变 |

S1 包装时：`assertNotBlacklisted` 与 `decorateCandidates` 成为模块的 `evaluate`；并补 `list` 过滤。匹配规则与 `E_BLACKLISTED` 保持不变。

**当前（Phase W）：** 安全平面合同仍是以上锁定决策。热加载不另开逃生口。不重开 CIDR / `ALLOW_SCAN` / shim / 全局写 / Agent challenge / v2/v3 外部加载。`allowDesktop` 与 `allowReadSecrets` 默认关，扫描从不打开。
