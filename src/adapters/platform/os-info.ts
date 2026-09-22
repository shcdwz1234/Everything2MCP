import { hostname, release, type, arch, platform, homedir, userInfo } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { AdapterError } from "../../runtime/errors.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { osFamily } from "./common.js";

export class OsInfoAdapter implements ProtocolAdapter {
  readonly protocol = "os_info";
  private connected = false;
  private plat: NodeJS.Platform = process.platform;

  constructor(readonly id: string) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    if (typeof config.platform === "string") this.plat = config.platform as NodeJS.Platform;
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async listTools(): Promise<McpToolSchema[]> {
    return [
      {
        name: "uname",
        description: "OS/arch/hostname snapshot (read-only).",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
      },
    ];
  }

  async invoke(toolName: string, _args: Record<string, unknown>): Promise<unknown> {
    this.require();
    if (toolName !== "uname") throw new AdapterError("E_UNKNOWN_TOOL", `Unknown tool ${toolName}`, { protocol: this.protocol });
    let username: string | undefined;
    try {
      username = userInfo().username;
    } catch {
      username = undefined;
    }
    const distro = readDistro(this.plat);
    return {
      platform: this.plat,
      family: osFamily(this.plat),
      arch: arch(),
      type: type(),
      release: release(),
      hostname: hostname(),
      homedir: homedir(),
      username,
      distro,
      node: process.versions.node,
    };
  }

  async health(): Promise<AdapterHealth> {
    return { ok: this.connected, detail: this.plat };
  }

  private require(): void {
    if (!this.connected) throw new AdapterError("E_NOT_CONNECTED", "os_info not connected", { protocol: this.protocol });
  }
}

function readDistro(plat: NodeJS.Platform): string | undefined {
  if (plat !== "linux") return plat === "win32" ? "Windows" : plat === "darwin" ? "macOS" : undefined;
  try {
    if (!existsSync("/etc/os-release")) return undefined;
    const raw = readFileSync("/etc/os-release", "utf8");
    return raw.match(/^PRETTY_NAME="?(.*?)"?$/m)?.[1];
  } catch {
    return undefined;
  }
}
