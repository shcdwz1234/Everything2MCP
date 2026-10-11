# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub/Gitea issue for security bugs.

Email or privately message the maintainer (repo owner: **shui**) with:

- Affected version / commit
- Reproduction steps (minimal)
- Impact (auth bypass, SSRF, secret leak, etc.)

We will acknowledge and work on a fix before any public disclosure.

For design contracts and locked decisions, see **[docs/SECURITY_ARCHITECTURE.md](docs/SECURITY_ARCHITECTURE.md)**.

## Safe vs Full

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

## HTTP exposure

- Default bind: `EVERYTHING2MCP_HTTP_HOST=127.0.0.1`, port `8742`.
- **Never expose HTTP without a token** beyond a trusted loopback. Set `EVERYTHING2MCP_HTTP_TOKEN` and send `Authorization: Bearer <token>` or `x-api-key`.
- Docker Compose in this repo maps `127.0.0.1:8742` on the host by default. Changing that to `0.0.0.0` without a token is unsafe.
- `GET /health` and static `/ui` are intentionally unauthenticated; `/api`, `/mcp`, and `/sse` require the token when configured.

## Do not

- Re-enable `EVERYTHING2MCP_DISCOVERY_ALLOW_SCAN` for Agent tools (dead variable by design)
- Commit secrets, `data/partner-token`, `.integrity-key`, or `.env*`
- Ship adapters that default `allowWrite=true` or scan cloud metadata / link-local

## Supported versions

| Version | Support |
| --- | --- |
| 0.1.x | Active (pre-1.0; APIs may change) |
