import { readFileSync } from "node:fs";
import { AdapterError } from "../../runtime/errors.js";
import type { AdapterHealth, JsonObject, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { stringField } from "../helpers.js";

export interface McpServerSpec {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export function parseMcpServersJson(raw: unknown): Record<string, McpServerSpec> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AdapterError("E_INVALID_CONFIG", "mcp_bridge expects an object with mcpServers", { protocol: "mcp_bridge" });
  }
  const root = raw as Record<string, unknown>;
  const block = (root.mcpServers && typeof root.mcpServers === "object" ? root.mcpServers : root) as Record<
    string,
    unknown
  >;
  const out: Record<string, McpServerSpec> = {};
  for (const [name, spec] of Object.entries(block)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) continue;
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) continue;
    const s = spec as Record<string, unknown>;
    out[name] = {
      command: typeof s.command === "string" ? s.command : undefined,
      args: Array.isArray(s.args) ? s.args.filter((x): x is string => typeof x === "string") : undefined,
      url: typeof s.url === "string" ? s.url : undefined,
      env: undefined,
    };
  }
  if (Object.keys(out).length === 0) {
    throw new AdapterError("E_INVALID_CONFIG", "mcp_bridge mcpServers is empty or had no valid names", {
      protocol: "mcp_bridge",
    });
  }
  return out;
}

/**
 * Last-resort 兜底: import Cursor/Claude/VS Code/Windsurf-style mcpServers JSON.
 * Live stdio spawn is not enabled — simulator/fixture lists prefixed tools only.
 */
export class McpBridgeAdapter implements ProtocolAdapter {
  readonly protocol = "mcp_bridge";
  private servers: Record<string, McpServerSpec> = {};
  private liveSpawn = false;

  constructor(readonly id: string) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    this.liveSpawn = config.liveSpawn === true;
    let raw: unknown = config.mcpServers ?? config.servers ?? config;
    const path = stringField(config, "path") ?? stringField(config, "file");
    if (path) {
      raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    }
    this.servers = parseMcpServersJson(typeof config.mcpServers === "object" ? config : raw);
    if (this.liveSpawn) {
      throw new AdapterError(
        "E_UNSUPPORTED",
        "mcp_bridge live child spawn is last-resort and disabled in this MVP. Import with simulator (default) to catalog prefixed tools. Vendors should use Partner or native adapters, not MCP.",
        { protocol: "mcp_bridge" },
      );
    }
  }

  async disconnect(): Promise<void> {
    this.servers = {};
  }

  async listTools(): Promise<McpToolSchema[]> {
    const tools: McpToolSchema[] = [];
    for (const name of Object.keys(this.servers).sort()) {
      tools.push({
        name: `${name}_describe`,
        description: `[mcp_bridge 兜底] Describe imported server ${name} (command/args only; env never copied)`,
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
        _meta: { ingress: "mcp_bridge", child: name, fallback: true },
      });
      tools.push({
        name: `${name}_ping`,
        description: `[mcp_bridge 兜底] Ping stub for imported server ${name} (does not speak MCP to the child)`,
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
        _meta: { ingress: "mcp_bridge", child: name, fallback: true },
      });
    }
    return tools;
  }

  async invoke(toolName: string, _args: Record<string, unknown>): Promise<unknown> {
    const describe = toolName.endsWith("_describe") ? toolName.slice(0, -"_describe".length) : undefined;
    const ping = toolName.endsWith("_ping") ? toolName.slice(0, -"_ping".length) : undefined;
    const child = describe ?? ping;
    if (!child || !this.servers[child]) {
      throw new AdapterError("E_UNKNOWN_TOOL", `Unknown mcp_bridge tool ${toolName}`, { protocol: "mcp_bridge" });
    }
    const spec = this.servers[child]!;
    if (ping) {
      return { ok: true, ingress: "mcp_bridge", child, fallback: true, note: "not a live MCP session" };
    }
    return {
      ingress: "mcp_bridge",
      child,
      command: spec.command,
      args: spec.args ?? [],
      url: spec.url,
      envPresent: false,
      fallback: true,
      note: "MCP bridge is last-resort 兜底. Prefer Partner protocol or native OpenAPI adapters. Live spawn is E_UNSUPPORTED.",
    };
  }

  async health(): Promise<AdapterHealth> {
    return {
      ok: true,
      detail: `mcp_bridge 兜底 · ${Object.keys(this.servers).length} imported server(s); live spawn off`,
    };
  }
}

export function mcpServersFromConfig(config: JsonObject): Record<string, McpServerSpec> {
  return parseMcpServersJson(config.mcpServers ?? config);
}
