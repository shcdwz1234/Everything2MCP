# 控制台改版报告（Console Redesign）

基线：`main` @ `7be6407`（Phase X）。本报告对应已批准的方案（审查稿「从 13 个入口收到 3 个 + 设置」），外加实施中途用户对「能力」页的调整：**筛选改为三个 tab**。所有提交都只在本地，**没有推送**。

## 1. 结论

- 控制台一级入口从 13 个收为 **能力 / 活动 / 设置**，其余页面折进侧栏「高级」，旧链接自动跳转。
- 「能力」页三 tab：**当前能力**（启用开关 + 加入黑名单 + tools 抽屉）、**可支持能力**（已发现候选一键启用 / 需要配置 + 全部类型卡片进向导）、**黑名单**（一键解除）。摘要条计数与 tab 对应。
- 新建能力不再手写 JSON：每个协议都有 `configSchema`，向导按它生成表单，**先测试连接再保存**。
- 黑名单从「目标」扩展到 **能力实例** 与 **工具（支持 glob）**，Full 模式下照样生效，旧文件兼容。
- **私网自动发现** 落地（自动 / 手动 / 关闭，默认自动）。这是对原安全约束 L5 的放宽，已在文档中写明边界；Agent 工具仍只接受单主机。
- 测试：**545 → 570**（Node 22 全绿，133 → 140 suites）。构建与测试脚本改为跨平台。

## 2. 提交列表

| 提交 | 内容 |
| --- | --- |
| `8c55dd8` | S1：每协议 `configSchema` + `GET /api/protocols`、校验、测试连接 |
| `c4235c5` | S3：黑名单粒度（目标 / 能力实例 / 工具 glob），v1 兼容存储 |
| `0c4eed7` | S4：自动发现（auto/manual/off）、私网范围规则、候选 + 启用 / 开关 / overview / activity REST |
| `e4c01b2` | S2：控制台改版（能力三 tab、schema 向导、活动、设置） |
| `423283e` | S2 补充：当前能力「来源 / 地址」列；CGNAT 内云 metadata 永不扫描的测试 |
| `c99afc3` | S2 补充：一键启用失败时把原因留在候选卡片上 |
| `3378510` | S5：跨平台构建 / 测试脚本、删除重复文档、文档更新、本报告 |
| 最后一个提交 | S2 补充：启用失败的候选不再计入「可一键启用」，摘要条单列「启用失败」；报告补提交号 |

## 3. 测试数

| | suites | tests | 通过 | 失败 |
| --- | ---: | ---: | ---: | ---: |
| 改版前，Node 22 | 133 | 545 | 545 | 0 |
| 改版前，Node 20 | 133 | 545 | 527 | 18（均为缺 `node:sqlite`） |
| **改版后，Node 22** | **140** | **570** | **570** | **0** |
| 改版后，Node 20 | 140 | 570 | 552 | 18（同一批 `node:sqlite` 用例，无新增失败） |

新增 25 个用例：`tests/config-schema.test.ts`（7）、`tests/blacklist-granular.test.ts`（5）、`tests/auto-discovery.test.ts`（13），覆盖 S1 / S3 / S4 与相关 REST。新增的 REST 用例使用 postgres 内存模拟器，不依赖 `node:sqlite`，所以在 Node 20 上也能通过。

## 4. 每一步做了什么

### S1 每协议 configSchema

- `src/catalog/config-schema.ts`：字段有类型、标签、说明、必填、密钥、高级、默认值、枚举、占位符、`oneOf` 组、数组元素类型。
- 常用协议手写了完整 schema：openapi、soap、graphql、grpc、mqtt、redis、postgres、mysql、sqlite、sql、kafka、amqp、websocket、modbus、opcua、s3、mcp_bridge、jsonrpc、xmlrpc。
- 其余协议由现有 `PROTOCOL_CONFIG_HELP` 解析生成（可处理嵌套括号），必填规则与 `validate.ts` 对齐。有测试逐个协议比对 schema 必填检查与真实校验的结果。
- REST：
  - `GET /api/protocols`、`GET /api/protocols/:id`
  - `POST /api/protocols/:id/validate` → `{ ok, missing, error }`
  - `POST /api/adapters/test`：依次过校验、SSRF、安全 register 钩子、黑名单，然后临时建适配器、connect + listTools（有超时），**不落盘**。
