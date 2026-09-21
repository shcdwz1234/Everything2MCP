import { headersFromConfig } from "../../runtime/auth.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { requiredString, stringField } from "../helpers.js";
import { AdapterError } from "../../runtime/errors.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";
import { assertRpcCanWrite, looksLikeReadRpc } from "../rpc-gate.js";
import WebSocket from "ws";

export type JsonRpcTransport = (payload: unknown) => Promise<unknown>;

export class JsonRpcAdapter implements ProtocolAdapter {
  readonly protocol = "jsonrpc";
  private url = "";
  private headers: Record<string, string> = {};
  private connected = false;
  private nextId = 1;
  private transport: JsonRpcTransport | undefined;
  private socket: WebSocket | undefined;
  private allowWrite = false;

  constructor(
    readonly id: string,
    private readonly transportFn?: (config: Record<string, unknown>) => JsonRpcTransport,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    const url = stringField(config, "url") ?? stringField(config, "endpoint");
    if (!url) throw new Error("JSON-RPC adapter requires config.url");
    this.url = url;
    this.allowWrite = allowWriteFrom(config);
    this.headers = headersFromConfig(config, { "content-type": "application/json" });
    if (this.transportFn) {
      this.transport = this.transportFn(config);
    } else if (/^wss?:\/\//i.test(url)) {
      this.transport = await this.connectWs(url);
    } else {
      this.transport = httpTransport(url, this.headers);
    }
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.socket) {
      this.socket.close();
      this.socket = undefined;
    }
  }

  async listTools(): Promise<McpToolSchema[]> {
    this.assertConnected();
    return [
      {
        name: "call",
        description: "JSON-RPC 2.0 request (read-like method names allowed; others require allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: {
            method: { type: "string" },
            params: {},
            id: {},
          },
          required: ["method"],
          additionalProperties: false,
        },
      },
      {
        name: "notify",
        description: "JSON-RPC 2.0 notification (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: {
            method: { type: "string" },
            params: {},
          },
          required: ["method"],
          additionalProperties: false,
        },
      },
      {
        name: "batch",
        description: "JSON-RPC 2.0 batch (all-read batch allowed; any write-like method requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: {
            calls: { type: "array", items: { type: "object" } },
          },
          required: ["calls"],
          additionalProperties: false,
        },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const send = this.transport!;
    if (toolName === "call") {
      const method = requiredString(args, "method");
      assertRpcCanWrite("jsonrpc", this.allowWrite, method);
      const id = args.id ?? this.nextId++;
      return send({ jsonrpc: "2.0", method, params: args.params ?? [], id });
    }
    if (toolName === "notify") {
      assertCanWrite("jsonrpc", this.allowWrite);
      await send({ jsonrpc: "2.0", method: requiredString(args, "method"), params: args.params ?? [] });
      return { ok: true, notification: true };
    }
    if (toolName === "batch") {
      if (!Array.isArray(args.calls)) throw new Error("batch requires calls[]");
      const methods = args.calls.map((c) => {
        const rec = c as Record<string, unknown>;
        return typeof rec.method === "string" ? rec.method : "";
      });
      if (!methods.every((m) => looksLikeReadRpc(m))) {
        assertRpcCanWrite("jsonrpc", this.allowWrite, methods.find((m) => !looksLikeReadRpc(m)) || "batch");
      }
      const payload = args.calls.map((c) => {
        const rec = c as Record<string, unknown>;
        const method = typeof rec.method === "string" ? rec.method : "";
        const base: Record<string, unknown> = { jsonrpc: "2.0", method, params: rec.params ?? [] };
        if (rec.notify) return base;
        base.id = rec.id ?? this.nextId++;
        return base;
      });
      return send(payload);
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown JSON-RPC tool "${toolName}"`, { protocol: "jsonrpc" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return { ok: true, detail: `url=${this.url} allowWrite=${this.allowWrite}` };
  }

  private async connectWs(url: string): Promise<JsonRpcTransport> {
    const ws = new WebSocket(url);
    this.socket = ws;
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return async (payload) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("JSON-RPC WS timeout")), 5000);
        ws.once("message", (data) => {
          clearTimeout(timer);
          const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
          try {
            resolve(JSON.parse(text));
          } catch {
            resolve(text);
          }
        });
        ws.send(JSON.stringify(payload));
      });
  }

  private assertConnected(): void {
    if (!this.connected || !this.transport) {
      throw new AdapterError("E_NOT_CONNECTED", "JSON-RPC adapter is not connected", { protocol: "jsonrpc" });
    }
  }
}

function httpTransport(url: string, headers: Record<string, string>): JsonRpcTransport {
  return async (payload) => {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { status: res.status, data: text };
    }
  };
}

function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
