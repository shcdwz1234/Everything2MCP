# Partner demo chat (NON-MCP)

Tiny Node HTTP server that implements the **E2MCP Partner protocol** only:

- `list_chats` (readonly)
- `send_message` (write; still gated by Everything2MCP `allowWrite=false` until an operator opens it)

There is **no** MCP SDK, no `tools/list`, no stdio MCP in this folder.

```bash
# Terminal A — Everything2MCP HTTP console
EVERYTHING2MCP_TRANSPORT=http EVERYTHING2MCP_HTTP_PORT=8742 npm start

# Terminal B — issue a local partner token (or open #/partner)
curl -s http://127.0.0.1:8742/api/partner/v1/token

# Terminal C — demo app
E2MCP_URL=http://127.0.0.1:8742 E2MCP_PARTNER_TOKEN=<token> node examples/partner-demo-chat/server.mjs
```

The Agent talks to **one** Everything2MCP MCP server. Tools appear as `partner.demo_chat.list_chats` and `partner.demo_chat.send_message`.
