import { connect, StringCodec, type NatsConnection } from "nats";
import { AdapterError } from "../../runtime/errors.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { payloadToString, requiredString, stringArray, stringField, timeoutMs } from "../helpers.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";

export interface NatsHandle {
  publish(subject: string, payload: string): Promise<void>;
  request(subject: string, payload: string, timeoutMs: number): Promise<string>;
  subscribeOnce(
    subject: string,
    timeoutMs: number,
    queue?: string,
  ): Promise<{ subject: string; data: string; queue?: string }>;
  flush(): Promise<void>;
  jsPublish?(
    subject: string,
    payload: string,
  ): Promise<{ stream: string; seq: number; duplicate?: boolean }>;
  jsSubscribeOnce?(
    subject: string,
    timeoutMs: number,
  ): Promise<{ subject: string; data: string; stream: string; seq: number; consumer?: string }>;
  jsConsumerAdd?(
    name: string,
    filter: string,
    ackPolicy?: "explicit" | "none",
  ): Promise<{ name: string; filter: string; ackPolicy: string }>;
  jsFetch?(
    consumer: string,
    timeoutMs: number,
  ): Promise<{ subject: string; data: string; stream: string; seq: number; consumer: string }>;
  jsAck?(consumer: string, seq: number): Promise<{ ok: true; seq: number }>;
  jsNack?(consumer: string, seq: number): Promise<{ ok: true; seq: number; requeued: true }>;
  jsInfo?(): Promise<unknown>;
  close(): Promise<void>;
}

export type NatsConnectFn = (config: Record<string, unknown>) => Promise<NatsHandle>;

function servers(config: Record<string, unknown>): string[] {
  const fromArr = stringArray(config.servers);
  if (fromArr.length) return fromArr;
  const url = stringField(config, "url") ?? stringField(config, "server");
  return url ? [url] : [];
}

function subjectMatch(filter: string, subject: string): boolean {
  if (!filter || filter === ">" || filter === subject) return true;
  if (filter.endsWith(".>")) return subject === filter.slice(0, -2) || subject.startsWith(`${filter.slice(0, -2)}.`);
  if (filter.includes("*")) {
    const re = new RegExp(`^${filter.replace(/\./g, "\\.").replace(/\*/g, "[^.]+")}$`);
    return re.test(subject);
  }
  return false;
}

