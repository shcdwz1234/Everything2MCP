# ADR 0003 — Partner protocol is the southbound default

Status: Accepted (Phase X)

## Context

Agents already speak MCP to Everything2MCP (stdio / HTTP / SSE). Forcing every connectable app (chat, SaaS, IDE plugins) to implement MCP would leak northbound protocol into the southbound edge and make "one Everything2MCP" impossible.

## Decision

1. **Northbound stays MCP only.** The user configures one Everything2MCP.
2. **Southbound is not MCP by default.** Priority:
   1. E2MCP Partner protocol (Capability Manifest + HTTP/IPC invoke). Apps do not implement MCP.
   2. Native OpenAPI adapters (Feishu, DingTalk, WeCom, Slack, Notion, GitHub, …).
   3. MCP bridge (`ingress: mcp_bridge`) only as last-resort 兜底 for existing local `mcpServers` JSON.
3. Partner operations map onto the **existing Catalog Lifecycle** (`partner.{capability_id}.{op}`). No sixth package. No parallel registry.
4. Scan / detect never opens write, shell, desktop, or secrets. Partner `write`/`desktop` risk cannot Safe-auto.
5. Personal WeChat / payment / personal QQ are honest non-claims.

## Consequences

- Control plane REST lives under `/api/partner/v1/*` with a loopback partner token (`dataDir/partner-token`).
- Console `#/partner` shows ingress badges and token issuance.
- Docs and UI must keep labeling MCP bridge as 兜底.
- Five-package layout is unchanged (Control + Catalog + Discovery + Adapter Runtime + Transport).
