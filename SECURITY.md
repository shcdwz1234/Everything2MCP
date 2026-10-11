# Security Policy / 安全策略

**语言 / Language:** [中文](#中文) · [English](#english)

---

## 中文

### 报告漏洞

请 **不要** 为安全缺陷开公开的 GitHub/Gitea issue。

请邮件或私信维护者（仓库所有者：**shui**），并附上：

- 受影响版本 / commit
- 最小复现步骤
- 影响（鉴权绕过、SSRF、密钥泄漏等）

我们会先确认并修复，再考虑公开披露。

设计合同与已锁定决策见 **[docs/SECURITY_ARCHITECTURE.md](docs/SECURITY_ARCHITECTURE.md)**。

### Safe vs Full

| 模式 | 意图 |
| --- | --- |
| **Safe**（默认） | 政策网关开启；数据面默认 `allowWrite=false`；限流生效 |
| **Full** | 操作员本机调试：仅跳过标了 `bypassInFullControl` 的模块 —— **不是** root |

Full 下仍强制：

- 已设置 `EVERYTHING2MCP_HTTP_TOKEN` 时的 HTTP token（`core-auth`）
- 审计 + 完整性账本
- **黑名单**（目标 / 能力 / 工具）—— 含 Full 始终开启
- 各适配器 `assertCanWrite` / `allowWrite`
- Agent 工具 **永不** 接受 CIDR / 网段

### HTTP 暴露

- 默认绑定：`EVERYTHING2MCP_HTTP_HOST=127.0.0.1`，端口 `8742`。
- **离开受信回环前必须设 token**。设置 `EVERYTHING2MCP_HTTP_TOKEN`，客户端带 `Authorization: Bearer <token>` 或 `x-api-key`。
- 本仓库 Docker Compose 默认只映射宿主 `127.0.0.1:8742`。无 token 改成 `0.0.0.0` 不安全。
- `GET /health` 与静态 `/ui` 故意不鉴权；配置了 token 时 `/api`、`/mcp`、`/sse` 需要 token。

### 不要

- 为 Agent 工具重新启用 `EVERYTHING2MCP_DISCOVERY_ALLOW_SCAN`（设计上的死变量）
- 提交密钥、`data/partner-token`、`.integrity-key` 或 `.env*`
- 发布默认 `allowWrite=true` 或扫描云 metadata / link-local 的适配器

### 支持版本

| 版本 | 支持 |
| --- | --- |
| 0.1.x | 活跃（预 1.0；API 可能变更） |

许可证：[Apache-2.0](LICENSE)。

---

## English

### Reporting a vulnerability

Please **do not** open a public GitHub/Gitea issue for security bugs.

Email or privately message the maintainer (repo owner: **shui**) with:

- Affected version / commit
- Reproduction steps (minimal)
- Impact (auth bypass, SSRF, secret leak, etc.)

We will acknowledge and work on a fix before any public disclosure.

For design contracts and locked decisions, see **[docs/SECURITY_ARCHITECTURE.md](docs/SECURITY_ARCHITECTURE.md)**.

### Safe vs Full

| Mode | Intent |
| --- | --- |
| **Safe** (default) | Policy gateway on; data-plane `allowWrite=false` by default; rate limits apply |
| **Full** | Operator local debug: skips only modules marked `bypassInFullControl` — **not** root |

Full still enforces:

- HTTP token (`core-auth`) when `EVERYTHING2MCP_HTTP_TOKEN` is set
- Audit + integrity ledgers
- **Blacklist** (target / capability / tool) — always on, including Full
- Per-adapter `assertCanWrite` / `allowWrite`
- Agent tools **never** accept CIDR / network ranges

### HTTP exposure

- Default bind: `EVERYTHING2MCP_HTTP_HOST=127.0.0.1`, port `8742`.
- **Never expose HTTP without a token** beyond a trusted loopback. Set `EVERYTHING2MCP_HTTP_TOKEN` and send `Authorization: Bearer <token>` or `x-api-key`.
- Docker Compose in this repo maps `127.0.0.1:8742` on the host by default. Changing that to `0.0.0.0` without a token is unsafe.
- `GET /health` and static `/ui` are intentionally unauthenticated; `/api`, `/mcp`, and `/sse` require the token when configured.

### Do not

- Re-enable `EVERYTHING2MCP_DISCOVERY_ALLOW_SCAN` for Agent tools (dead variable by design)
- Commit secrets, `data/partner-token`, `.integrity-key`, or `.env*`
- Ship adapters that default `allowWrite=true` or scan cloud metadata / link-local

### Supported versions

| Version | Support |
| --- | --- |
| 0.1.x | Active (pre-1.0; APIs may change) |

License: [Apache-2.0](LICENSE).
