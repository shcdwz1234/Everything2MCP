# ADR 0002 — Actor-bound console audience

Status: Accepted (Phase M; still in force at Phase W)

## Context

S1 hid blacklisted business tools from Agent `tools/list` and default `mcp_list`. The console needed an operator view, so `GET /api/tools` passed `audience: "console"` into the same `callManagementTool`. Agents could pass the same argument and see hidden names. `mcp_explain_tool`, `mcp_query_by_protocol`, and `mcp_health.adapters[].tools` had the same hole.

## Decision

Console (unfiltered) view requires **both**:

1. `ctx.actor.kind === "console"` (set by `handleConsoleRest`; never by MCP stdio)
2. an explicit console request (`audience: "console"` on `mcp_list`, or health/query/explain treating the caller as operator)

MCP `CallTool` always sets `actor: mcp-stdio`. Missing actor defaults to agent. Spoofing `audience` is a no-op.

Agent responses must not leak hidden tool names via adapter rows or `hiddenBlacklisted` counts. Operators still see those on REST / console-actor calls.

## Consequences

- REST `/api/tools` and `/api/health` stay operator-visible after the wrap.
- Tests must pass `actor: { kind: "console" }` when they want the unfiltered list.
- Integrity ledger still does not seal `audit.jsonl` (append-only; intentional).