- 协议矩阵条目带上 title / pack。

### S2 控制台

- **导航**：能力 / 活动 / 设置 + 可折叠「高级」（Tools、单主机发现、导入、矩阵、审计、计划桥、安全、热加载 `#/hotload`、伙伴）。
  - 旧 hash 跳转：`#/`、`#/adapters`、`#/capabilities` → 当前能力；`#/blacklist` → 黑名单 tab；`#/adapters/new`、`#/adapters/:id` → 向导。
- **能力页**：
  - 顶部摘要条来自 `GET /api/overview`：当前（总 / 启用 / 停用 / 拉黑 / 异常）、可支持（已发现 / 可一键启用 / 需要配置 / 启用失败 / 类型数）、黑名单（按 kind）、自动发现状态 + 立即扫描。
  - **当前能力**：每行有状态点、名称 / id、协议、来源（自动发现 / 伙伴 / 手动）与 host:port、tools 数、只读 / 可写、状态、**启用开关**、**加入黑名单 / 解除**，以及 `…`（配置 / 测试 / 删除）。点击行打开右侧抽屉，逐个工具 **屏蔽 / 解除**、**试调用**。
  - **可支持能力**：上方是「已发现，可一键启用」。凭据齐全的候选显示 **一键启用**；缺字段或需要凭据的标 **需要配置**，卡片内只出缺的输入框；另有忽略、加入黑名单；上次启用失败会显示原因。下方是全部类型卡片（按包分组、可搜索，显示已添加数），点击进入向导并预选该类型；另有导入 Schema / 扫描单个主机 / MCP Server（兜底）/ Partner 入口。
  - **黑名单**：全部条目 + 一键解除 + 按范围手动添加。
  - 右上 **+ 添加** 保留，作为进入向导的快捷方式。
- **启用开关（停用）**：registry 新状态。保留注册与配置，卸载 tools，重启后保持停用。REST 为 `POST|PUT /api/adapters/:id/enabled`。
- **添加向导**：
  1. 选类型；
  2. schema 表单：必填在前，「高级选项」折叠，`oneOf` 提示，密钥字段可「显示」，`allowWrite` 放进警示框，保留原始 JSON 切换；
  3. **测试连接**（显示 tools 列表），然后 **保存并启用**。
  
  编辑时密钥回显 `••••`，原样提交即保留旧值（服务端 `unmaskConfig`，嵌套对象也可以）。
- **活动**：审计环 + 发现运行合成一条时间线，可只看失败。控制台发起的能力增 / 改 / 删、黑名单增 / 删、启停都记审计（只记 id，不含密钥）；发现运行不重复列出。
- **设置**：自动发现全部选项 + 运行历史、Safe / Full 切换、运行信息、原始设置 JSON。

### S3 黑名单粒度

- `src/catalog/blacklist.ts`：条目增加 `kind`（target | capability | tool）、`adapterId`、`pattern`。id 形如 `cap|<adapterId>`、`tool|<pattern>`。
- glob：`*` 匹配一段，`**` 匹配任意段；单独的 `*` / `**` 会被拒绝。
- `registry.invoke` 用 `matchSubject` 做判断；`builtin-blacklist` 模块在 list / invoke / register 各粒度生效。工具 pattern 只在 list / invoke 生效。
- `mcp_blacklist_add` 支持新字段，`mcp_blacklist_list` 带计数。控制台 `mcp_list` / `GET /api/tools` 标 `blocked` / `blacklistId`；Agent 侧直接隐藏。
- 文件兼容：只有 target 条目时仍写 `version: 1`；出现新 kind 时写 `version: 2`。读取两种都接受。

### S4 自动发现

