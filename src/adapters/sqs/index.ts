import { AdapterError } from "../../runtime/errors.js";
import { fetchSafe } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";
import { requiredString, stringField } from "../helpers.js";

export interface SqsMessage {
  messageId: string;
  body: string;
  receiptHandle?: string;
}

export interface SqsHandle {
  listQueues(): Promise<string[]>;
  send(queue: string, body: string): Promise<{ messageId: string; queue: string }>;
  receive(queue: string, max?: number): Promise<SqsMessage[]>;
  delete(queue: string, receiptHandle: string): Promise<{ deleted: boolean; queue: string }>;
  close(): Promise<void>;
}

export type SqsConnectFn = (config: Record<string, unknown>) => Promise<SqsHandle>;

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createMemorySqs(defaultQueue: string): SqsHandle {
  const visible = new Map<string, SqsMessage[]>();
  const inFlight = new Map<string, Map<string, { queue: string; msg: SqsMessage }>>();

  const ensure = (queue: string) => {
    if (!visible.has(queue)) visible.set(queue, []);
    if (!inFlight.has(queue)) inFlight.set(queue, new Map());
  };
  ensure(defaultQueue);

  return {
    async listQueues() {
      return [...visible.keys()].sort();
    },
    async send(queue, body) {
      ensure(queue);
      const messageId = newId("msg");
      visible.get(queue)!.push({ messageId, body });
      return { messageId, queue };
    },
    async receive(queue, max = 1) {
      ensure(queue);
      const take = Math.max(1, Math.min(max, 10));
      const bucket = visible.get(queue)!;
      const flight = inFlight.get(queue)!;
      const out: SqsMessage[] = [];
      for (let i = 0; i < take && bucket.length; i++) {
        const msg = bucket.shift()!;
        const receiptHandle = newId("rh");
        const inflight: SqsMessage = { ...msg, receiptHandle };
        flight.set(receiptHandle, { queue, msg: inflight });
        out.push(inflight);
      }
      return out;
    },
    async delete(queue, receiptHandle) {
      ensure(queue);
      const flight = inFlight.get(queue)!;
      const deleted = flight.delete(receiptHandle);
      if (!deleted) {
        throw new AdapterError("E_NOT_FOUND", `Unknown receipt handle on ${queue}`, { protocol: "sqs" });
      }
      return { deleted: true, queue };
    },
    async close() {
      visible.clear();
      inFlight.clear();
    },
  };
}

function join(endpoint: string, ...parts: string[]): string {
  const base = endpoint.replace(/\/+$/, "");
  const path = parts.map((p) => encodeURIComponent(p)).join("/");
  return path ? `${base}/${path}` : base;
}

/** Unsigned JSON HTTP mock (not AWS SigV4, not the SQS Query protocol). */
export function unsignedHttpSqs(endpoint: string, timeoutMs = 8000): SqsHandle {
  return {
    async listQueues() {
      const res = await fetchSafe(join(endpoint, "queues"), { method: "GET", timeoutMs });
      const text = await res.text();
      if (!res.ok) {
        throw new AdapterError("E_PROTOCOL", `SQS list HTTP ${res.status}: ${text.slice(0, 200)}`, { protocol: "sqs" });
      }
      const json = JSON.parse(text) as { queues?: string[]; QueueUrls?: string[] };
      if (Array.isArray(json.queues)) return json.queues;
      if (Array.isArray(json.QueueUrls)) {
        return json.QueueUrls.map((u) => u.split("/").filter(Boolean).pop() ?? u);
      }
      return [];
    },
    async send(queue, body) {
      const res = await fetchSafe(join(endpoint, "queues", queue, "messages"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body, MessageBody: body }),
        timeoutMs,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new AdapterError("E_PROTOCOL", `SQS send HTTP ${res.status}: ${text.slice(0, 200)}`, { protocol: "sqs" });
      }
      const json = JSON.parse(text) as { messageId?: string; MessageId?: string };
      return { messageId: json.messageId ?? json.MessageId ?? "unknown", queue };
    },
    async receive(queue, max = 1) {
      const url = new URL(join(endpoint, "queues", queue, "messages"));
      url.searchParams.set("max", String(max));
      const res = await fetchSafe(url.toString(), { method: "GET", timeoutMs });
      const text = await res.text();
      if (!res.ok) {
        throw new AdapterError("E_PROTOCOL", `SQS receive HTTP ${res.status}: ${text.slice(0, 200)}`, { protocol: "sqs" });
      }
      const json = JSON.parse(text) as {
        messages?: SqsMessage[];
        Messages?: Array<{ MessageId: string; Body: string; ReceiptHandle: string }>;
      };
      if (Array.isArray(json.messages)) return json.messages;
      return (json.Messages ?? []).map((m) => ({
        messageId: m.MessageId,
        body: m.Body,
        receiptHandle: m.ReceiptHandle,
      }));
    },
    async delete(queue, receiptHandle) {
      const url = new URL(join(endpoint, "queues", queue, "messages"));
      url.searchParams.set("ReceiptHandle", receiptHandle);
      const res = await fetchSafe(url.toString(), { method: "DELETE", timeoutMs });
      const text = await res.text();
      if (res.status === 404) {
        throw new AdapterError("E_NOT_FOUND", `Unknown receipt handle on ${queue}`, { protocol: "sqs" });
      }
      if (!res.ok) {
        throw new AdapterError("E_PROTOCOL", `SQS delete HTTP ${res.status}: ${text.slice(0, 200)}`, { protocol: "sqs" });
      }
      return { deleted: true, queue };
    },
    async close() {
      /* http client is stateless */
    },
  };
}

