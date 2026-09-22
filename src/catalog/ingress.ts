import type { JsonObject } from "../runtime/types.js";

/** Southbound ingress. Agent-facing northbound stays MCP only. */
export const INGRESS_KINDS = ["partner", "native", "mcp_bridge"] as const;
export type IngressKind = (typeof INGRESS_KINDS)[number];

/** Partner first, native OpenAPI adapters second, MCP bridge last-resort 兜底. */
export const INGRESS_PRIORITY: IngressKind[] = ["partner", "native", "mcp_bridge"];

export function inferIngress(protocol: string, config: JsonObject = {}): IngressKind {
  const raw = config.ingress;
  if (raw === "partner" || raw === "native" || raw === "mcp_bridge") return raw;
  const p = protocol.toLowerCase();
  if (p === "partner") return "partner";
  if (p === "mcp_bridge") return "mcp_bridge";
  return "native";
}

export function riskCeilingOf(operations: Array<{ risk?: string }>): "readonly" | "write" | "desktop" {
  if (operations.some((o) => o.risk === "desktop")) return "desktop";
  if (operations.some((o) => o.risk === "write")) return "write";
  return "readonly";
}
