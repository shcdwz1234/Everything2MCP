import { readdirSync, readFileSync, statSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { AdapterError } from "../../runtime/errors.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { osFamily } from "./common.js";

const DEFAULT_ROOTS: Record<string, string[]> = {
  linux: ["/etc", "/usr/share", "/var/log", "/proc"],
  darwin: ["/etc", "/usr/share", "/var/log"],
  win32: ["C:\\Windows\\System32\\drivers\\etc"],
  other: ["/etc"],
};

export class PlatformFsAdapter implements ProtocolAdapter {
  readonly protocol = "platform_fs";
  private connected = false;
  private roots: string[] = [];
  private maxBytes = 64_000;

  constructor(readonly id: string) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    if (config.allowWrite === true) {
      throw new AdapterError("E_UNSUPPORTED", "platform_fs is read-only; allowWrite cannot enable writes", {
        protocol: this.protocol,
      });
    }
    const plat = typeof config.platform === "string" ? config.platform : process.platform;
    const configured = Array.isArray(config.roots)
      ? config.roots.filter((r): r is string => typeof r === "string" && r.trim().length > 0)
      : [];
    this.roots = (configured.length ? configured : DEFAULT_ROOTS[osFamily(plat as NodeJS.Platform)] ?? DEFAULT_ROOTS.other!).map(
      (r) => resolve(r),
    );
    if (typeof config.maxBytes === "number" && config.maxBytes > 0) this.maxBytes = Math.min(config.maxBytes, 1_000_000);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async listTools(): Promise<McpToolSchema[]> {
    return [
      {
        name: "list",
        description: "List files under an allowed root (no write, no path escape).",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: "read",
        description: "Read a small text file under an allowed root.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: "roots",
        description: "Show gated filesystem roots.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.require();
    if (toolName === "roots") return { roots: this.roots, allowWrite: false };
    if (toolName === "list") {
      const path = typeof args.path === "string" && args.path.trim() ? args.path : this.roots[0];
      if (!path) throw new AdapterError("E_INVALID_ARGUMENT", "path required", { protocol: this.protocol });
      const resolved = this.gate(path);
      const entries = readdirSync(resolved, { withFileTypes: true }).slice(0, 200).map((e) => ({
        name: e.name,
        type: e.isDirectory() ? "dir" : e.isFile() ? "file" : "other",
      }));
      return { path: resolved, entries };
    }
    if (toolName === "read") {
      const path = typeof args.path === "string" ? args.path : "";
      if (!path) throw new AdapterError("E_INVALID_ARGUMENT", "path required", { protocol: this.protocol });
      const resolved = this.gate(path);
      const st = statSync(resolved);
      if (!st.isFile()) throw new AdapterError("E_INVALID_ARGUMENT", "not a file", { protocol: this.protocol });
      if (st.size > this.maxBytes) {
        throw new AdapterError("E_UNSUPPORTED", `file larger than maxBytes=${this.maxBytes}`, { protocol: this.protocol });
      }
      return { path: resolved, bytes: st.size, text: readFileSync(resolved, "utf8") };
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown tool ${toolName}`, { protocol: this.protocol });
  }

  async health(): Promise<AdapterHealth> {
    return { ok: this.connected, detail: `roots=${this.roots.length}` };
  }

  private gate(input: string): string {
    const abs = isAbsolute(input) ? resolve(input) : resolve(this.roots[0] ?? ".", input);
    let real = abs;
    try {
      real = realpathSync(abs);
    } catch {
      real = abs;
    }
    const ok = this.roots.some((root) => isInside(real, root));
    if (!ok) {
      throw new AdapterError("E_UNSUPPORTED", `path is outside gated roots: ${input}`, {
        protocol: this.protocol,
        details: { roots: this.roots },
      });
    }
    return real;
  }

  private require(): void {
    if (!this.connected) throw new AdapterError("E_NOT_CONNECTED", "platform_fs not connected", { protocol: this.protocol });
  }
}

function isInside(path: string, root: string): boolean {
  const nPath = normalizeSep(path);
  const nRoot = normalizeSep(root);
  return nPath === nRoot || nPath.startsWith(nRoot.endsWith("/") ? nRoot : `${nRoot}/`);
}

function normalizeSep(p: string): string {
  return p.split(sep).join("/").replace(/\/+$/, "") || "/";
}

