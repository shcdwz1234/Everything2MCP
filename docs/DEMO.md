# 3-minute demo / 三分钟演示 — Everything2MCP

**语言 / Language:** [中文](#中文) · [English](#english)

黄金路径：克隆 → 安装 → 打开控制台 → 扫描 → 启用 → 把 MCP 客户端指过来。

---

## 中文

### 1. 克隆与构建（约 1 分钟）

```bash
git clone <repo-url> everything2mcp
cd everything2mcp
npm ci
npm run build
```

Node **≥ 18.18**。只看 UI 时可跳过测试：`npm test` 此处可选。

**Docker 替代**（同端口）：

```bash
docker compose up --build
# UI:  http://127.0.0.1:8742/ui/
# MCP: http://127.0.0.1:8742/mcp
```

Compose 只绑定宿主 `127.0.0.1:8742`。离开回环前设置 `EVERYTHING2MCP_HTTP_TOKEN`。

### 2. 启动 HTTP 控制台（约 15 秒）

```bash
EVERYTHING2MCP_TRANSPORT=http EVERYTHING2MCP_HTTP_PORT=8742 npm start
```

Windows PowerShell：

```powershell
$env:EVERYTHING2MCP_TRANSPORT = "http"
$env:EVERYTHING2MCP_HTTP_PORT = "8742"
npm start
```

受信回环上 token **可选**。本地演示可留空 `EVERYTHING2MCP_HTTP_TOKEN`；端口可被本机以外访问时必须设置。

打开：

| 表面 | URL |
| --- | --- |
| 控制台 | http://127.0.0.1:8742/ui/ |
| Streamable HTTP MCP | http://127.0.0.1:8742/mcp |
| Health | http://127.0.0.1:8742/api/health |

### 3. 扫描并启用（约 1 分钟）

1. 打开 **能力** —— 应看到本机 / 已发现适配器（见 [console-capabilities.png](images/console-capabilities.png)）。
2. 打开 **设置** —— 选择自动发现模式（**手动**即可），可选点 **立即扫描**（[console-settings.png](images/console-settings.png)）。
3. 回到 **能力 → 可支持能力**，查看 **候选**（如 Redis 指纹）。填必要密钥后 **启用**（[console-discovery.png](images/console-discovery.png)）。
4. 可选：**高级 → 安全模块** 看 Safe vs Full（[console-security.png](images/console-security.png)）；有 Partner 应用时看 **Partner**（[console-partner.png](images/console-partner.png)）。
5. 可选单主机探测：**高级 → 单主机扫描**（`#/discovery`）。

写入默认关闭（`allowWrite=false`，顶栏 `WRITE-OFF`）。

### 4. 接入 MCP 客户端（约 45 秒）

#### stdio（Cursor / Claude Desktop）

`npm run build` 后，把 `args` 指到本仓库 `dist/index.js`：

```json
{
  "mcpServers": {
    "everything2mcp": {
      "command": "node",
      "args": ["/absolute/path/to/everything2mcp/dist/index.js"]
    }
  }
}
```

相对路径示例：`examples/cursor-mcp.json`。

#### Streamable HTTP（与控制台同进程）

保持第 2 步的 HTTP 服务运行：

```json
{
  "mcpServers": {
    "everything2mcp": {
      "url": "http://127.0.0.1:8742/mcp",
      "headers": { "Authorization": "Bearer replace-me" }
    }
  }
}
```

未设 token 时可省略 `headers`（仅本地）。设了 token 就把 `replace-me` 换成 `EVERYTHING2MCP_HTTP_TOKEN`。

应能看到 `mcp_list`、`mcp_add`、`discovery_suggest`、`partner_list` 等管理工具，以及已启用适配器的业务 tools。

### 完成检查

| 检查 | 期望 |
| --- | --- |
| 控制台加载 | `/ui/` 深色 UI |
| 扫描 | 「可支持能力」出现候选 |
| 启用 | 「当前能力」出现适配器且 tools > 0 |
| 客户端 | `mcp_list` / `mcp_health` 成功 |

截图在 [`docs/images/`](images/)。控制台全文：[CONSOLE.md](CONSOLE.md)。定位：**万物都能 MCP**（诚实标注 Implemented / Thin）。

---

## English

Golden path: clone → install → open console → scan → enable → point an MCP client at it.

### 1. Clone and build (~1 min)

```bash
git clone <repo-url> everything2mcp
cd everything2mcp
npm ci
npm run build
```

Node **≥ 18.18**. Skip tests if you are only checking the UI: `npm test` is optional here.

**Docker alternative** (same port):

```bash
docker compose up --build
# UI:  http://127.0.0.1:8742/ui/
# MCP: http://127.0.0.1:8742/mcp
```

Compose binds host `127.0.0.1:8742` only. Set `EVERYTHING2MCP_HTTP_TOKEN` before exposing beyond loopback.

### 2. Start the HTTP console (~15 s)

```bash
EVERYTHING2MCP_TRANSPORT=http EVERYTHING2MCP_HTTP_PORT=8742 npm start
```

Windows PowerShell:

```powershell
$env:EVERYTHING2MCP_TRANSPORT = "http"
$env:EVERYTHING2MCP_HTTP_PORT = "8742"
npm start
```

Token is **optional on trusted loopback**. Leave `EVERYTHING2MCP_HTTP_TOKEN` unset for local demos; set it whenever the port is reachable past localhost.

Open:

| Surface | URL |
| --- | --- |
| Console | http://127.0.0.1:8742/ui/ |
| Streamable HTTP MCP | http://127.0.0.1:8742/mcp |
| Health | http://127.0.0.1:8742/api/health |

### 3. Scan and enable (~1 min)

1. Open **能力** — you should see local / discovered adapters (see [console-capabilities.png](images/console-capabilities.png)).
2. Open **设置** — pick auto-discovery mode (**手动** is fine), optionally click **立即扫描** ([console-settings.png](images/console-settings.png)).
3. Back on **能力 → 可支持能力**, review **candidates** (fingerprint hits such as Redis). Fill any required secrets and **启用** ([console-discovery.png](images/console-discovery.png)).
4. Optional: **高级 → 安全模块** for Safe vs Full ([console-security.png](images/console-security.png)); **Partner** if a partner app is registered ([console-partner.png](images/console-partner.png)).
5. Optional single-host probe: **高级 → 单主机扫描** (`#/discovery`).

Writes stay off by default (`allowWrite=false`, `WRITE-OFF` in the header).

### 4. Wire an MCP client (~45 s)

#### stdio (Cursor / Claude Desktop)

After `npm run build`, point `args` at this repo's `dist/index.js` (see Chinese section for JSON). Relative-path example: `examples/cursor-mcp.json`.

#### Streamable HTTP (same process as the console)

Keep the HTTP server from step 2 running; use `url` `http://127.0.0.1:8742/mcp` and Bearer token when configured.

You should see management tools such as `mcp_list`, `mcp_add`, `discovery_suggest`, `partner_list`, plus business tools from enabled adapters.

### Done

| Check | Expect |
| --- | --- |
| Console loads | Dark UI at `/ui/` |
| Scan | Candidates on 可支持能力 |
| Enable | Adapter appears under 当前能力 with tools > 0 |
| Client | `mcp_list` / `mcp_health` succeed |

Screenshots live under [`docs/images/`](images/). Full console notes: [CONSOLE.md](CONSOLE.md). Positioning: **Everything can become MCP** (honest Implemented / Thin labels). License: Apache-2.0.
