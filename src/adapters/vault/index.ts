import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AdapterError } from "../../runtime/errors.js";
import { fetchSafe } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { requiredString, stringField } from "../helpers.js";

export interface VaultHandle {
  health(): Promise<Record<string, unknown>>;
  listMounts(): Promise<string[]>;
  listKeys(mount: string): Promise<string[]>;
  readSecret(path: string): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export type VaultConnectFn = (config: Record<string, unknown>) => Promise<VaultHandle>;

export function createMemoryVault(): VaultHandle {
  const mounts = ["secret/", "sys/"];
  const keys = new Map<string, string[]>([["secret/", ["app/db", "app/api"]]]);
  const secrets = new Map<string, Record<string, unknown>>([["secret/data/app/db", { user: "app", password: "s3cret" }]]);
  return {
    async health() {
      return { initialized: true, sealed: false, version: "1.15-e2mcp" };
    },
    async listMounts() {
      return [...mounts];
    },
    async listKeys(mount) {
      const prefix = mount.endsWith("/") ? mount : `${mount}/`;
      return keys.get(prefix) ?? [];
    },
    async readSecret(path) {
      const hit = secrets.get(path) ?? secrets.get(`secret/data/${path}`);
      if (!hit) throw new AdapterError("E_NOT_FOUND", `vault secret ${path} missing`, { protocol: "vault" });
      return { data: { ...hit } };
    },
    async close() {
      secrets.clear();
    },
  };
}

async function httpVault(base: string, timeoutMs: number, token?: string): Promise<VaultHandle> {
  const root = base.replace(/\/+$/, "");
  const request = async (method: string, path: string) => {
    const headers: Record<string, string> = { accept: "application/json" };
    if (token) headers["x-vault-token"] = token;
    const res = await fetchSafe(`${root}${path}`, { method, headers, timeoutMs });
    const text = await res.text();
    if (res.status === 404) throw new AdapterError("E_NOT_FOUND", `vault ${path} missing`, { protocol: "vault" });
    if (res.status >= 400) {
      throw new AdapterError("E_PROTOCOL", `vault ${method} ${path} ${res.status}: ${text.slice(0, 200)}`, {
        protocol: "vault",
      });
    }
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  };
  return {
    async health() {
      return request("GET", "/v1/sys/health");
    },
    async listMounts() {
      const json = await request("GET", "/v1/sys/mounts");
      return Object.keys(json).filter((k) => k !== "request_id" && k !== "lease_id").sort();
    },
    async listKeys(mount) {
      const json = await request("LIST", `/v1/${mount.replace(/^\/+|\/+$/g, "")}/metadata`);
      const data = json.data as { keys?: string[] } | undefined;
      return data?.keys ?? [];
    },
    async readSecret(path) {
      return request("GET", `/v1/${path.replace(/^\/+/, "")}`);
    },
    async close() {
      /* http */
    },
  };
}

export class VaultAdapter implements ProtocolAdapter {
  readonly protocol = "vault";
  private handle: VaultHandle | undefined;
  private allowReadSecrets = false;

  constructor(
    readonly id: string,
    private readonly connectFn: VaultConnectFn = defaultConnect,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    this.allowReadSecrets = config.allowReadSecrets === true;
    this.handle = await this.connectFn(config);
  }

  async disconnect(): Promise<void> {
    await this.handle?.close();
    this.handle = undefined;
  }

  async listTools(): Promise<McpToolSchema[]> {
    return [
      {
        name: "health",
        description: "GET /v1/sys/health (no secret values).",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
      },
      {
        name: "list_mounts",
        description: "List secret engines. Names only.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
      },
      {
        name: "list_keys",
        description: "List secret key names under a mount (metadata). Never returns values.",
        inputSchema: {
          type: "object",
          properties: { mount: { type: "string", default: "secret/" } },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: "read_secret",
        description: "Read secret payload. Default deny. Requires allowReadSecrets=true (not opened by inventory/suggest).",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.handle) throw new AdapterError("E_NOT_CONNECTED", "vault not connected", { protocol: this.protocol });
    if (toolName === "health") return this.handle.health();
    if (toolName === "list_mounts") return { mounts: await this.handle.listMounts() };
    if (toolName === "list_keys") {
      const mount = typeof args.mount === "string" && args.mount ? args.mount : "secret/";
      return { keys: await this.handle.listKeys(mount) };
    }
    if (toolName === "read_secret") {
      if (!this.allowReadSecrets) {
        throw new AdapterError("E_UNSUPPORTED", "vault read_secret blocked (allowReadSecrets=false; suggest never sets this)", {
          protocol: this.protocol,
        });
      }
      return this.handle.readSecret(requiredString(args, "path"));
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown tool ${toolName}`, { protocol: this.protocol });
  }

  async health(): Promise<AdapterHealth> {
    return { ok: Boolean(this.handle), detail: `allowReadSecrets=${this.allowReadSecrets}` };
  }
}

async function defaultConnect(config: Record<string, unknown>): Promise<VaultHandle> {
  const url = stringField(config, "url") ?? stringField(config, "address");
  if (config.simulator === true || !url) return createMemoryVault();
  const timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 4000;
  return httpVault(url, timeoutMs, stringField(config, "token"));
}

export async function listenVaultLoopback(mem: VaultHandle = createMemoryVault()): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      res.setHeader("content-type", "application/json");
      try {
        if (path === "/v1/sys/health") {
          res.end(JSON.stringify(await mem.health()));
          return;
        }
        if (path === "/v1/sys/mounts") {
          const mounts = await mem.listMounts();
          const body: Record<string, unknown> = {};
          for (const m of mounts) body[m] = { type: "kv" };
          res.end(JSON.stringify(body));
          return;
        }
        res.statusCode = 404;
        res.end("{}");
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ errors: [err instanceof Error ? err.message : String(err)] }));
      }
    })();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as { port: number }).port, close: () => new Promise((r) => server.close(() => r())) };
}