/** In-memory core NATS + JetStream consumer/ack/interest subset. */
export function createMemoryNats(streamName = "EVERYTHING2MCP"): NatsHandle {
  const inbox = new Map<string, string[]>();
  const waiters = new Map<string, Array<(msg: { subject: string; data: string; queue?: string }) => void>>();
  const responders = new Map<string, (payload: string) => string>([["echo", (p) => p]]);
  const stream: Array<{ subject: string; data: string; seq: number }> = [];
  type Consumer = {
    filter: string;
    ackPolicy: "explicit" | "none";
    cursor: number;
    pending: Map<number, { subject: string; data: string; seq: number }>;
    waiters: Array<(msg: { subject: string; data: string; seq: number }) => void>;
  };
  const consumers = new Map<string, Consumer>();
  let seq = 0;
  const ensure = (name: string, filter = ">"): Consumer => {
    const existing = consumers.get(name);
    if (existing) return existing;
    const c: Consumer = { filter, ackPolicy: "explicit", cursor: 0, pending: new Map(), waiters: [] };
    consumers.set(name, c);
    return c;
  };
  const deliver = (c: Consumer, rec: { subject: string; data: string; seq: number }) => {
    c.cursor = rec.seq;
    if (c.ackPolicy === "explicit") c.pending.set(rec.seq, rec);
    return rec;
  };
  const next = (name: string, ms: number) => {
    const c = ensure(name);
    const hit = stream.find((m) => m.seq > c.cursor && subjectMatch(c.filter, m.subject));
    if (hit) {
      return Promise.resolve({ ...deliver(c, hit), stream: streamName, consumer: name });
    }
    return new Promise<{ subject: string; data: string; stream: string; seq: number; consumer: string }>(
      (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new AdapterError("E_TIMEOUT", `Timed out waiting for JetStream on ${name}`, { protocol: "nats" })),
          ms,
        );
        c.waiters.push((msg) => {
          clearTimeout(timer);
          resolve({ ...deliver(c, msg), stream: streamName, consumer: name });
        });
      },
    );
  };
  return {
    async publish(subject, payload) {
      const waiter = waiters.get(subject)?.shift();
      if (waiter) waiter({ subject, data: payload });
      else {
        const q = inbox.get(subject) ?? [];
        q.push(payload);
        inbox.set(subject, q);
      }
    },
    async request(subject, payload) {
      const fn = responders.get(subject);
      if (!fn) throw new AdapterError("E_NOT_FOUND", `no responder for ${subject}`, { protocol: "nats" });
      return fn(payload);
    },
    subscribeOnce(subject, ms, queue) {
      const buffered = inbox.get(subject)?.shift();
      if (buffered) return Promise.resolve({ subject, data: buffered, queue });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for NATS message on ${subject}`)), ms);
        const list = waiters.get(subject) ?? [];
        list.push((msg) => {
          clearTimeout(timer);
          resolve({ ...msg, queue });
        });
        waiters.set(subject, list);
      });
    },
    async flush() {
      /* memory */
    },
    async jsPublish(subject, payload) {
      seq += 1;
      const rec = { subject, data: payload, seq };
      stream.push(rec);
      for (const c of consumers.values()) {
        if (!subjectMatch(c.filter, subject)) continue;
        const w = c.waiters.shift();
        if (w) w(rec);
      }
      return { stream: streamName, seq, duplicate: false };
    },
    async jsSubscribeOnce(subject, ms) {
      const name = `_once_${subject}`;
      const c = ensure(name, subject);
      c.filter = subject;
      const msg = await next(name, ms);
      c.pending.delete(msg.seq);
      return msg;
    },
    async jsConsumerAdd(name, filter, ackPolicy = "explicit") {
      const c = ensure(name, filter);
      c.filter = filter || ">";
      c.ackPolicy = ackPolicy;
      return { name, filter: c.filter, ackPolicy: c.ackPolicy };
    },
    jsFetch(consumer, ms) {
      return next(consumer, ms);
    },
    async jsAck(consumer, seqNo) {
      const c = consumers.get(consumer);
      if (!c || !c.pending.delete(seqNo)) {
        throw new AdapterError("E_NOT_FOUND", `no pending JetStream seq ${seqNo} on ${consumer}`, { protocol: "nats" });
      }
      return { ok: true as const, seq: seqNo };
    },
    async jsNack(consumer, seqNo) {
      const c = consumers.get(consumer);
      const rec = c?.pending.get(seqNo);
      if (!c || !rec) {
        throw new AdapterError("E_NOT_FOUND", `no pending JetStream seq ${seqNo} on ${consumer}`, { protocol: "nats" });
      }
      c.pending.delete(seqNo);
      c.cursor = Math.min(c.cursor, seqNo - 1);
      stream.sort((a, b) => a.seq - b.seq);
      return { ok: true as const, seq: seqNo, requeued: true as const };
    },
    async jsInfo() {
      return {
        jetstream: true,
        deferred: false,
        stream: streamName,
        messages: seq,
        consumers: [...consumers.entries()].map(([name, c]) => ({
          name,
          filter: c.filter,
          pending: c.pending.size,
          ackPolicy: c.ackPolicy,
        })),
      };
    },
    async close() {
      inbox.clear();
      waiters.clear();
      stream.length = 0;
      consumers.clear();
    },
  };
}

async function defaultConnect(config: Record<string, unknown>): Promise<NatsHandle> {
  if (config.simulator === true) {
    return createMemoryNats(stringField(config, "stream") ?? "EVERYTHING2MCP");
  }
  const list = servers(config);
  if (!list.length) throw new Error("NATS adapter requires config.servers or config.url");
  const nc: NatsConnection = await connect({ servers: list });
  const sc = StringCodec();
  const streamName = stringField(config, "stream") ?? "EVERYTHING2MCP";
  return {
    async publish(subject, payload) {
      nc.publish(subject, sc.encode(payload));
      await nc.flush();
    },
    async request(subject, payload, ms) {
      const msg = await nc.request(subject, sc.encode(payload), { timeout: ms });
      return sc.decode(msg.data);
    },
    subscribeOnce(subject, ms, queue) {
      return new Promise((resolve, reject) => {
        const sub = nc.subscribe(subject, { max: 1, ...(queue ? { queue } : {}) });
        const timer = setTimeout(() => {
          sub.unsubscribe();
          reject(new Error(`Timed out waiting for NATS message on ${subject}`));
        }, ms);
        void (async () => {
          for await (const msg of sub) {
            clearTimeout(timer);
            resolve({ subject: msg.subject, data: sc.decode(msg.data), queue });
            return;
          }
        })();
      });
    },
    async flush() {
      await nc.flush();
    },
    async jsPublish(subject, payload) {
      const js = nc.jetstream();
      const ack = await js.publish(subject, sc.encode(payload));
      return { stream: ack.stream, seq: ack.seq, duplicate: ack.duplicate };
    },
    async jsSubscribeOnce(subject, ms) {
      const js = nc.jetstream();
      const consumer = await js.consumers.get(streamName);
      const msg = await consumer.next({ expires: ms });
      if (!msg) throw new Error(`Timed out waiting for JetStream message on ${subject}`);
      const data = sc.decode(msg.data);
      msg.ack();
      return { subject: msg.subject, data, stream: streamName, seq: msg.seq };
    },
    async jsInfo() {
      try {
        const jsm = await nc.jetstreamManager();
        const info = await jsm.getAccountInfo();
        return { jetstream: true, deferred: false, account: info };
      } catch (err) {
        return {
          jetstream: false,
          deferred: false,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    },
    async close() {
      await nc.close();
    },
  };
}

export class NatsAdapter implements ProtocolAdapter {
  readonly protocol = "nats";
  private handle: NatsHandle | undefined;
  private subjects: string[] = [];
  private connected = false;
  private allowWrite = false;

  constructor(
    readonly id: string,
    private readonly connectFn: NatsConnectFn = defaultConnect,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    if (config.simulator !== true && !servers(config).length) {
      throw new Error("NATS adapter requires config.servers or config.url");
    }
    this.subjects = stringArray(config.subjects);
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
        description: "Publish to a NATS subject and flush (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: {
            subject: { type: "string" },
            payload: {},
          },
          required: ["subject", "payload"],
          additionalProperties: false,
        },
      },
      {
        name: "request",
        description: "NATS request/reply (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: {
            subject: { type: "string" },
            payload: {},
            timeoutMs: { type: "integer", default: 5000 },
          },
          required: ["subject", "payload"],
          additionalProperties: false,
        },
      },
      {
        name: "subscribe_once",
        description: "Wait for a single message (optional queue group)",
        inputSchema: {
          type: "object",
          properties: {
            subject: { type: "string" },
            timeoutMs: { type: "integer", default: 5000 },
            queue: { type: "string" },
          },
          required: ["subject"],
          additionalProperties: false,
        },
      },
      {
        name: "flush",
        description: "Flush outstanding core NATS publishes",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "list_subjects",
        description: "List subjects from config",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "js_publish",
        description: "JetStream publish (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: {
            subject: { type: "string" },
            payload: {},
          },
          required: ["subject", "payload"],
          additionalProperties: false,
        },
      },
      {
        name: "js_subscribe_once",
        description: "Wait for one JetStream message",
        inputSchema: {
          type: "object",
          properties: {
            subject: { type: "string" },
            timeoutMs: { type: "integer", default: 5000 },
          },
          required: ["subject"],
          additionalProperties: false,
        },
      },
      {
        name: "js_info",
        description: "JetStream account / availability",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "js_consumer_add",
        description: "Create a durable JetStream consumer (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            filter: { type: "string", description: "Interest subject; * and .> supported" },
            ackPolicy: { type: "string", default: "explicit" },
          },
          required: ["name"],
          additionalProperties: false,
        },
      },
      {
        name: "js_next",
        description: "Fetch one message from a consumer without acking",
        inputSchema: {
          type: "object",
          properties: {
            consumer: { type: "string" },
            timeoutMs: { type: "integer", default: 5000 },
          },
          required: ["consumer"],
          additionalProperties: false,
        },
      },
      {
        name: "js_ack",
        description: "Ack a pending JetStream seq (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: { consumer: { type: "string" }, seq: { type: "integer" } },
          required: ["consumer", "seq"],
          additionalProperties: false,
        },
      },
      {
        name: "js_nack",
        description: "Nack/requeue a pending JetStream seq (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: { consumer: { type: "string" }, seq: { type: "integer" } },
          required: ["consumer", "seq"],
          additionalProperties: false,
        },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const handle = this.handle!;
    if (toolName === "list_subjects") return { subjects: this.subjects };
    if (toolName === "flush") {
      await handle.flush();
      return { ok: true };
    }
    if (toolName === "js_info") {
      if (handle.jsInfo) return handle.jsInfo();
      return { jetstream: false, deferred: false, detail: "JetStream handle not available" };
    }
    if (toolName === "js_publish") {
      assertCanWrite("nats", this.allowWrite);
      if (!handle.jsPublish) {
        throw new AdapterError("E_UNSUPPORTED", "JetStream publish is not available on this connection", {
          protocol: "nats",
        });
      }
      const subject = requiredString(args, "subject");
      const payload = payloadToString(args.payload);
      const ack = await handle.jsPublish(subject, payload);
      return { ok: true, subject, ...ack };
    }
    if (toolName === "js_subscribe_once") {
      if (!handle.jsSubscribeOnce) {
        throw new AdapterError("E_UNSUPPORTED", "JetStream subscribe is not available on this connection", {
          protocol: "nats",
        });
      }
      return handle.jsSubscribeOnce(requiredString(args, "subject"), timeoutMs(args));
    }
    if (toolName === "js_consumer_add") {
      assertCanWrite("nats", this.allowWrite);
      if (!handle.jsConsumerAdd) {
        throw new AdapterError("E_UNSUPPORTED", "JetStream consumer add is not available", { protocol: "nats" });
      }
      const ackPolicy = args.ackPolicy === "none" ? "none" : "explicit";
      return handle.jsConsumerAdd(requiredString(args, "name"), typeof args.filter === "string" ? args.filter : ">", ackPolicy);
    }
    if (toolName === "js_next") {
      if (!handle.jsFetch) {
        throw new AdapterError("E_UNSUPPORTED", "JetStream fetch is not available", { protocol: "nats" });
      }
      return handle.jsFetch(requiredString(args, "consumer"), timeoutMs(args));
    }
    if (toolName === "js_ack") {
      assertCanWrite("nats", this.allowWrite);
      if (!handle.jsAck) throw new AdapterError("E_UNSUPPORTED", "JetStream ack is not available", { protocol: "nats" });
      const seq = typeof args.seq === "number" ? args.seq : Number(args.seq);
      if (!Number.isFinite(seq)) throw new AdapterError("E_INVALID_CONFIG", "js_ack requires seq", { protocol: "nats" });
      return handle.jsAck(requiredString(args, "consumer"), seq);
    }
    if (toolName === "js_nack") {
      assertCanWrite("nats", this.allowWrite);
      if (!handle.jsNack) throw new AdapterError("E_UNSUPPORTED", "JetStream nack is not available", { protocol: "nats" });
      const seq = typeof args.seq === "number" ? args.seq : Number(args.seq);
      if (!Number.isFinite(seq)) throw new AdapterError("E_INVALID_CONFIG", "js_nack requires seq", { protocol: "nats" });
      return handle.jsNack(requiredString(args, "consumer"), seq);
    }
    if (toolName === "publish") {
      assertCanWrite("nats", this.allowWrite);
      const subject = requiredString(args, "subject");
      const payload = payloadToString(args.payload);
      await handle.publish(subject, payload);
      return { ok: true, subject, bytes: Buffer.byteLength(payload) };
    }
    if (toolName === "request") {
      assertCanWrite("nats", this.allowWrite);
      const subject = requiredString(args, "subject");
      const payload = payloadToString(args.payload);
      const data = await handle.request(subject, payload, timeoutMs(args));
      return { subject, data };
    }
    if (toolName === "subscribe_once") {
      const queue = typeof args.queue === "string" ? args.queue : undefined;
      return handle.subscribeOnce(requiredString(args, "subject"), timeoutMs(args), queue);
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown NATS tool "${toolName}"`, { protocol: "nats" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return { ok: true, detail: `core NATS + JetStream allowWrite=${this.allowWrite}` };
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) throw new AdapterError("E_NOT_CONNECTED", "NATS adapter is not connected", { protocol: "nats" });
  }
}
