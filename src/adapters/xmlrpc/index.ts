import { headersFromConfig } from "../../runtime/auth.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { requiredString, stringArray, stringField } from "../helpers.js";
import { AdapterError } from "../../runtime/errors.js";
import { allowWriteFrom } from "../sql/common.js";
import { assertRpcCanWrite } from "../rpc-gate.js";
import { decodeMethodResponse, encodeMethodCall } from "./codec.js";

export type XmlRpcTransport = (xml: string) => Promise<string>;

export class XmlRpcAdapter implements ProtocolAdapter {
  readonly protocol = "xmlrpc";
  private url = "";
  private headers: Record<string, string> = {};
  private connected = false;
  private methods: string[] = [];
  private transport: XmlRpcTransport | undefined;
  private allowWrite = false;

  constructor(
    readonly id: string,
    private readonly transportFn?: (config: Record<string, unknown>) => XmlRpcTransport,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    const url = stringField(config, "url") ?? stringField(config, "endpoint");
    if (!url) throw new Error("XML-RPC adapter requires config.url");
    this.url = url;
    this.allowWrite = allowWriteFrom(config);
    this.headers = headersFromConfig(config, { "content-type": "text/xml" });
    this.transport = this.transportFn?.(config) ?? defaultHttpTransport(this.url, this.headers);
    this.connected = true;
    this.methods = stringArray(config.methods);
    if (config.introspect !== false) {
      try {
        const listed = await this.call("system.listMethods", []);
        if (Array.isArray(listed)) this.methods = listed.filter((m): m is string => typeof m === "string");
      } catch {
        /* optional */
      }
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.methods = [];
  }

  async listTools(): Promise<McpToolSchema[]> {
    this.assertConnected();
    const tools: McpToolSchema[] = [
      {
        name: "list_methods",
        description: "Call system.listMethods (or return cached names)",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "call",
        description: "Invoke an XML-RPC method (read-like names allowed; others require allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: {
            method: { type: "string" },
            params: { type: "array" },
          },
          required: ["method"],
          additionalProperties: false,
        },
      },
    ];
    for (const m of this.methods.filter((x) => x !== "system.listMethods")) {
      tools.push({
        name: `rpc_${sanitize(m)}`,
        description: `XML-RPC ${m}`,
        inputSchema: {
          type: "object",
          properties: { params: { type: "array" } },
          additionalProperties: true,
        },
      });
    }
    return tools;
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    if (toolName === "list_methods") {
      try {
        const listed = await this.call("system.listMethods", []);
        if (Array.isArray(listed)) this.methods = listed.filter((m): m is string => typeof m === "string");
      } catch {
        /* keep cache */
      }
      return { methods: this.methods };
    }
    if (toolName === "call") {
      const method = requiredString(args, "method");
      assertRpcCanWrite("xmlrpc", this.allowWrite, method);
      const params = Array.isArray(args.params) ? args.params : [];
      return { result: await this.call(method, params) };
    }
    if (toolName.startsWith("rpc_")) {
      const method = this.methods.find((m) => `rpc_${sanitize(m)}` === toolName);
      if (!method) {
        throw new AdapterError("E_UNKNOWN_TOOL", `Unknown XML-RPC tool "${toolName}"`, { protocol: "xmlrpc" });
      }
      assertRpcCanWrite("xmlrpc", this.allowWrite, method);
      const params = Array.isArray(args.params) ? args.params : [];
      return { result: await this.call(method, params) };
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown XML-RPC tool "${toolName}"`, { protocol: "xmlrpc" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return { ok: true, detail: `url=${this.url} methods=${this.methods.length} allowWrite=${this.allowWrite}` };
  }

  private async call(method: string, params: unknown[]): Promise<unknown> {
    const xml = encodeMethodCall(method, params);
    const body = await this.transport!(xml);
    return decodeMethodResponse(body);
  }

  private assertConnected(): void {
    if (!this.connected || !this.transport) {
      throw new AdapterError("E_NOT_CONNECTED", "XML-RPC adapter is not connected", { protocol: "xmlrpc" });
    }
  }
}

function defaultHttpTransport(url: string, headers: Record<string, string>): XmlRpcTransport {
  return async (xml) => {
    const res = await fetch(url, { method: "POST", headers, body: xml });
    return res.text();
  };
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
