import { AdapterError } from "../../runtime/errors.js";
import { fetchSafe } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";
import { requiredString, stringField } from "../helpers.js";

export interface ConsulHandle {
  kvGet(key: string): Promise<{ key: string; value: string } | undefined>;
  kvPut(key: string, value: string): Promise<{ key: string }>;
  kvDelete(key: string): Promise<{ deleted: boolean }>;
  catalogServices(): Promise<string[]>;
  healthService(service: string): Promise<Array<{ name: string; status: string; address?: string }>>;
  close(): Promise<void>;
}

export type ConsulConnectFn = (config: Record<string, unknown>) => Promise<ConsulHandle>;

export function createMemoryConsul(): ConsulHandle {
  const kv = new Map<string, string>();
  const services = new Map<string, { status: string; address: string }>([
    ["consul", { status: "passing", address: "127.0.0.1" }],
  ]);
  return {
    async kvGet(key) {
      const value = kv.get(key);
      return value === undefined ? undefined : { key, value };
    },
    async kvPut(key, value) {
      kv.set(key, value);
      return { key };
    },
    async kvDelete(key) {
      return { deleted: kv.delete(key) };
    },
    async catalogServices() {
      return [...services.keys()].sort();
    },
    async healthService(service) {
      const hit = services.get(service);
      if (!hit) return [];
      return [{ name: service, status: hit.status, address: hit.address }];
    },
    async close() {
      kv.clear();
    },
  };
}

async function httpHandle(base: string, timeoutMs: number, token?: string): Promise<ConsulHandle> {
  const root = base.replace(/\/+$/, "");
  const headers: Record<string, string> = token ? { "X-Consul-Token": token } : {};
  const req = async (method: string, path: string, body?: string) => {
    const res = await fetchSafe(`${root}${path}`, { method, headers, body, timeoutMs });
    const text = await res.text();
    if (res.status === 404) return { status: 404, text: "" };
    if (res.status >= 400) {
      throw new AdapterError("E_PROTOCOL", `consul ${method} ${path} ${res.status}: ${text.slice(0, 200)}`, {
        protocol: "consul",
      });
    }
    return { status: res.status, text };
  };
  return {
    async kvGet(key) {
      const { status, text } = await req("GET", `/v1/kv/${encodeURIComponent(key)}`);
      if (status === 404 || !text) return undefined;
      const json = JSON.parse(text) as Array<{ Key?: string; Value?: string }>;
      const row = json[0];
      if (!row) return undefined;
      return { key: row.Key ?? key, value: row.Value ? Buffer.from(row.Value, "base64").toString("utf8") : "" };
    },
    async kvPut(key, value) {
      await req("PUT", `/v1/kv/${encodeURIComponent(key)}`, value);
      return { key };
    },
    async kvDelete(key) {
      const { status } = await req("DELETE", `/v1/kv/${encodeURIComponent(key)}`);
      return { deleted: status !== 404 };
    },
    async catalogServices() {
      const { text } = await req("GET", "/v1/catalog/services");
      const json = JSON.parse(text || "{}") as Record<string, unknown>;
      return Object.keys(json).sort();
    },
    async healthService(service) {
      const { text } = await req("GET", `/v1/health/service/${encodeURIComponent(service)}`);
      const json = JSON.parse(text || "[]") as Array<{ Service?: { Service?: string; Address?: string }; Checks?: Array<{ Status?: string }> }>;
      return json.map((row) => ({
        name: row.Service?.Service ?? service,
        status: row.Checks?.[0]?.Status ?? "unknown",
        address: row.Service?.Address,
      }));
    },
    async close() {
      /* stateless */
    },
  };
}

async function defaultConnect(config: Record<string, unknown>): Promise<ConsulHandle> {
  const url = stringField(config, "url") ?? stringField(config, "address");
  if (config.simulator === true || !url) return createMemoryConsul();
  const timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 4000;
  return httpHandle(url, timeoutMs, stringField(config, "token"));
}

/** Consul HTTP API: KV + catalog/health. Writes require allowWrite. Not Connect/intentions. */
export class ConsulAdapter implements ProtocolAdapter {
  readonly protocol = "consul";
  private handle: ConsulHandle | undefined;
  private connected = false;
  private allowWrite = false;

  constructor(
    readonly id: string,
    private readonly connectFn: ConsulConnectFn = defaultConnect,
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
        name: "kv_get",
        description: "GET /v1/kv/:key",
        inputSchema: {
          type: "object",
          properties: { key: { type: "string" } },
          required: ["key"],
          additionalProperties: false,
        },
      },
      {
        name: "kv_put",
        description: "PUT /v1/kv/:key (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: { key: { type: "string" }, value: { type: "string" } },
          required: ["key", "value"],
          additionalProperties: false,
        },
      },
      {
        name: "kv_delete",
        description: "DELETE /v1/kv/:key (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: { key: { type: "string" } },
          required: ["key"],
          additionalProperties: false,
        },
      },
      {
        name: "catalog_services",
        description: "GET /v1/catalog/services",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "health_service",
        description: "GET /v1/health/service/:name",
        inputSchema: {
          type: "object",
          properties: { service: { type: "string" } },
          required: ["service"],
          additionalProperties: false,
        },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const h = this.handle!;
    if (toolName === "kv_get") return (await h.kvGet(requiredString(args, "key"))) ?? { missing: true };
    if (toolName === "kv_put") {
      assertCanWrite("consul", this.allowWrite);
      return h.kvPut(requiredString(args, "key"), requiredString(args, "value"));
    }
    if (toolName === "kv_delete") {
      assertCanWrite("consul", this.allowWrite);
      return h.kvDelete(requiredString(args, "key"));
    }
    if (toolName === "catalog_services") return { services: await h.catalogServices() };
    if (toolName === "health_service") return { checks: await h.healthService(requiredString(args, "service")) };
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown tool: ${toolName}`, { protocol: "consul" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected || !this.handle) return { ok: false, detail: "not connected" };
    try {
      await this.handle.catalogServices();
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_INVALID_CONFIG", "consul adapter is not connected", { protocol: "consul" });
    }
  }
}
