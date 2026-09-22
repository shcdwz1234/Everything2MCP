import { readdirSync, readFileSync } from "node:fs";
import { AdapterError } from "../../runtime/errors.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowShellFrom, assertCanShell, osFamily } from "./common.js";

export interface ProcessRow {
  pid: number;
  name: string;
  cmd?: string;
}

export type ProcessDriver = (limit: number) => ProcessRow[];

export class PlatformProcessAdapter implements ProtocolAdapter {
  readonly protocol = "platform_process";
  private connected = false;
  private allowShell = false;
  private driver: ProcessDriver | undefined;
  private plat: NodeJS.Platform = process.platform;

  constructor(readonly id: string) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    this.allowShell = allowShellFrom(config);
    this.plat = typeof config.platform === "string" ? (config.platform as NodeJS.Platform) : process.platform;
    if (typeof config.listFn === "function") this.driver = config.listFn as ProcessDriver;
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.driver = undefined;
  }

  async listTools(): Promise<McpToolSchema[]> {
    return [
      {
        name: "process_list",
        description: "List processes (Linux /proc; Windows/macOS best-effort). Read-only.",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "integer", default: 50 } },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: "shell_exec",
        description: "Gated stub. Default deny. Even with allowShell=true this v1 tool does not execute commands.",
        inputSchema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.connected) throw new AdapterError("E_NOT_CONNECTED", "platform_process not connected", { protocol: this.protocol });
    if (toolName === "shell_exec") {
      assertCanShell(this.protocol, this.allowShell);
      throw new AdapterError(
        "E_UNSUPPORTED",
        "allowShell is on, but shell_exec is a Phase V stub and does not run commands",
        { protocol: this.protocol },
      );
    }
    if (toolName !== "process_list") {
      throw new AdapterError("E_UNKNOWN_TOOL", `Unknown tool ${toolName}`, { protocol: this.protocol });
    }
    const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(args.limit, 500) : 50;
    const family = osFamily(this.plat);
    if (this.driver) return { family, processes: this.driver(limit), allowShell: this.allowShell };
    if (family === "linux") return { family, processes: listLinux(limit), allowShell: this.allowShell };
    return {
      family,
      processes: [],
      allowShell: this.allowShell,
      gap: `${family} process_list has no hermetic driver in this environment (inject listFn); not faked`,
    };
  }

  async health(): Promise<AdapterHealth> {
    return { ok: this.connected, detail: `allowShell=${this.allowShell}` };
  }
}

function listLinux(limit: number): ProcessRow[] {
  const rows: ProcessRow[] = [];
  let names: string[] = [];
  try {
    names = readdirSync("/proc");
  } catch {
    return rows;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let comm = "";
    let cmd = "";
    try {
      comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    } catch {
      continue;
    }
    try {
      cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim();
    } catch {
      cmd = comm;
    }
    rows.push({ pid, name: comm, cmd });
    if (rows.length >= limit) break;
  }
  return rows;
}
