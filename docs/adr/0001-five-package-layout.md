# ADR 0001 — Five-package layout

Status: Accepted

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
- `control → discovery` (probe now; suggest / add_from_discovery later)
- `catalog → runtime/bootstrap → adapters` (factories register through runtime)
- adapters import only runtime leaves (`types`, `errors`, `auth`, `load`)
- adapters must not import `control` or `transport`
- runtime leaves must not import adapters; `runtime/bootstrap.ts` is the only runtime→adapters edge

Adapter implementations stay in flat `src/adapters/<protocol>/` folders. `src/adapters/packs.ts` is an optional grouping overlay (`http`, `rpc`, `messaging`, `industrial`, `data`).

Temporary shims `src/core/*` and `src/management/tools.ts` were removed after the import cutover.

## Consequences

- Public MCP tool names and `{protocol}.{name}.{op}` qualification are unchanged.
- Call paths go through `invokeWithMiddleware` (error normalization; timeout only when `config.timeoutMs` is set).
- SSE/HTTP transports live in `src/transport/` without touching catalog or adapters (P6).
- Feature work (AsyncAPI, Sparkplug, autonomy tools) is deferred until this layout is green.
