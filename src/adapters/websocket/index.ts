import { applyAuthHeaders, parseAuth } from "../../runtime/auth.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";
import WebSocket from "ws";

interface InboxItem {
  data: string;
  binary: boolean;
}

/**
 * WebSocket adapter: connect to a ws/wss URL and expose send + receive_once.
 * No multiplexing, no auto-reconnect, no GraphQL subscriptions over WS.
 */
export class WebSocketAdapter implements ProtocolAdapter {
  readonly protocol = "websocket";
  private socket: WebSocket | undefined;
  private inbox: InboxItem[] = [];
  private waiters: Array<(item: InboxItem) => void> = [];
  private connected = false;
  private url = "";
  private allowWrite = false;

  constructor(readonly id: string) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    const url = typeof config.url === "string" ? config.url : undefined;
    if (!url) throw new Error("WebSocket adapter requires config.url (ws:// or wss://)");
    const protocols = Array.isArray(config.protocols)
      ? config.protocols.filter((p): p is string => typeof p === "string")
      : typeof config.protocols === "string"
        ? [config.protocols]
        : undefined;
    const headers = applyAuthHeaders(stringMap(config.headers), parseAuth(config));
    this.url = url;
    this.allowWrite = allowWriteFrom(config);
    this.inbox = [];
    this.waiters = [];

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, protocols?.length ? protocols : undefined, { headers });
      this.socket = ws;
      const onError = (err: Error) => {
        ws.off("open", onOpen);
        reject(err);
      };
      const onOpen = () => {
        ws.off("error", onError);
        resolve();
      };
      ws.once("open", onOpen);
      ws.once("error", onError);
      ws.on("message", (data, isBinary) => {
        const item: InboxItem = {
          binary: Boolean(isBinary),
          data: Buffer.isBuffer(data)
            ? isBinary
              ? data.toString("base64")
              : data.toString("utf8")
            : Array.isArray(data)
              ? Buffer.concat(data).toString(isBinary ? "base64" : "utf8")
              : String(data),
        };
        const waiter = this.waiters.shift();
        if (waiter) waiter(item);
        else this.inbox.push(item);
      });
    });
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    const ws = this.socket;
    this.socket = undefined;
    this.connected = false;
    this.waiters = [];
    this.inbox = [];
    if (!ws) return;
    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      ws.once("close", () => resolve());
      ws.close();
    });
  }

  async listTools(): Promise<McpToolSchema[]> {
    this.assertConnected();
    return [
      {
        name: "send",
        description: "Send a text (or base64 binary) frame (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: {
            payload: { description: "String, JSON object, or base64 when binary=true" },
            binary: { type: "boolean", default: false },
          },
          required: ["payload"],
          additionalProperties: false,
        },
      },
      {
        name: "receive_once",
        description: "Wait for a single inbound WebSocket frame (or return a buffered one)",
        inputSchema: {
          type: "object",
          properties: {
            timeoutMs: { type: "integer", default: 5000 },
          },
          additionalProperties: false,
        },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const ws = this.socket!;
    if (toolName === "send") {
      assertCanWrite("websocket", this.allowWrite);
      if (ws.readyState !== WebSocket.OPEN) throw new Error("WebSocket is not open");
      const binary = Boolean(args.binary);
      let payload: string | Buffer;
      if (binary) {
        if (typeof args.payload !== "string") throw new Error("binary send requires payload as base64 string");
        payload = Buffer.from(args.payload, "base64");
      } else if (typeof args.payload === "string") {
        payload = args.payload;
      } else {
        payload = JSON.stringify(args.payload ?? "");
      }
      ws.send(payload);
      return { ok: true, bytes: Buffer.byteLength(payload) };
    }
    if (toolName === "receive_once") {
      const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : 5000;
      const buffered = this.inbox.shift();
      if (buffered) return buffered;
      return await new Promise<InboxItem>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = this.waiters.indexOf(onItem);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(new Error(`Timed out waiting for WebSocket message (${timeoutMs}ms)`));
        }, timeoutMs);
        const onItem = (item: InboxItem) => {
          clearTimeout(timer);
          resolve(item);
        };
        this.waiters.push(onItem);
      });
    }
    throw new Error(`Unknown WebSocket tool "${toolName}"`);
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected || !this.socket) return { ok: false, detail: "not connected" };
    const open = this.socket.readyState === WebSocket.OPEN;
    return {
      ok: open,
      detail: open ? `${this.url} allowWrite=${this.allowWrite}` : `readyState=${this.socket.readyState}`,
    };
  }

  private assertConnected(): void {
    if (!this.connected || !this.socket) throw new Error("WebSocket adapter is not connected");
  }
}

function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
