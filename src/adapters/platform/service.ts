import { spawnSync } from "node:child_process";
import { AdapterError } from "../../runtime/errors.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowShellFrom, osFamily } from "./common.js";

export interface ServiceRow {
  id: string;
  state?: string;
  detail?: string;
}

export type ServiceDriver = () => ServiceRow[];

export class PlatformServiceAdapter implements ProtocolAdapter {
  readonly protocol = "platform_service";
  private connected = false;
  private allowShell = false;
  private driver: ServiceDriver | undefined;
  private plat: NodeJS.Platform = process.platform;

  constructor(readonly id: string) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    this.allowShell = allowShellFrom(config);
    this.plat = typeof config.platform === "string" ? (config.platform as NodeJS.Platform) : process.platform;
    if (typeof config.listFn === "function") this.driver = config.listFn as ServiceDriver;
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.driver = undefined;
  }

  async listTools(): Promise<McpToolSchema[]> {
    return [
      {
        name: "service_list",
        description: "Best-effort service list (systemctl / sc.exe / launchctl). Read-only. Missing tools → E_UNSUPPORTED, not fake success.",
        inputSchema: { type: "object", properties: { limit: { type: "integer", default: 40 } }, additionalProperties: false },
        annotations: { readOnlyHint: true },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.connected) throw new AdapterError("E_NOT_CONNECTED", "platform_service not connected", { protocol: this.protocol });
    if (toolName !== "service_list") {
      throw new AdapterError("E_UNKNOWN_TOOL", `Unknown tool ${toolName}`, { protocol: this.protocol });
    }
    const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(args.limit, 200) : 40;
    if (this.driver) return { family: osFamily(this.plat), services: this.driver().slice(0, limit), allowShell: this.allowShell };

    const family = osFamily(this.plat);
    if (family === "linux") {
      const listed = trySystemctl(limit);
      if (listed) return { family, services: listed, allowShell: this.allowShell };
      throw new AdapterError("E_UNSUPPORTED", "systemctl not available; service_list not faked", { protocol: this.protocol });
    }
    if (family === "win32") {
      const listed = trySc(limit);
      if (listed) return { family, services: listed, allowShell: this.allowShell };
      throw new AdapterError("E_UNSUPPORTED", "sc.exe not available; service_list not faked", { protocol: this.protocol });
    }
    if (family === "darwin") {
      const listed = tryLaunchctl(limit);
      if (listed) return { family, services: listed, allowShell: this.allowShell };
      throw new AdapterError("E_UNSUPPORTED", "launchctl not available; macOS service_list is best-effort", {
        protocol: this.protocol,
      });
    }
    throw new AdapterError("E_UNSUPPORTED", `service_list unsupported on ${family}`, { protocol: this.protocol });
  }

  async health(): Promise<AdapterHealth> {
    return { ok: this.connected, detail: osFamily(this.plat) };
  }
}

function trySystemctl(limit: number): ServiceRow[] | undefined {
  const r = spawnSync("systemctl", ["list-units", "--type=service", "--no-pager", "--no-legend"], {
    encoding: "utf8",
    timeout: 4000,
  });
  if (r.error || r.status !== 0 || !r.stdout) return undefined;
  return r.stdout
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, limit)
    .map((line) => {
      const cols = line.split(/\s+/);
      return { id: cols[0] ?? line, state: cols[2] ?? cols[1], detail: line };
    });
}

function trySc(limit: number): ServiceRow[] | undefined {
  const r = spawnSync("sc", ["query", "type=", "service", "state=", "all"], { encoding: "utf8", timeout: 4000 });
  if (r.error || r.status !== 0 || !r.stdout) return undefined;
  const rows: ServiceRow[] = [];
  let current: ServiceRow | undefined;
  for (const line of r.stdout.split(/\r?\n/)) {
    const name = line.match(/SERVICE_NAME:\s*(.+)/i);
    if (name) {
      current = { id: name[1]!.trim() };
      rows.push(current);
      if (rows.length >= limit) break;
      continue;
    }
    const st = line.match(/STATE\s*:\s*\d+\s+(\w+)/i);
    if (st && current) current.state = st[1];
  }
  return rows.length ? rows : undefined;
}

function tryLaunchctl(limit: number): ServiceRow[] | undefined {
  const r = spawnSync("launchctl", ["list"], { encoding: "utf8", timeout: 4000 });
  if (r.error || r.status !== 0 || !r.stdout) return undefined;
  return r.stdout
    .split(/\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, limit)
    .map((line) => {
      const cols = line.split(/\s+/);
      return { id: cols[2] ?? line, state: cols[0], detail: line };
    });
}
