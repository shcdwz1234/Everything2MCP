import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AdapterError } from "../../runtime/errors.js";
import { fetchSafe } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";
import { stringField } from "../helpers.js";

export interface AmAlert {
  fingerprint: string;
  status: { state: string };
  labels: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface AlertmanagerHandle {
  status(): Promise<Record<string, unknown>>;
  alerts(): Promise<AmAlert[]>;
  silences(): Promise<Array<{ id: string; createdBy: string }>>;
  createSilence(comment: string): Promise<{ id: string }>;
  close(): Promise<void>;
}

export type AlertmanagerConnectFn = (config: Record<string, unknown>) => Promise<AlertmanagerHandle>;

export function createMemoryAlertmanager(): AlertmanagerHandle {
  const alerts: AmAlert[] = [
    {
      fingerprint: "fp1",
      status: { state: "active" },
      labels: { alertname: "HighLatency", severity: "warning" },
      annotations: { summary: "p99 > 1s" },
    },
  ];
  const silences: Array<{ id: string; createdBy: string; comment?: string }> = [];
  return {
    async status() {
      return { cluster: { status: "ready" }, versionInfo: { version: "0.27-e2mcp" } };
    },
    async alerts() {
      return alerts;
    },
    async silences() {
      return silences;
    },
    async createSilence(comment) {
      const id = `sil-${silences.length + 1}`;
      silences.push({ id, createdBy: "e2mcp", comment });
      return { id };
    },
    async close() {
      silences.length = 0;
    },
  };
}

async function httpAlertmanager(base: string, timeoutMs: number): Promise<AlertmanagerHandle> {
  const root = base.replace(/\/+$/, "");
  const request = async (method: string, path: string, body?: unknown) => {
    const res = await fetchSafe(`${root}${path}`, {
      method,
      headers: body === undefined ? { accept: "application/json" } : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs,
    });
    const text = await res.text();
    if (res.status >= 400) {
      throw new AdapterError("E_PROTOCOL", `alertmanager ${method} ${path} ${res.status}: ${text.slice(0, 200)}`, {
        protocol: "alertmanager",
      });
    }
    return text ? JSON.parse(text) : {};
  };
  return {
    async status() {
      return (await request("GET", "/api/v2/status")) as Record<string, unknown>;
    },
    async alerts() {
      const json = await request("GET", "/api/v2/alerts");
      return Array.isArray(json) ? (json as AmAlert[]) : [];
    },
    async silences() {
      const json = await request("GET", "/api/v2/silences");
      return Array.isArray(json) ? (json as Array<{ id: string; createdBy: string }>) : [];
    },
    async createSilence(comment) {
      return (await request("POST", "/api/v2/silences", {
        matchers: [{ name: "alertname", value: "e2mcp", isRegex: false }],
        startsAt: new Date().toISOString(),
        endsAt: new Date(Date.now() + 3600_000).toISOString(),
        createdBy: "e2mcp",
        comment,
      })) as { id: string };
    },
    async close() {
      /* http */
    },
  };
}

export class AlertmanagerAdapter implements ProtocolAdapter {
  readonly protocol = "alertmanager";
  private handle: AlertmanagerHandle | undefined;
  private allowWrite = false;

  constructor(
    readonly id: string,
    private readonly connectFn: AlertmanagerConnectFn = defaultConnect,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    this.allowWrite = allowWriteFrom(config);
    this.handle = await this.connectFn(config);
  }

  async disconnect(): Promise<void> {
    await this.handle?.close();
    this.handle = undefined;
  }

  async listTools(): Promise<McpToolSchema[]> {
    return [
      {
        name: "status",
        description: "GET /api/v2/status",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
      },
      {
        name: "alerts",
        description: "GET /api/v2/alerts (read-only).",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
      },
      {
        name: "silences",
        description: "GET /api/v2/silences",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
      },
      {
        name: "create_silence",
        description: "POST /api/v2/silences — requires allowWrite=true",
        inputSchema: {
          type: "object",
          properties: { comment: { type: "string" } },
          additionalProperties: false,
        },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.handle) throw new AdapterError("E_NOT_CONNECTED", "alertmanager not connected", { protocol: this.protocol });
    if (toolName === "status") return this.handle.status();
    if (toolName === "alerts") return { alerts: await this.handle.alerts() };
    if (toolName === "silences") return { silences: await this.handle.silences() };
    if (toolName === "create_silence") {
      assertCanWrite(this.protocol, this.allowWrite);
      const comment = typeof args.comment === "string" ? args.comment : "e2mcp";
      return this.handle.createSilence(comment);
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown tool ${toolName}`, { protocol: this.protocol });
  }

  async health(): Promise<AdapterHealth> {
    return { ok: Boolean(this.handle), detail: this.allowWrite ? "allowWrite" : "readonly" };
  }
}

async function defaultConnect(config: Record<string, unknown>): Promise<AlertmanagerHandle> {
  const url = stringField(config, "url");
  if (config.simulator === true || !url) return createMemoryAlertmanager();
  const timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 4000;
  return httpAlertmanager(url, timeoutMs);
}

export async function listenAlertmanagerLoopback(mem: AlertmanagerHandle = createMemoryAlertmanager()): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      res.setHeader("content-type", "application/json");
      try {
        if (path === "/api/v2/status") {
          res.end(JSON.stringify(await mem.status()));
          return;
        }
        if (path === "/api/v2/alerts") {
          res.end(JSON.stringify(await mem.alerts()));
          return;
        }
        if (path === "/api/v2/silences" && req.method === "GET") {
          res.end(JSON.stringify(await mem.silences()));
          return;
        }
        res.statusCode = 404;
        res.end("{}");
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    })();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as { port: number }).port, close: () => new Promise((r) => server.close(() => r())) };
}
