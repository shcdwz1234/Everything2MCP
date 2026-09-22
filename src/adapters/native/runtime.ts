import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AdapterError } from "../../runtime/errors.js";
import { fetchSafe } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpJsonSchema, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";
import { requiredString, stringField } from "../helpers.js";

export type Json = Record<string, unknown>;

export async function jsonFetch(
  url: string,
  opts: {
    method?: string;
    token?: string;
    body?: unknown;
    timeoutMs?: number;
    headers?: Record<string, string>;
    protocol: string;
  },
): Promise<unknown> {
  const headers: Record<string, string> = { accept: "application/json", ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers["content-type"] = headers["content-type"] ?? "application/json";
  if (opts.token) headers.authorization = opts.token.startsWith("Bearer ") ? opts.token : `Bearer ${opts.token}`;
  const res = await fetchSafe(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    timeoutMs: opts.timeoutMs ?? 5000,
  });
  const text = await res.text();
  if (res.status === 404) {
    throw new AdapterError("E_NOT_FOUND", `${opts.protocol} ${url} missing`, { protocol: opts.protocol });
  }
  if (res.status >= 400) {
    throw new AdapterError("E_PROTOCOL", `${opts.protocol} ${opts.method ?? "GET"} ${res.status}: ${text.slice(0, 200)}`, {
      protocol: opts.protocol,
    });
  }
  return text ? JSON.parse(text) : {};
}

export function tool(
  name: string,
  description: string,
  opts: { write?: boolean; properties?: Record<string, unknown>; required?: string[] } = {},
): McpToolSchema {
  const inputSchema: McpJsonSchema = {
    type: "object",
    properties: opts.properties ?? {},
    additionalProperties: false,
    ...(opts.required ? { required: opts.required } : {}),
  };
  return {
    name,
    description,
    inputSchema,
    annotations: opts.write ? { readOnlyHint: false } : { readOnlyHint: true },
  };
}

export async function listenJsonLoopback(
  route: (req: { method: string; pathname: string; query: URLSearchParams; body: unknown }) => Promise<{
    status?: number;
    body: unknown;
  }>,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: unknown;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      res.setHeader("content-type", "application/json");
      try {
        const out = await route({
          method: (req.method ?? "GET").toUpperCase(),
          pathname: url.pathname,
          query: url.searchParams,
          body,
        });
        res.statusCode = out.status ?? 200;
        res.end(JSON.stringify(out.body));
      } catch (err) {
        res.statusCode = err instanceof AdapterError && err.code === "E_NOT_FOUND" ? 404 : 500;
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    })();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as { port: number }).port, close: () => new Promise((r) => server.close(() => r())) };
}

export abstract class NativeAppAdapter implements ProtocolAdapter {
  abstract readonly protocol: string;
  protected allowWrite = false;
  protected timeoutMs = 5000;
  protected token: string | undefined;
  protected baseUrl: string | undefined;
  protected simulator = false;

  constructor(readonly id: string) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    this.allowWrite = allowWriteFrom(config);
    this.timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 5000;
    this.token = stringField(config, "token") ?? stringField(config, "accessToken");
    const url = stringField(config, "url") ?? stringField(config, "baseUrl");
    this.simulator = config.simulator === true || !url;
    this.baseUrl = url?.replace(/\/+$/, "");
    await this.onConnect(config);
  }

  async disconnect(): Promise<void> {
    await this.onDisconnect();
    this.baseUrl = undefined;
  }

  async health(): Promise<AdapterHealth> {
    return { ok: true, detail: this.simulator ? "simulator" : "http" };
  }

  protected assertWrite(): void {
    assertCanWrite(this.protocol, this.allowWrite);
  }

  protected async http(method: string, path: string, body?: unknown): Promise<unknown> {
    if (!this.baseUrl) throw new AdapterError("E_NOT_CONNECTED", `${this.protocol} not connected`, { protocol: this.protocol });
    return jsonFetch(`${this.baseUrl}${path}`, {
      method,
      token: this.token,
      body,
      timeoutMs: this.timeoutMs,
      protocol: this.protocol,
    });
  }

  protected str(args: Record<string, unknown>, key: string): string {
    return requiredString(args, key);
  }

  protected abstract onConnect(config: Record<string, unknown>): Promise<void>;
  protected abstract onDisconnect(): Promise<void>;
  abstract listTools(): Promise<McpToolSchema[]>;
  abstract invoke(toolName: string, args: Record<string, unknown>): Promise<unknown>;
}
