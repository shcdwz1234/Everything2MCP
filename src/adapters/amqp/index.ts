import amqplib from "amqplib";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { payloadToString, requiredString, stringArray, stringField, timeoutMs } from "../helpers.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";

export interface AmqpHandle {
  publish(exchange: string, routingKey: string, content: Buffer): Promise<void>;
  consumeOnce(queue: string, timeoutMs: number): Promise<{ content: string; routingKey: string; deliveryTag?: number }>;
  get?(queue: string): Promise<{ content: string; routingKey: string; deliveryTag: number } | undefined>;
  ack?(deliveryTag: number): Promise<{ ok: true; deliveryTag: number }>;
  nack?(deliveryTag: number, requeue?: boolean): Promise<{ ok: true; deliveryTag: number; requeued: boolean }>;
  rpc(
    queue: string,
    content: Buffer,
    timeoutMs: number,
  ): Promise<{ content: string; routingKey: string; correlationId: string }>;
  close(): Promise<void>;
}

export type AmqpConnectFn = (config: Record<string, unknown>) => Promise<AmqpHandle>;

/** In-memory AMQP 0-9-1 subset: default exchange routing, get/ack/nack. */
export function createMemoryAmqp(): AmqpHandle {
  const queues = new Map<string, Array<{ content: string; routingKey: string; deliveryTag: number }>>();
  const waiters = new Map<string, Array<(msg: { content: string; routingKey: string; deliveryTag: number }) => void>>();
  const unacked = new Map<number, { queue: string; msg: { content: string; routingKey: string; deliveryTag: number } }>();
  let tag = 1;
  const push = (queue: string, msg: { content: string; routingKey: string; deliveryTag: number }) => {
    const waiter = waiters.get(queue)?.shift();
    if (waiter) waiter(msg);
    else {
      const q = queues.get(queue) ?? [];
      q.push(msg);
      queues.set(queue, q);
    }
  };
  return {
    async publish(_exchange, routingKey, content) {
      push(routingKey, { content: content.toString("utf8"), routingKey, deliveryTag: tag++ });
    },
    consumeOnce(queue, ms) {
      const buffered = queues.get(queue)?.shift();
      if (buffered) return Promise.resolve(buffered);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for AMQP message on ${queue}`)), ms);
        const list = waiters.get(queue) ?? [];
        list.push((msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
        waiters.set(queue, list);
      });
    },
    async get(queue) {
      const msg = queues.get(queue)?.shift();
      if (!msg) return undefined;
      unacked.set(msg.deliveryTag, { queue, msg });
      return msg;
    },
    async ack(deliveryTag) {
      if (!unacked.delete(deliveryTag)) {
        throw new Error(`AMQP ack: unknown deliveryTag ${deliveryTag}`);
      }
      return { ok: true as const, deliveryTag };
    },
    async nack(deliveryTag, requeue = true) {
      const held = unacked.get(deliveryTag);
      if (!held) throw new Error(`AMQP nack: unknown deliveryTag ${deliveryTag}`);
      unacked.delete(deliveryTag);
      if (requeue) {
        const q = queues.get(held.queue) ?? [];
        q.unshift(held.msg);
        queues.set(held.queue, q);
      }
      return { ok: true as const, deliveryTag, requeued: Boolean(requeue) };
    },
    async rpc(queue, content) {
      return {
        content: `reply:${content.toString("utf8")}`,
        routingKey: queue,
        correlationId: "cid-memory",
      };
    },
    async close() {
      queues.clear();
      waiters.clear();
      unacked.clear();
    },
  };
}

async function defaultConnect(config: Record<string, unknown>): Promise<AmqpHandle> {
  if (config.simulator === true) return createMemoryAmqp();
  const url = stringField(config, "url");
  if (!url) throw new Error("AMQP adapter requires config.url");
  const conn = await amqplib.connect(url);
  const ch = await conn.createChannel();
  const queue = stringField(config, "queue");
  if (queue) await ch.assertQueue(queue, { durable: Boolean(config.durable) });
  return {
    async publish(exchange, routingKey, content) {
      if (!exchange && routingKey) {
        ch.sendToQueue(routingKey, content);
        return;
      }
      ch.publish(exchange, routingKey, content);
    },
    consumeOnce(queueName, ms) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for AMQP message on ${queueName}`)), ms);
        void (async () => {
          await ch.assertQueue(queueName, { durable: Boolean(config.durable) });
          const { consumerTag } = await ch.consume(queueName, (msg) => {
            if (!msg) return;
            clearTimeout(timer);
            ch.ack(msg);
            void ch.cancel(consumerTag);
            resolve({ content: msg.content.toString("utf8"), routingKey: msg.fields.routingKey });
          });
        })().catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
    },
    rpc(queueName, content, ms) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for AMQP RPC reply on ${queueName}`)), ms);
        const correlationId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        void (async () => {
          await ch.assertQueue(queueName, { durable: Boolean(config.durable) });
          const reply = await ch.assertQueue("", { exclusive: true, autoDelete: true });
          const { consumerTag } = await ch.consume(
            reply.queue,
            (msg) => {
              if (!msg) return;
              if (msg.properties.correlationId !== correlationId) return;
              clearTimeout(timer);
              ch.ack(msg);
              void ch.cancel(consumerTag);
              resolve({
                content: msg.content.toString("utf8"),
                routingKey: msg.fields.routingKey,
                correlationId,
              });
            },
            { noAck: false },
          );
          ch.sendToQueue(queueName, content, { correlationId, replyTo: reply.queue });
        })().catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
    },
    async close() {
      await ch.close();
      await conn.close();
    },
  };
}

export class AmqpAdapter implements ProtocolAdapter {
  readonly protocol = "amqp";
  private handle: AmqpHandle | undefined;
  private queue = "";
  private exchange = "";
  private queues: string[] = [];
  private connected = false;
  private allowWrite = false;

  constructor(
    readonly id: string,
    private readonly connectFn: AmqpConnectFn = defaultConnect,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    const url = stringField(config, "url");
    if (config.simulator !== true && !url) throw new Error("AMQP adapter requires config.url (e.g. amqp://127.0.0.1)");
    this.queue = stringField(config, "queue") ?? "";
    this.exchange = stringField(config, "exchange") ?? "";
    this.queues = stringArray(config.queues);
    if (this.queue && !this.queues.includes(this.queue)) this.queues.push(this.queue);
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
        name: "publish",
        description: "Publish a message to an AMQP exchange/routing key (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: {
            payload: { description: "String or JSON payload" },
            routingKey: { type: "string" },
            exchange: { type: "string" },
            queue: { type: "string", description: "Used as routing key when exchange is empty" },
          },
          required: ["payload"],
          additionalProperties: false,
        },
      },
      {
        name: "consume_once",
        description: "Wait for a single message from a queue",
        inputSchema: {
          type: "object",
          properties: {
            queue: { type: "string" },
            timeoutMs: { type: "integer", default: 5000 },
          },
          additionalProperties: false,
        },
      },
      {
        name: "list_queues",
        description: "List queues configured on this registration",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "get",
        description: "Basic.Get one message without auto-ack (deliveryTag for ack/nack)",
        inputSchema: {
          type: "object",
          properties: { queue: { type: "string" } },
          additionalProperties: false,
        },
      },
      {
        name: "ack",
        description: "Ack a deliveryTag from get (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: { deliveryTag: { type: "integer" } },
          required: ["deliveryTag"],
          additionalProperties: false,
        },
      },
      {
        name: "nack",
        description: "Nack a deliveryTag; requeue default true (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: { deliveryTag: { type: "integer" }, requeue: { type: "boolean", default: true } },
          required: ["deliveryTag"],
          additionalProperties: false,
        },
      },
      {
        name: "rpc",
        description: "AMQP request/reply (requires allowWrite=true): correlationId+replyTo",
        inputSchema: {
          type: "object",
          properties: {
            payload: { description: "String or JSON payload" },
            queue: { type: "string" },
            timeoutMs: { type: "integer", default: 5000 },
          },
          required: ["payload"],
          additionalProperties: false,
        },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const handle = this.handle!;
    if (toolName === "list_queues") return { queues: this.queues };
    if (toolName === "publish") {
      assertCanWrite("amqp", this.allowWrite);
      const routingKey =
    (typeof args.routingKey === "string" && args.routingKey) ||
    (typeof args.queue === "string" && args.queue) ||
    this.queue;
      if (!routingKey) throw new Error("Missing routingKey/queue");
      const exchange = typeof args.exchange === "string" ? args.exchange : this.exchange;
      const payload = payloadToString(args.payload);
      await handle.publish(exchange, routingKey, Buffer.from(payload));
      return { ok: true, exchange, routingKey, bytes: Buffer.byteLength(payload) };
    }
    if (toolName === "consume_once") {
      const queue = (typeof args.queue === "string" && args.queue) || this.queue;
      if (!queue) throw new Error("Missing queue");
      return handle.consumeOnce(queue, timeoutMs(args));
    }
    if (toolName === "get") {
      const queue = (typeof args.queue === "string" && args.queue) || this.queue;
      if (!queue) throw new Error("Missing queue");
      if (!handle.get) throw new Error("AMQP get is not available on this connection");
      const msg = await handle.get(queue);
      return msg ?? { empty: true };
    }
    if (toolName === "ack") {
      assertCanWrite("amqp", this.allowWrite);
      if (!handle.ack) throw new Error("AMQP ack is not available on this connection");
      const tag = typeof args.deliveryTag === "number" ? args.deliveryTag : Number(args.deliveryTag);
      if (!Number.isFinite(tag)) throw new Error("ack requires deliveryTag");
      return handle.ack(tag);
    }
    if (toolName === "nack") {
      assertCanWrite("amqp", this.allowWrite);
      if (!handle.nack) throw new Error("AMQP nack is not available on this connection");
      const tag = typeof args.deliveryTag === "number" ? args.deliveryTag : Number(args.deliveryTag);
      if (!Number.isFinite(tag)) throw new Error("nack requires deliveryTag");
      return handle.nack(tag, args.requeue !== false);
    }
    if (toolName === "rpc") {
      assertCanWrite("amqp", this.allowWrite);
      const queue = (typeof args.queue === "string" && args.queue) || this.queue;
      if (!queue) throw new Error("Missing queue");
      const payload = payloadToString(args.payload);
      return handle.rpc(queue, Buffer.from(payload), timeoutMs(args));
    }
    throw new Error(`Unknown AMQP tool "${toolName}"`);
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return { ok: true, detail: `queue=${this.queue || "(none)"} allowWrite=${this.allowWrite}` };
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) throw new Error("AMQP adapter is not connected");
  }
}
