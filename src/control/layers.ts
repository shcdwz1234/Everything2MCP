import type { McpToolSchema } from "../runtime/types.js";

export type ToolLayer = "management" | "business";

const MUTATING_MANAGEMENT = new Set([
  "mcp_add",
  "mcp_update",
  "mcp_remove",
  "mcp_add_from_discovery",
  "schema_import",
  "mcp_blacklist_add",
  "mcp_blacklist_remove",
  "capability_register",
  "capability_unregister",
  "capability_configure",
]);

/** Tag a tool so agents can split catalog layers without drowning in one flat list. */
export function withLayer(tool: McpToolSchema, layer: ToolLayer): McpToolSchema {
  const mutating = layer === "management" && MUTATING_MANAGEMENT.has(tool.name);
  return {
    ...tool,
    annotations: {
      title: layer === "management" ? `Management · ${tool.name}` : `Business · ${tool.name}`,
      readOnlyHint: layer === "management" ? !mutating : tool.annotations?.readOnlyHint,
      destructiveHint: mutating && (tool.name === "mcp_remove" || tool.name === "capability_unregister") ? true : tool.annotations?.destructiveHint,
      openWorldHint: layer === "management" && /discovery_|schema_import|mcp_plan|environment_|capability_/.test(tool.name) ? true : tool.annotations?.openWorldHint,
      ...tool.annotations,
    },
    _meta: { layer, ...(tool._meta ?? {}) },
  };
}

export function layerOf(tool: { _meta?: { layer?: unknown }; name?: string }): ToolLayer {
  const tagged = tool._meta && typeof tool._meta === "object" ? (tool._meta as { layer?: unknown }).layer : undefined;
  if (tagged === "management" || tagged === "business") return tagged;
  const name = tool.name ?? "";
  if (name.startsWith("mcp_") || name.startsWith("discovery_") || name.startsWith("capability_") || name.startsWith("environment_") || name === "schema_import") return "management";
  return "business";
}