- **范围规则** `src/discovery/netscope.ts`：
  - 视为私网：RFC1918、CGNAT `100.64/10`、`127/8`、ULA。
  - 永不扫描：link-local 与云 metadata（包括落在 CGNAT 里的 `100.100.100.200`）。
  - 网卡子网最多 /24，手动 CIDR 最多 /16；公网地址需要 `allowPublic`。
- **有界组播** `src/discovery/multicast.ts`：mDNS / SSDP 各一次查询，TTL=1，只接受私网应答者。旧的会抛错的 helper 保持不变。
- **调度与候选** `src/control/auto-discovery.ts`：
  - 设置持久化在 `dataDir/discovery.json`。
  - 每轮评估一次 `discover` 钩子，然后逐主机调用单主机探测。
  - 候选只读、按黑名单过滤、跟踪在线状态，连续 10 轮未见即清理。
  - 「需要配置」判定：常需凭据的协议没带凭据、缺必填字段、或探测到鉴权提示。
  - 启用走 `capability_register`。`autoEnable` 默认关闭，开启后也只会自动启用无需配置的只读候选。
  - 每轮运行写审计。
- **模式来源**：`EVERYTHING2MCP_DISCOVERY_MODE`，其次是保存的设置，默认 `auto`。在 `node --test` 下默认 `off`；`EVERYTHING2MCP_DISCOVERY_ENABLED=false` 时强制 `off`。环境变量另有 `_INTERVAL_MIN`、`_SCOPES`、`_EXCLUDE`。
- **REST**：`/api/discovery/settings|status|candidates|run|runs`、候选 `enable|dismiss|restore`、`/api/overview`、`/api/activity`。

### S5 杂项

- `scripts/copy-assets.mjs` 取代 `build` / `ui:build` 里的 `mkdir -p` / `cp`。
- `scripts/run-tests.mjs` 取代依赖 shell glob 的 `tsx --test tests/**/*.test.ts`：原命令在 bash 下（未开 globstar）会失败，在 cmd.exe 下完全不展开。新脚本自己收集文件，支持透传参数和指定文件。
- 删除 `docs/README.md`（根 README 的副本）和 `docs/compat/catalog.json`（与 `compat/catalog.json` 相同）；`docs/COMPAT.md` 改为指向根目录那份。
- `uploads/DESIGN_49b9.md`：在本工作副本里 `uploads/` 被 `.gitignore` 忽略且未被跟踪，仓库里不存在该文件，所以无需删除（审查稿看到的是 Windows 工作目录里的未跟踪文件）。
- 文档：
  - CONSOLE.md 重写；
  - DISCOVERY.md 新增「自动发现」一节；
  - BLACKLIST.md 新增三种粒度和 v2 格式；
  - SECURITY_ARCHITECTURE.md 修订 L5 及相关表格；
  - ROADMAP.md 把「默认网段扫描」「mDNS 组播」移出「明确不会做」，并写明放宽的边界；
  - RELEASE_NOTES.md、README.md、COMPAT.md、PARTNER.md、PROTOCOLS.md 同步。

## 5. 与方案的偏差及原因

