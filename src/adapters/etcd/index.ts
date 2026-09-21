import { AdapterError } from "../../runtime/errors.js";
import { fetchSafe } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";
import { requiredString, stringField } from "../helpers.js";

export interface EtcdKv {
  key: string;
  value: string;
}

export interface EtcdHandle {
  range(key: string, prefix?: boolean): Promise<EtcdKv[]>;
  put(key: string, value: string): Promise<{ key: string; value: string }>;
  delete(key: string): Promise<{ deleted: number }>;
  version?(): Promise<{ etcdserver?: string }>;
  close(): Promise<void>;
}

export type EtcdConnectFn = (config: Record<string, unknown>) => Promise<EtcdHandle>;

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

function fromB64(s: string): string {
  return Buffer.from(s, "base64").toString("utf8");
}

export function createMemoryEtcd(): EtcdHandle {
  const store = new Map<string, string>();
  return {
    async range(key, prefix) {
      if (!prefix) {
        const value = store.get(key);
        return value === undefined ? [] : [{ key, value }];
      }
      return [...store.entries()]
        .filter(([k]) => k.startsWith(key))
        .map(([k, value]) => ({ key: k, value }))
        .sort((a, b) => a.key.localeCompare(b.key));
    },
    async put(key, value) {
      store.set(key, value);
      return { key, value };
    },
    async delete(key) {
      return { deleted: store.delete(key) ? 1 : 0 };
    },
    async version() {
      return { etcdserver: "3.5.0-e2mcp" };
    },
    async close() {
      store.clear();
    },
  };
}

async function httpHandle(base: string, timeoutMs: number): Promise<EtcdHandle> {
  const root = base.replace(/\/+$/, "");
  const post = async (path: string, body: Record<string, unknown>) => {
    const res = await fetchSafe(`${root}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs,
    });
    const text = await res.text();
    if (res.status >= 400) {
      throw new AdapterError("E_PROTOCOL", `etcd ${path} ${res.status}: ${text.slice(0, 200)}`, { protocol: "etcd" });
    }
    return JSON.parse(text || "{}") as Record<string, unknown>;
  };
  return {
    async range(key, prefix) {
      const body: Record<string, unknown> = { key: b64(key) };
      if (prefix) {
        const end = Buffer.from(key, "utf8");
        end[end.length - 1] = end[end.length - 1]! + 1;
        body.range_end = end.toString("base64");
      }
      const json = await post("/v3/kv/range", body);
      const kvs = Array.isArray(json.kvs) ? json.kvs : [];
      return kvs
        .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object")
        .map((x) => ({
          key: typeof x.key === "string" ? fromB64(x.key) : "",
          value: typeof x.value === "string" ? fromB64(x.value) : "",
        }));
    },
    async put(key, value) {
      await post("/v3/kv/put", { key: b64(key), value: b64(value) });
      return { key, value };
    },
    async delete(key) {
      const json = await post("/v3/kv/deleterange", { key: b64(key) });
      return { deleted: typeof json.deleted === "number" ? json.deleted : Number(json.deleted ?? 0) };
    },
    async version() {
      const res = await fetchSafe(`${root}/version`, { method: "GET", timeoutMs });
      const json = (await res.json()) as { etcdserver?: string };
      return { etcdserver: json.etcdserver };
    },
    async close() {
      /* stateless */
    },
  };
}

async function defaultConnect(config: Record<string, unknown>): Promise<EtcdHandle> {
  const url = stringField(config, "url") ?? stringField(config, "endpoint");
  if (config.simulator === true || !url) return createMemoryEtcd();
  const timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 4000;
  return httpHandle(url, timeoutMs);
}

/** etcd v3 HTTP KV: range / put / delete-range. Memory or unsigned HTTP. Not gRPC watch/lease/election. */
export class EtcdAdapter implements ProtocolAdapter {
  readonly protocol = "etcd";
  private handle: EtcdHandle | undefined;
  private connected = false;
  private allowWrite = false;

  constructor(
    readonly id: string,
    private readonly connectFn: EtcdConnectFn = defaultConnect,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    this.allowWrite = allowWriteFrom(config);
    this.handle = await this.connectFn(config);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.handle) await this.handle.close();
    this.handle = undefined;
    this.connected = false;
  }

  async listTools(): Promise<McpToolSchema[]> {
    this.assertConnected();
    return [
      {
        name: "range",
        description: "GET /v3/kv/range (prefix optional)",
        inputSchema: {
          type: "object",
          properties: { key: { type: "string" }, prefix: { type: "boolean", default: false } },
          required: ["key"],
          additionalProperties: false,
        },
      },
      {
        name: "put",
        description: "PUT /v3/kv/put (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: { key: { type: "string" }, value: { type: "string" } },
          required: ["key", "value"],
          additionalProperties: false,
        },
      },
      {
        name: "delete",
        description: "POST /v3/kv/deleterange (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: { key: { type: "string" } },
          required: ["key"],
          additionalProperties: false,
        },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const h = this.handle!;
    if (toolName === "range") {
      return { kvs: await h.range(requiredString(args, "key"), args.prefix === true) };
    }
    if (toolName === "put") {
      assertCanWrite("etcd", this.allowWrite);
      return h.put(requiredString(args, "key"), requiredString(args, "value"));
    }
    if (toolName === "delete") {
      assertCanWrite("etcd", this.allowWrite);
      return h.delete(requiredString(args, "key"));
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown tool: ${toolName}`, { protocol: "etcd" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected || !this.handle) return { ok: false, detail: "not connected" };
    try {
      if (this.handle.version) {
        const v = await this.handle.version();
        return { ok: true, detail: v.etcdserver ?? "ok" };
      }
      await this.handle.range("", true);
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_INVALID_CONFIG", "etcd adapter is not connected", { protocol: "etcd" });
    }
  }
}
