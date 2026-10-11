# 3-minute demo — Everything2MCP

Golden path: clone → install → open console → scan → enable → point an MCP client at it.

## 1. Clone and build (~1 min)

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

## 2. Start the HTTP console (~15 s)

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

## 3. Scan and enable (~1 min)

1. Open **能力** — you should see local / discovered adapters (see [console-capabilities.png](images/console-capabilities.png)).
2. Open **设置** — pick auto-discovery mode (**手动** is fine), optionally click **立即扫描** ([console-settings.png](images/console-settings.png)).
3. Back on **能力 → 可支持能力**, review **candidates** (fingerprint hits such as Redis). Fill any required secrets and **启用** ([console-discovery.png](images/console-discovery.png)).
4. Optional: **高级 → 安全模块** for Safe vs Full ([console-security.png](images/console-security.png)); **Partner** if a partner app is registered ([console-partner.png](images/console-partner.png)).
5. Optional single-host probe: **高级 → 单主机扫描** (`#/discovery`).

Writes stay off by default (`allowWrite=false`, `WRITE-OFF` in the header).

## 4. Wire an MCP client (~45 s)

### stdio (Cursor / Claude Desktop)

After `npm run build`, point `args` at this repo's `dist/index.js`:

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

Relative-path example: `examples/cursor-mcp.json`.

### Streamable HTTP (same process as the console)

Keep the HTTP server from step 2 running:

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

Omit `headers` when no token is set (local only). Replace `replace-me` with `EVERYTHING2MCP_HTTP_TOKEN` when you set one.

You should see management tools such as `mcp_list`, `mcp_add`, `discovery_suggest`, `partner_list`, plus business tools from enabled adapters.

## Done

| Check | Expect |
| --- | --- |
| Console loads | Dark UI at `/ui/` |
| Scan | Candidates on 可支持能力 |
| Enable | Adapter appears under 当前能力 with tools > 0 |
| Client | `mcp_list` / `mcp_health` succeed |

Screenshots live under [`docs/images/`](images/). Full console notes: [CONSOLE.md](CONSOLE.md).