async function defaultConnect(config: Record<string, unknown>): Promise<SqsHandle> {
  const queue = stringField(config, "queue") ?? stringField(config, "queueUrl") ?? stringField(config, "queueName");
  if (!queue) throw new AdapterError("E_INVALID_CONFIG", "SQS adapter requires config.queue");
  const endpoint = stringField(config, "endpoint") ?? stringField(config, "url");
  const simulator = config.simulator !== false && (!endpoint || endpoint === "memory://" || endpoint.startsWith("memory:"));
  if (simulator) return createMemorySqs(queue);
  if ((config.unsigned === true || config.localstack === true) && endpoint) {
    const timeoutMs = typeof config.timeoutMs === "number" && config.timeoutMs > 0 ? config.timeoutMs : 8000;
    return unsignedHttpSqs(endpoint, timeoutMs);
  }
  throw new AdapterError(
    "E_UNSUPPORTED",
    "SQS live path is unsigned JSON HTTP (config.unsigned=true) or an injected connectFn. No AWS SigV4 in this adapter.",
    { protocol: "sqs" },
  );
}

/**
 * SQS-like queue: in-memory (CI) or unsigned JSON HTTP mock.
 * send/delete require allowWrite=true. Not AWS SigV4 / not Pulsar.
 */
export class SqsAdapter implements ProtocolAdapter {
  readonly protocol = "sqs";
  private handle: SqsHandle | undefined;
  private connected = false;
  private queue = "";
  private allowWrite = false;
  private mode: "memory" | "unsigned-http" | "injected" = "memory";

  constructor(
    readonly id: string,
    private readonly connectFn: SqsConnectFn = defaultConnect,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    const queue = stringField(config, "queue") ?? stringField(config, "queueUrl") ?? stringField(config, "queueName");
    if (!queue) throw new AdapterError("E_INVALID_CONFIG", "SQS adapter requires config.queue");
    this.queue = queue;
    this.allowWrite = allowWriteFrom(config);
    const endpoint = stringField(config, "endpoint") ?? stringField(config, "url");
    this.mode =
      this.connectFn !== defaultConnect
        ? "injected"
        : (config.unsigned === true || config.localstack === true) && endpoint && !endpoint.startsWith("memory:")
          ? "unsigned-http"
          : "memory";
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
        description: "List queue names in the mock",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "send",
        description: "Send a message (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: {
            queue: { type: "string" },
            body: {},
          },
          required: ["body"],
          additionalProperties: false,
        },
      },
      {
        name: "receive",
        description: "Receive up to max messages (visibility: held until delete)",
        inputSchema: {
          type: "object",
          properties: {
            queue: { type: "string" },
            max: { type: "integer" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "delete",
        description: "Delete a received message by receipt handle (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: {
            queue: { type: "string" },
            receiptHandle: { type: "string" },
          },
          required: ["receiptHandle"],
          additionalProperties: false,
        },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const handle = this.handle!;
    const queue = typeof args.queue === "string" && args.queue.trim() ? args.queue.trim() : this.queue;
    if (toolName === "list_queues") {
      return { queues: await handle.listQueues() };
    }
    if (toolName === "send") {
      assertCanWrite("sqs", this.allowWrite);
      const body = typeof args.body === "string" ? args.body : JSON.stringify(args.body ?? "");
      return handle.send(queue, body);
    }
    if (toolName === "receive") {
      const max = typeof args.max === "number" ? args.max : 1;
      const messages = await handle.receive(queue, max);
      return { queue, messages };
    }
    if (toolName === "delete") {
      assertCanWrite("sqs", this.allowWrite);
      return handle.delete(queue, requiredString(args, "receiptHandle"));
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown SQS tool "${toolName}"`, { protocol: "sqs" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return {
      ok: true,
      detail: `queue=${this.queue} mode=${this.mode} allowWrite=${this.allowWrite} (unsigned JSON HTTP; no SigV4)`,
    };
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_NOT_CONNECTED", "SQS adapter is not connected", { protocol: "sqs" });
    }
  }
}
