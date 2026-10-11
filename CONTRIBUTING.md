# Contributing to Everything2MCP

Thanks for helping. This project bridges heterogeneous protocols into MCP tools. Keep security defaults intact.

## Quick start

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

Or with Docker (see README). When binding beyond loopback, set `EVERYTHING2MCP_HTTP_TOKEN`.

## What to change

| Area | Notes |
| --- | --- |
| Adapters | Flat `src/adapters/<protocol>/`; follow SPI; document **Implemented** vs **Thin** in `docs/PROTOCOLS.md` |
| Control / security | Do **not** weaken Safe defaults, blacklist-in-Full, or agent CIDR bans |
| Discovery | Agent tools stay single-host only; console auto-discovery stays private-range only |
| Tests | Prefer hermetic suites under `tests/`; `npm test` must stay green |
| Docs | Update `docs/PROTOCOLS.md` / `docs/RELEASE_NOTES.md` when behavior changes |

## Pull requests

1. Fork / branch from `main`.
2. Keep commits focused; leave unrelated dirty files alone.
3. Run `npm run build` and `npm test` locally.
4. Describe security impact if you touch transport, discovery, or policy.
5. Do not commit `data/`, `.env*`, tokens, or local secrets (`data/` is gitignored).

## Code style

- TypeScript ESM (`"type": "module"`).
- Adapters must **not** import `control` or `transport`.
- Prefer existing error codes in `docs/ERRORS.md`.

## Security reports

See [SECURITY.md](SECURITY.md) and [docs/SECURITY_ARCHITECTURE.md](docs/SECURITY_ARCHITECTURE.md). Do not open public issues for unfixed vulnerabilities.

## License

By contributing, you agree your contributions are licensed under the MIT License (see [LICENSE](LICENSE)).
