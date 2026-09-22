# ADR 0001 — Five-package layout

Status: Accepted

> Historical decision (layout cutover). Later phases kept this layout. **Phase U is current.** Feature work that this ADR deferred (AsyncAPI, Sparkplug, autonomy tools) **has since shipped**; do not read the Consequences bullet as a live backlog.

## Context

Everything2MCP started as a three-layer tree (`core` + `management` + `adapters` + `discovery`). Management tools, the hot registry, stdio wiring, and shared kernel types lived together under `src/core`, which made it easy for adapters and the MCP server to grow circular imports and for transport concerns to mix with catalog logic.

We need a directory layout that matches the intended single-process architecture without changing MCP tool names or adapter behavior.

## Decision

Split the process into five packages (directories), plus a shared runtime kernel:

| Package | Responsibility |
| --- | --- |
| `src/transport/` | stdio (default); Streamable HTTP + SSE. No business logic. |
| `src/control/` | `mcp_*` / `discovery_probe` handlers and policy hooks |
| `src/catalog/` | tool registry, JSON persistence, validation, `list_changed` |
| `src/discovery/` | host probe; suggest; `schema_import`; SSDP unicast (mDNS multicast still off) |
| `src/adapters/` + `src/runtime/` | Adapter SPI + protocol implementations; runtime kernel |

Dependency rules:

- `transport → control → catalog`
- `control → discovery` (probe, scan, suggest, `schema_import`, `mcp_add_from_discovery` — all hooked as MCP tools)
- `catalog → runtime/bootstrap → adapters` (factories register through runtime)
- adapters import only runtime leaves (`types`, `errors`, `auth`, `load`)
- adapters must not import `control` or `transport`
- runtime leaves must not import adapters; `runtime/bootstrap.ts` is the only runtime→adapters edge

Adapter implementations stay in flat `src/adapters/<protocol>/` folders. `src/adapters/packs.ts` is an optional grouping overlay (`http`, `rpc`, `messaging`, `industrial`, `data`).

Temporary shims `src/core/*` and `src/management/tools.ts` were removed after the import cutover.

## Consequences

- Public MCP tool names and `{protocol}.{name}.{op}` qualification are unchanged.
- Call paths go through `invokeWithMiddleware` (error normalization; timeout only when `config.timeoutMs` is set).
- SSE/HTTP transports live in `src/transport/` without touching catalog or adapters (P6; current HTTP port default **8742**).
- Feature work named here as deferred (AsyncAPI, Sparkplug, autonomy tools) was finished in later phases. The five-package rules still apply.
