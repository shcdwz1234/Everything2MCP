import type { AdapterHealth, DiscoveredTool, McpToolSchema } from "../runtime/types.js";

export interface ProtocolAdapter {
  readonly id: string;
  readonly protocol: string;
  connect(config: Record<string, unknown>): Promise<void>;
  disconnect(): Promise<void>;
  discover?(): Promise<DiscoveredTool[]>;
  listTools(): Promise<McpToolSchema[]>;
  invoke(toolName: string, args: Record<string, unknown>): Promise<unknown>;
  health?(): Promise<AdapterHealth>;
}

export type AdapterFactory = (id: string) => ProtocolAdapter;