1. **实施顺序是 S1 → S3 → S4 → S2 → S5**，不是方案里的 S1 → S2 → S3 → S4。三 tab 的「黑名单」和「可支持能力」要用到 S3、S4 的后端数据，先做后端可以避免 UI 返工。
2. **能力页用三个 tab，不用筛选**。这是用户在实施中途的调整，已按调整实现。
3. **抽屉里的工具只有「屏蔽 / 解除」，没有单独的开关。** 对工具而言，「关掉」和「屏蔽」效果相同（Agent 看不到、调用被拒）。做两个控件容易让人困惑，所以只保留一个。
4. **访问 token 仍放在顶栏**，没有挪进「设置」。它只存在 sessionStorage 里，每个页面都要用，放在顶栏更方便。
5. **旧的组播 helper（`mdnsDiscover()` 等）保持抛 `E_UNSUPPORTED`**，另写了有界的新模块。这样 Agent 侧工具的行为和旧测试都不变，组播只在自动发现里用。
6. **测试运行时自动发现默认关闭**（`NODE_TEST_CONTEXT`），以免测试扫描网络。
7. **黑名单全是 target 条目时仍写 v1**，保证旧版本能读回文件，也和已有测试保持一致。
8. **`discover` 钩子每轮评估一次**，不是每个主机一次。否则一轮 256 个主机会耗尽每分钟 20 次的 discover 限流。SSRF / metadata / 黑名单仍逐主机检查。
9. **CGNAT `100.64/10` 按私网处理**，因为很多家庭和运营商网络在这个段里。其中的云 metadata 地址单独拦截。
10. **「停用」是 registry 的新状态**（`RegistrationRecord.disabled`），不是删除或拉黑，这样才能满足「保留配置、随时打开」。
11. **来源列只区分 自动发现 / 伙伴 / 手动**。「导入」产生的注册在记录里没有来源标记，目前显示为手动。

## 6. 已知缺口

- 「需要配置」是启发式判断：没有做无认证探测（NOAUTH 指纹）。所以有些不需要密码的 Postgres / MySQL 也会被要求填凭据，而个别需要密码的服务可能显示为「可一键启用」，启用时才报错（报错会留在卡片上）。
- 部分适配器只有 simulator，没有 live 客户端（例如 qdrant 的 live HTTP 需要注入 `connectFn`）。自动发现能找到这类服务，但一键启用会返回 `E_UNSUPPORTED`，卡片会显示「启用失败」和原因。
- 组播（mDNS / SSDP）只在单元测试里用注入的假实现验证过，没有在真实局域网上测试。
- 非手写 schema 的协议，字段由帮助字符串推导，标签和说明比较简略，类型是按键名推断的。
- 适配器增删改只在**控制台 REST 入口**记审计；Agent 通过 MCP 调 `mcp_add` / `mcp_remove` 仍只有原有的 policy / invoke 事件。
- 本环境 Node 20 缺 `node:sqlite`，那部分用例失败，与改版前相同，和本次改动无关。
- 方案第 2 节的其它建议（`mcp_bridge` live spawn、docker-compose 真服务集成测试）不在本次范围内，没有做。

## 7. 截图

在 `/workspace/e2m-review/shots/`，由 playwright 驱动真实进程（HTTP 8799，自动发现开启，本机真实发现 qdrant 与 opensearch）截取：

| 文件 | 内容 |
| --- | --- |
| `01-caps-supported.png` | 可支持能力：已发现候选 + 全部类型卡片 |
| `02-add-type-picker.png` | 添加向导第 1 步 |
| `03-add-wizard-sqlite-tested.png` | SQLite 表单 + 测试连接成功 |
| `04-add-wizard-s3-schema-form.png` | S3 表单：必填、密钥掩码、高级折叠、allowWrite 警示 |
| `05-caps-current.png` | 当前能力 |
| `06-caps-current-drawer.png` | tools 抽屉，工具级屏蔽 |
| `07-caps-blacklist.png` | 黑名单 tab（工具 + 能力实例条目） |
| `08-settings-discovery.png` | 设置：自动发现 + 运行历史 + 安全模式 |
| `09-advanced-security.png` | 高级 → 安全 |
| `10-activity.png` | 活动时间线 |
| `11-caps-current-after.png` | 停用 / 拉黑后的当前能力与摘要条 |
| `12-caps-supported-narrow.png` | 窄屏 |
| `13-caps-supported-enable-failed.png` | qdrant 一键启用失败（该适配器没有 live 客户端），原因留在卡片上 |

## 8. 复现

```bash
npm install
npm run build
npm test                      # node scripts/run-tests.mjs
EVERYTHING2MCP_TRANSPORT=http EVERYTHING2MCP_HTTP_PORT=8742 npm start
# 打开 http://127.0.0.1:8742/ui/
# 不想自动扫描：EVERYTHING2MCP_DISCOVERY_MODE=off（或在「设置」里选关闭）
```
