# Contributing to Everything2MCP / 贡献指南

**语言 / Language:** [中文](#中文) · [English](#english)

---

## 中文

感谢参与。本项目的目标是 **万物都能 MCP**：把异构协议与本机能力桥成 MCP tools。请保持安全默认值不被削弱。

### 快速开始

```bash
git clone <this-repo>
cd everything2mcp
npm ci
npm run build
npm test
```

Node **≥ 18.18**。默认传输是 **stdio**（给 Cursor / Claude Desktop）。控制台 UI：

```bash
EVERYTHING2MCP_TRANSPORT=http EVERYTHING2MCP_HTTP_PORT=8742 npm start
# http://127.0.0.1:8742/ui/
```

Windows PowerShell 用 `;` 而不是 `&&`。离开回环前请设置 `EVERYTHING2MCP_HTTP_TOKEN`。

### 改什么

| 区域 | 说明 |
| --- | --- |
| 适配器 | 扁平 `src/adapters/<protocol>/`；遵循 SPI；在 `docs/PROTOCOLS.md` 标注 **Implemented** vs **Thin** |
| 控制 / 安全 | **不要**削弱 Safe 默认、Full 下黑名单、或 Agent 禁 CIDR |
| 发现 | Agent 工具保持单主机；控制台自动发现仅限私网 |
| 测试 | 优先 `tests/` 下可重复套件；`npm test` 必须绿 |
| 文档 | 行为变更时更新 `docs/PROTOCOLS.md` / `docs/RELEASE_NOTES.md`；文档保持 **CN+EN** |

### Pull Request

1. 从 `main` 开分支。
2. 提交聚焦；不要夹带无关脏文件。
3. 本地跑 `npm run build` 与 `npm test`。
4. 若动到 transport / discovery / policy，写明安全影响。
5. 不要提交 `data/`、`.env*`、token 或本地密钥。

### 代码风格

- TypeScript ESM（`"type": "module"`）。
- 适配器 **不得** import `control` 或 `transport`。
- 优先使用 `docs/ERRORS.md` 中的错误码。

### 安全报告

见 [SECURITY.md](SECURITY.md) 与 [docs/SECURITY_ARCHITECTURE.md](docs/SECURITY_ARCHITECTURE.md)。未修复漏洞不要开公开 issue。

### 许可证

贡献即表示同意以 **Apache-2.0** 许可你的贡献（见 [LICENSE](LICENSE)）。

---

## English

Thanks for helping. This project's goal is **Everything can become MCP**: bridge heterogeneous protocols and local capabilities into MCP tools. Keep security defaults intact.

### Quick start

```bash
git clone <this-repo>
cd everything2mcp
npm ci
npm run build
npm test
```

Node **≥ 18.18**. Default transport is **stdio** (for Cursor / Claude Desktop). For the console UI:

```bash
EVERYTHING2MCP_TRANSPORT=http EVERYTHING2MCP_HTTP_PORT=8742 npm start
# http://127.0.0.1:8742/ui/
```

PowerShell uses `;` not `&&`. When binding beyond loopback, set `EVERYTHING2MCP_HTTP_TOKEN`.

### What to change

| Area | Notes |
| --- | --- |
| Adapters | Flat `src/adapters/<protocol>/`; follow SPI; document **Implemented** vs **Thin** in `docs/PROTOCOLS.md` |
| Control / security | Do **not** weaken Safe defaults, blacklist-in-Full, or agent CIDR bans |
| Discovery | Agent tools stay single-host only; console auto-discovery stays private-range only |
| Tests | Prefer hermetic suites under `tests/`; `npm test` must stay green |
| Docs | Update `docs/PROTOCOLS.md` / `docs/RELEASE_NOTES.md` when behavior changes; keep docs **CN+EN** |

### Pull requests

1. Fork / branch from `main`.
2. Keep commits focused; leave unrelated dirty files alone.
3. Run `npm run build` and `npm test` locally.
4. Describe security impact if you touch transport, discovery, or policy.
5. Do not commit `data/`, `.env*`, tokens, or local secrets (`data/` is gitignored).

### Code style

- TypeScript ESM (`"type": "module"`).
- Adapters must **not** import `control` or `transport`.
- Prefer existing error codes in `docs/ERRORS.md`.

### Security reports

See [SECURITY.md](SECURITY.md) and [docs/SECURITY_ARCHITECTURE.md](docs/SECURITY_ARCHITECTURE.md). Do not open public issues for unfixed vulnerabilities.

### License

By contributing, you agree your contributions are licensed under the **Apache-2.0** License (see [LICENSE](LICENSE)).
