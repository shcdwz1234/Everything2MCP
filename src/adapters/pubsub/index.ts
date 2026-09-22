import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AdapterError } from "../../runtime/errors.js";
import { fetchSafe } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";
import { requiredString, stringField } from "../helpers.js";

export interface PubsubHandle {
  listTopics(): Promise<string[]>;
  pull(sub: string): Promise<Array<{ ackId: string; data: string }>>;
  publish(topic: string, data: string): Promise<{ messageIds: string[] }>;
  close(): Promise<void>;
}

export type PubsubConnectFn = (config: Record<string, unknown>) => Promise<PubsubHandle>;

export function createMemoryPubsub(): PubsubHandle {
  const topics = new Set(["projects/demo/topics/events"]);
  const messages: Array<{ ackId: string; data: string; topic: string }> = [
    { ackId: "ack-1", data: "hello", topic: "projects/demo/topics/events" },
  ];
  let seq = 1;
  return {
    async listTopics() {
      return [...topics].sort();
    },
    async pull() {
      return messages.map(({ ackId, data }) => ({ ackId, data }));
    },
    async publish(topic, data) {
      topics.add(topic);
      const id = `m-${seq++}`;
      messages.push({ ackId: `ack-${id}`, data, topic });
      return { messageIds: [id] };
    },
    async close() {
      messages.length = 0;
    },
  };
}

async function httpPubsub(base: string, project: string, timeoutMs: number): Promise<PubsubHandle> {
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
      throw new AdapterError("E_PROTOCOL", `pubsub ${method} ${path} ${res.status}: ${text.slice(0, 200)}`, {
        protocol: "pubsub",
      });
    }
    return text ? JSON.parse(text) : {};
  };
  return {
    async listTopics() {
      const json = (await request("GET", `/v1/projects/${encodeURIComponent(project)}/topics`)) as {
        topics?: Array<{ name: string }>;
      };
      return (json.topics ?? []).map((t) => t.name);
    },
    async pull(sub) {
      const json = (await request("POST", `/v1/${sub}:pull`, { maxMessages: 10 })) as {
        receivedMessages?: Array<{ ackId: string; message?: { data?: string } }>;
      };
      return (json.receivedMessages ?? []).map((m) => ({
        ackId: m.ackId,
        data: m.message?.data ? Buffer.from(m.message.data, "base64").toString("utf8") : "",
      }));
    },
    async publish(topic, data) {
      return (await request("POST", `/v1/${topic}:publish`, {
        messages: [{ data: Buffer.from(data).toString("base64") }],
      })) as { messageIds: string[] };
    },
    async close() {
      /* http */
    },
  };
}

export class PubsubAdapter implements ProtocolAdapter {
  readonly protocol = "pubsub";
  private handle: PubsubHandle | undefined;
  private allowWrite = false;
  private project = "demo";

  constructor(
    readonly id: string,
    private readonly connectFn: PubsubConnectFn = defaultConnect,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    this.allowWrite = allowWriteFrom(config);
    this.project = stringField(config, "project") ?? "demo";
    this.handle = await this.connectFn(config);
  }

  async disconnect(): Promise<void> {
    await this.handle?.close();
    this.handle = undefined;
  }

  async listTools(): Promise<McpToolSchema[]> {
    return [
      {
        name: "list_topics",
        description: "List Pub/Sub topics (emulator HTTP or simulator).",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
      },
      {
        name: "pull",
        description: "Pull messages (does not ack). Read path.",
        inputSchema: {
          type: "object",
          properties: { subscription: { type: "string" } },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: "publish",
        description: "Publish a message — requires allowWrite=true",
        inputSchema: {
          type: "object",
          properties: { topic: { type: "string" }, data: { type: "string" } },
          required: ["data"],
          additionalProperties: false,
        },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.handle) throw new AdapterError("E_NOT_CONNECTED", "pubsub not connected", { protocol: this.protocol });
    if (toolName === "list_topics") return { topics: await this.handle.listTopics() };
    if (toolName === "pull") {
      const sub =
        typeof args.subscription === "string" && args.subscription
          ? args.subscription
          : `projects/${this.project}/subscriptions/default`;
      return { messages: await this.handle.pull(sub) };
    }
    if (toolName === "publish") {
      assertCanWrite(this.protocol, this.allowWrite);
      const topic =
        typeof args.topic === "string" && args.topic ? args.topic : `projects/${this.project}/topics/events`;
      return this.handle.publish(topic, requiredString(args, "data"));
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown tool ${toolName}`, { protocol: this.protocol });
  }

  async health(): Promise<AdapterHealth> {
    return { ok: Boolean(this.handle), detail: `project=${this.project} allowWrite=${this.allowWrite}` };
  }
}

async function defaultConnect(config: Record<string, unknown>): Promise<PubsubHandle> {
  const url = stringField(config, "url") ?? stringField(config, "emulator");
  if (config.simulator === true || !url) return createMemoryPubsub();
  const timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 4000;
  return httpPubsub(url, stringField(config, "project") ?? "demo", timeoutMs);
}

export async function listenPubsubLoopback(mem: PubsubHandle = createMemoryPubsub()): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      res.setHeader("content-type", "application/json");
      try {
        if (req.method === "GET" && /\/v1\/projects\/[^/]+\/topics$/.test(path)) {
          const topics = await mem.listTopics();
          res.end(JSON.stringify({ topics: topics.map((name) => ({ name })) }));
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
