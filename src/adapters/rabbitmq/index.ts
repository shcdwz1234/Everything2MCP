import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AdapterError } from "../../runtime/errors.js";
import { fetchSafe } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";
import { requiredString, stringField } from "../helpers.js";

export interface RabbitQueue {
  name: string;
  vhost: string;
  messages: number;
}

export interface RabbitExchange {
  name: string;
  vhost: string;
  type: string;
}

export interface RabbitMessage {
  payload: string;
  routing_key: string;
}

export interface RabbitmqHandle {
  listQueues(vhost?: string): Promise<RabbitQueue[]>;
  listExchanges(vhost?: string): Promise<RabbitExchange[]>;
  publish(vhost: string, exchange: string, routingKey: string, payload: string): Promise<{ routed: boolean }>;
  get(vhost: string, queue: string): Promise<RabbitMessage | undefined>;
  close(): Promise<void>;
}

export type RabbitmqConnectFn = (config: Record<string, unknown>) => Promise<RabbitmqHandle>;

export function createMemoryRabbitmq(): RabbitmqHandle {
  const queues = new Map<string, RabbitMessage[]>();
  const exchanges: RabbitExchange[] = [
    { name: "", vhost: "/", type: "direct" },
    { name: "amq.default", vhost: "/", type: "direct" },
  ];
  const key = (vhost: string, name: string) => `${vhost}\0${name}`;
  return {
    async listQueues(vhost) {
      return [...queues.entries()]
        .map(([k, msgs]) => {
          const [vh, name] = k.split("\0");
          return { name: name ?? k, vhost: vh ?? "/", messages: msgs.length };
        })
        .filter((q) => !vhost || q.vhost === vhost)
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    async listExchanges(vhost) {
      return exchanges.filter((e) => !vhost || e.vhost === vhost);
    },
    async publish(vhost, _exchange, routingKey, payload) {
      const k = key(vhost, routingKey);
      const list = queues.get(k) ?? [];
      list.push({ payload, routing_key: routingKey });
      queues.set(k, list);
      return { routed: true };
    },
    async get(vhost, queue) {
      const list = queues.get(key(vhost, queue)) ?? [];
      return list.shift();
    },
    async close() {
      queues.clear();
    },
  };
}

function encVhost(vhost: string): string {
  return encodeURIComponent(vhost || "/");
}

async function httpRabbitmq(base: string, timeoutMs: number): Promise<RabbitmqHandle> {
  const root = base.replace(/\/+$/, "");
  const request = async (method: string, path: string, body?: unknown) => {
    const res = await fetchSafe(`${root}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs,
    });
    const text = await res.text();
    if (res.status >= 400) {
      throw new AdapterError("E_PROTOCOL", `rabbitmq ${method} ${path} ${res.status}: ${text.slice(0, 200)}`, {
        protocol: "rabbitmq",
      });
    }
    return text ? JSON.parse(text) : {};
  };
  return {
    async listQueues() {
      const json = await request("GET", "/api/queues");
      const rows = Array.isArray(json) ? json : [];
      return rows
        .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object")
        .map((q) => ({
          name: String(q.name ?? ""),
          vhost: String(q.vhost ?? "/"),
          messages: Number(q.messages ?? 0),
        }));
    },
    async listExchanges() {
      const json = await request("GET", "/api/exchanges");
      const rows = Array.isArray(json) ? json : [];
      return rows
        .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object")
        .map((e) => ({
          name: String(e.name ?? ""),
          vhost: String(e.vhost ?? "/"),
          type: String(e.type ?? "direct"),
        }));
    },
    async publish(vhost, exchange, routingKey, payload) {
      const json = (await request("POST", `/api/exchanges/${encVhost(vhost)}/${encodeURIComponent(exchange || "amq.default")}/publish`, {
        properties: {},
        routing_key: routingKey,
        payload,
        payload_encoding: "string",
      })) as { routed?: boolean };
      return { routed: json.routed !== false };
    },
    async get(vhost, queue) {
      const json = await request("POST", `/api/queues/${encVhost(vhost)}/${encodeURIComponent(queue)}/get`, {
        count: 1,
        ackmode: "ack_requeue_false",
        encoding: "auto",
      });
      const rows = Array.isArray(json) ? json : [];
      const first = rows[0] as { payload?: string; routing_key?: string } | undefined;
      if (!first) return undefined;
      return { payload: String(first.payload ?? ""), routing_key: String(first.routing_key ?? queue) };
    },
    async close() {
      /* stateless */
    },
  };
}

async function defaultConnect(config: Record<string, unknown>): Promise<RabbitmqHandle> {
  const url = stringField(config, "url") ?? stringField(config, "managementUrl");
  if (config.simulator === true || !url) return createMemoryRabbitmq();
  const timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 4000;
  return httpRabbitmq(url, timeoutMs);
}

export async function listenRabbitmqLoopback(mem: RabbitmqHandle = createMemoryRabbitmq()): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const path = (req.url ?? "/").split("?")[0] ?? "/";
        res.setHeader("content-type", "application/json");
        try {
          if (req.method === "GET" && (path === "/api/overview" || path === "/")) {
            res.end(JSON.stringify({ rabbitmq_version: "3.13.0-e2mcp", management_version: "3.13.0-e2mcp" }));
            return;
          }
          if (req.method === "GET" && path === "/api/queues") {
            res.end(JSON.stringify(await mem.listQueues()));
            return;
          }
          if (req.method === "GET" && path === "/api/exchanges") {
            res.end(JSON.stringify(await mem.listExchanges()));
            return;
          }
          const pub = /^\/api\/exchanges\/([^/]+)\/([^/]+)\/publish$/.exec(path);
          if (req.method === "POST" && pub) {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
              routing_key?: string;
              payload?: string;
            };
            const routed = await mem.publish(
              decodeURIComponent(pub[1]!),
              decodeURIComponent(pub[2]!),
              body.routing_key ?? "",
              body.payload ?? "",
            );
            res.end(JSON.stringify(routed));
            return;
          }
          const get = /^\/api\/queues\/([^/]+)\/([^/]+)\/get$/.exec(path);
          if (req.method === "POST" && get) {
            const msg = await mem.get(decodeURIComponent(get[1]!), decodeURIComponent(get[2]!));
            res.end(JSON.stringify(msg ? [msg] : []));
            return;
          }
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "not_found" }));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as { port: number }).port, close: () => new Promise((r) => server.close(() => r())) };
}

/**
 * RabbitMQ management HTTP API (15672). Not AMQP 0-9-1.
 * Wire AMQP stays on protocol id `amqp`.
 */
export class RabbitmqAdapter implements ProtocolAdapter {
  readonly protocol = "rabbitmq";
  private handle: RabbitmqHandle | undefined;
  private connected = false;
  private allowWrite = false;
  private vhost = "/";

  constructor(
    readonly id: string,
    private readonly connectFn: RabbitmqConnectFn = defaultConnect,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    this.allowWrite = allowWriteFrom(config);
    this.vhost = stringField(config, "vhost") ?? "/";
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
        name: "list_queues",
        description: "GET /api/queues (management HTTP, not AMQP)",
        inputSchema: { type: "object", properties: { vhost: { type: "string" } }, additionalProperties: false },
      },
      {
        name: "list_exchanges",
        description: "GET /api/exchanges (management HTTP, not AMQP)",
        inputSchema: { type: "object", properties: { vhost: { type: "string" } }, additionalProperties: false },
      },
      {
        name: "publish",
        description: "POST /api/exchanges/{vhost}/{exchange}/publish (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: {
            exchange: { type: "string" },
            routingKey: { type: "string" },
            payload: { type: "string" },
            vhost: { type: "string" },
          },
          required: ["routingKey", "payload"],
          additionalProperties: false,
        },
      },
      {
        name: "get",
        description: "POST /api/queues/{vhost}/{queue}/get (requires allowWrite=true; acks on get)",
        inputSchema: {
          type: "object",
          properties: { queue: { type: "string" }, vhost: { type: "string" } },
          required: ["queue"],
          additionalProperties: false,
        },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const h = this.handle!;
    const vhost = typeof args.vhost === "string" && args.vhost ? args.vhost : this.vhost;
    if (toolName === "list_queues") return { queues: await h.listQueues(vhost) };
    if (toolName === "list_exchanges") return { exchanges: await h.listExchanges(vhost) };
    if (toolName === "publish") {
      assertCanWrite("rabbitmq", this.allowWrite);
      return h.publish(vhost, typeof args.exchange === "string" ? args.exchange : "amq.default", requiredString(args, "routingKey"), requiredString(args, "payload"));
    }
    if (toolName === "get") {
      assertCanWrite("rabbitmq", this.allowWrite);
      const msg = await h.get(vhost, requiredString(args, "queue"));
      return msg ?? { empty: true };
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown rabbitmq tool "${toolName}"`, { protocol: "rabbitmq" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return {
      ok: true,
      detail: `rabbitmq management HTTP allowWrite=${this.allowWrite} (not AMQP 0-9-1; use protocol=amqp for the wire)`,
    };
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_NOT_CONNECTED", "rabbitmq adapter is not connected", { protocol: "rabbitmq" });
    }
  }
}
