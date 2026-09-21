import * as coap from "coap";
import { AdapterError } from "../../runtime/errors.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { payloadToString, requiredString, stringField, timeoutMs } from "../helpers.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";

export interface CoapResponse {
  code: string;
  payload: string;
  confirmable: boolean;
  type: "CON" | "NON";
  observe?: number;
}

export interface CoapHandle {
  request(
    method: string,
    pathname: string,
    payload?: string,
    confirmable?: boolean,
  ): Promise<CoapResponse>;
  observeOnce?(pathname: string, timeoutMs: number, confirmable?: boolean): Promise<CoapResponse>;
  cancelObserve?(pathname: string): Promise<void>;
  close(): Promise<void>;
}

export type CoapConnectFn = (config: Record<string, unknown>) => Promise<CoapHandle>;

async function defaultConnect(config: Record<string, unknown>): Promise<CoapHandle> {
  const host = stringField(config, "host") ?? "127.0.0.1";
  const port = typeof config.port === "number" ? config.port : 5683;
  const defaultConfirmable = config.confirmable !== false;
  const observers = new Map<string, { reset?: () => void }>();
  return {
    request(method, pathname, payload, confirmable = defaultConfirmable) {
      return new Promise((resolve, reject) => {
        const req = coap.request({
          hostname: host,
          port,
          pathname,
          method: method as "GET" | "POST" | "PUT" | "DELETE",
          confirmable,
        });
        req.on("response", (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            resolve({
              code: String(res.code),
              payload: Buffer.concat(chunks).toString("utf8"),
              confirmable,
              type: confirmable ? "CON" : "NON",
            });
          });
        });
        req.on("error", reject);
        if (payload) req.write(payload);
        req.end();
      });
    },
    observeOnce(pathname, ms, confirmable = defaultConfirmable) {
      return new Promise((resolve, reject) => {
        const req = coap.request({
          hostname: host,
          port,
          pathname,
          method: "GET",
          confirmable,
          observe: true,
        } as Parameters<typeof coap.request>[0]);
        const timer = setTimeout(() => {
          try {
            (req as { reset?: () => void }).reset?.();
          } catch {
            /* ignore */
          }
          reject(new AdapterError("E_TIMEOUT", `Timed out waiting for CoAP Observe on ${pathname}`, { protocol: "coap" }));
        }, ms);
        req.on("response", (res) => {
          clearTimeout(timer);
          observers.set(pathname, req as { reset?: () => void });
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const observeRaw = (res as { headers?: Record<string, unknown> }).headers?.Observe;
            resolve({
              code: String(res.code),
              payload: Buffer.concat(chunks).toString("utf8"),
              confirmable,
              type: confirmable ? "CON" : "NON",
              observe: typeof observeRaw === "number" ? observeRaw : 0,
            });
          });
        });
        req.on("error", (err: Error) => {
          clearTimeout(timer);
          reject(err);
        });
        req.end();
      });
    },
    async cancelObserve(pathname) {
      const obs = observers.get(pathname);
      try {
        obs?.reset?.();
      } catch {
        /* ignore */
      }
      observers.delete(pathname);
      await new Promise<void>((resolve, reject) => {
        const req = coap.request({
          hostname: host,
          port,
          pathname,
          method: "GET",
          confirmable: true,
          observe: 1,
        } as Parameters<typeof coap.request>[0]);
        req.on("response", () => resolve());
        req.on("error", () => resolve());
        req.on("error", reject);
        req.end();
        setTimeout(() => resolve(), 50);
      });
    },
    async close() {
      for (const obs of observers.values()) {
        try {
          obs.reset?.();
        } catch {
          /* ignore */
        }
      }
      observers.clear();
    },
  };
}

/** Confirmable CRUD + Observe once/cancel. DTLS/OSCORE still out of scope. */
export class CoapAdapter implements ProtocolAdapter {
  readonly protocol = "coap";
  private handle: CoapHandle | undefined;
  private host = "";
  private connected = false;
  private confirmable = true;
  private allowWrite = false;

  constructor(
    readonly id: string,
    private readonly connectFn: CoapConnectFn = defaultConnect,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    const host = stringField(config, "host") ?? stringField(config, "url");
    if (!host) throw new AdapterError("E_INVALID_CONFIG", "CoAP adapter requires config.host");
    this.host = host.replace(/^coaps?:\/\//i, "");
    this.confirmable = config.confirmable !== false;
    this.allowWrite = allowWriteFrom(config);
    this.handle = await this.connectFn({ ...config, host: this.host });
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.handle) await this.handle.close();
    this.handle = undefined;
    this.connected = false;
  }

  async listTools(): Promise<McpToolSchema[]> {
    this.assertConnected();
    const methods = ["get", "put", "post", "delete"] as const;
    const crud = methods.map((method) => ({
      name: method,
      description:
        method === "get"
          ? `Confirmable CoAP ${method.toUpperCase()} (DTLS not implemented)`
          : `Confirmable CoAP ${method.toUpperCase()} (requires allowWrite=true; DTLS not implemented)`,
      inputSchema: {
        type: "object" as const,
        properties: {
          path: { type: "string", description: "Resource path, e.g. /sensors/temp" },
          payload: { description: "Optional body for PUT/POST" },
          confirmable: { type: "boolean", default: true },
        },
        required: ["path"],
        additionalProperties: false,
      },
    }));
    return [
      ...crud,
      {
        name: "observe_once",
        description: "CoAP Observe: wait for the first notification, then keep the registration until observe_cancel",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            timeoutMs: { type: "integer", default: 5000 },
            confirmable: { type: "boolean", default: true },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
      {
        name: "observe_cancel",
        description: "Cancel an Observe registration (GET Observe=1)",
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
    this.assertConnected();
    if (toolName === "observe_once") {
      if (!this.handle!.observeOnce) {
        throw new AdapterError("E_UNSUPPORTED", "Observe is not available on this CoAP handle", { protocol: "coap" });
      }
      const path = requiredString(args, "path");
      const confirmable = typeof args.confirmable === "boolean" ? args.confirmable : this.confirmable;
      return this.handle!.observeOnce(path.startsWith("/") ? path : `/${path}`, timeoutMs(args), confirmable);
    }
    if (toolName === "observe_cancel") {
      if (!this.handle!.cancelObserve) {
        throw new AdapterError("E_UNSUPPORTED", "Observe cancel is not available on this CoAP handle", {
          protocol: "coap",
        });
      }
      const path = requiredString(args, "path");
      await this.handle!.cancelObserve(path.startsWith("/") ? path : `/${path}`);
      return { ok: true, cancelled: true };
    }
    const method = toolName.toUpperCase();
    if (!["GET", "PUT", "POST", "DELETE"].includes(method)) {
      throw new AdapterError("E_UNKNOWN_TOOL", `Unknown CoAP tool "${toolName}"`, { protocol: "coap" });
    }
    if (method !== "GET") assertCanWrite("coap", this.allowWrite);
    const path = requiredString(args, "path");
    const payload = args.payload === undefined ? undefined : payloadToString(args.payload);
    const confirmable = typeof args.confirmable === "boolean" ? args.confirmable : this.confirmable;
    return this.handle!.request(method, path.startsWith("/") ? path : `/${path}`, payload, confirmable);
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return {
      ok: true,
      detail: `host=${this.host} confirmable=${this.confirmable} allowWrite=${this.allowWrite} (Observe yes / DTLS no)`,
    };
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_NOT_CONNECTED", "CoAP adapter is not connected", { protocol: "coap" });
    }
  }
}
