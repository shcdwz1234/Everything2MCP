import { createClient } from "redis";
import { AdapterError } from "../../runtime/errors.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { payloadToString, requiredString, stringField, timeoutMs } from "../helpers.js";
import { allowWriteFrom } from "../sql/common.js";

export interface RedisHandle {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  publish(channel: string, message: string): Promise<number>;
  subscribeOnce(channel: string, timeoutMs: number): Promise<{ channel: string; message: string }>;
  hget(key: string, field: string): Promise<string | null>;
  hset(key: string, field: string, value: string): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  lpush(key: string, value: string): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  xadd(key: string, fields: Record<string, string>): Promise<string>;
  xread(key: string, count: number): Promise<Array<{ id: string; fields: Record<string, string> }>>;
  xgroupCreate?(key: string, group: string, start: string): Promise<{ ok: true; already?: boolean }>;
  xreadGroup?(
    group: string,
    consumer: string,
    key: string,
    count: number,
  ): Promise<Array<{ id: string; fields: Record<string, string> }>>;
  xack?(key: string, group: string, id: string): Promise<{ acked: number }>;
  close(): Promise<void>;
}

export type RedisConnectFn = (config: Record<string, unknown>) => Promise<RedisHandle>;

function redisUrl(config: Record<string, unknown>): string {
  return stringField(config, "url") ?? stringField(config, "endpoint") ?? "";
}

async function defaultConnect(config: Record<string, unknown>): Promise<RedisHandle> {
  const url = redisUrl(config) || "redis://127.0.0.1:6379";
  const client = createClient({ url });
  await client.connect();
  return {
    async get(key) {
      const v = await client.get(key);
      return v === null || v === undefined ? null : String(v);
    },
    async set(key, value, ttlSeconds) {
      if (ttlSeconds && ttlSeconds > 0) await client.set(key, value, { EX: ttlSeconds });
      else await client.set(key, value);
    },
    async del(key) {
      return Number(await client.del(key));
    },
    async keys(pattern) {
      const found = await client.keys(pattern);
      return found.map(String);
    },
    async publish(channel, message) {
      return Number(await client.publish(channel, message));
    },
    subscribeOnce(channel, ms) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const sub = client.duplicate();
        const timer = setTimeout(() => {
          void finish(new Error(`Timed out waiting for Redis message on ${channel}`));
        }, ms);
        const finish = async (err?: Error, msg?: { channel: string; message: string }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            await sub.unsubscribe(channel);
            await sub.close();
          } catch {
            /* ignore */
          }
          if (err) reject(err);
          else resolve(msg!);
        };
        void sub
          .connect()
          .then(() =>
            sub.subscribe(channel, (message) => {
              void finish(undefined, { channel, message: String(message) });
            }),
          )
          .catch((err: unknown) => finish(err instanceof Error ? err : new Error(String(err))));
      });
    },
    async hget(key, field) {
      const v = await client.hGet(key, field);
      return v === null || v === undefined ? null : String(v);
    },
    async hset(key, field, value) {
      return Number(await client.hSet(key, field, value));
    },
    async hgetall(key) {
      const rec = await client.hGetAll(key);
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(rec ?? {})) out[k] = String(v);
      return out;
    },
    async lpush(key, value) {
      return Number(await client.lPush(key, value));
    },
    async lrange(key, start, stop) {
      const vals = await client.lRange(key, start, stop);
      return vals.map(String);
    },
    async xadd(key, fields) {
      const id = await client.xAdd(key, "*", fields);
      return String(id);
    },
    async xread(key, count) {
      const res = await client.xRead({ key, id: "0-0" }, { COUNT: count });
      const out: Array<{ id: string; fields: Record<string, string> }> = [];
      for (const stream of res ?? []) {
        for (const msg of stream.messages ?? []) {
          const fields: Record<string, string> = {};
          for (const [k, v] of Object.entries(msg.message ?? {})) fields[k] = String(v);
          out.push({ id: String(msg.id), fields });
        }
      }
      return out;
    },
    async xgroupCreate(key, group, start) {
      try {
        await client.xGroupCreate(key, group, start || "0", { MKSTREAM: true });
        return { ok: true as const };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/BUSYGROUP/i.test(msg)) return { ok: true as const, already: true };
        throw err;
      }
    },
    async xreadGroup(group, consumer, key, count) {
      const res = await client.xReadGroup(group, consumer, { key, id: ">" }, { COUNT: count });
      const out: Array<{ id: string; fields: Record<string, string> }> = [];
      for (const stream of res ?? []) {
        for (const msg of stream.messages ?? []) {
          const fields: Record<string, string> = {};
          for (const [k, v] of Object.entries(msg.message ?? {})) fields[k] = String(v);
          out.push({ id: String(msg.id), fields });
        }
      }
      return out;
    },
    async xack(key, group, id) {
      return { acked: Number(await client.xAck(key, group, id)) };
    },
    async close() {
      await client.close();
    },
  };
}

const WRITE_TOOLS = new Set(["set", "del", "hset", "lpush", "xadd", "publish", "xgroup_create", "xreadgroup", "xack"]);

export class RedisAdapter implements ProtocolAdapter {
  readonly protocol = "redis";
  private handle: RedisHandle | undefined;
  private url = "";
  private connected = false;
  private allowWrite = false;

  constructor(
    readonly id: string,
    private readonly connectFn: RedisConnectFn = defaultConnect,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    const url = redisUrl(config);
    if (!url) throw new Error("Redis adapter requires config.url (e.g. redis://127.0.0.1:6379)");
    this.url = url;
    this.allowWrite = allowWriteFrom(config);
    this.handle = await this.connectFn({ ...config, url });
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
        name: "get",
        description: "GET a key",
        inputSchema: {
          type: "object",
          properties: { key: { type: "string" } },
          required: ["key"],
          additionalProperties: false,
        },
      },
      {
        name: "set",
        description: "SET a key (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: {
            key: { type: "string" },
            value: {},
            ttlSeconds: { type: "integer" },
          },
          required: ["key", "value"],
          additionalProperties: false,
        },
      },
      {
        name: "del",
        description: "DEL a key (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: { key: { type: "string" } },
          required: ["key"],
          additionalProperties: false,
        },
      },
      {
        name: "keys",
        description: "KEYS pattern (use sparingly against real Redis)",
        inputSchema: {
          type: "object",
          properties: { pattern: { type: "string", default: "*" } },
          additionalProperties: false,
        },
      },
      {
        name: "hget",
        description: "HGET field",
        inputSchema: {
          type: "object",
          properties: { key: { type: "string" }, field: { type: "string" } },
          required: ["key", "field"],
          additionalProperties: false,
        },
      },
      {
        name: "hset",
        description: "HSET field (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: { key: { type: "string" }, field: { type: "string" }, value: {} },
          required: ["key", "field", "value"],
          additionalProperties: false,
        },
      },
      {
        name: "hgetall",
        description: "HGETALL",
        inputSchema: {
          type: "object",
          properties: { key: { type: "string" } },
          required: ["key"],
          additionalProperties: false,
        },
      },
      {
        name: "lpush",
        description: "LPUSH (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: { key: { type: "string" }, value: {} },
          required: ["key", "value"],
          additionalProperties: false,
        },
      },
      {
        name: "lrange",
        description: "LRANGE",
        inputSchema: {
          type: "object",
          properties: {
            key: { type: "string" },
            start: { type: "integer", default: 0 },
            stop: { type: "integer", default: -1 },
          },
          required: ["key"],
          additionalProperties: false,
        },
      },
      {
        name: "xadd",
        description: "XADD to a stream (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: { key: { type: "string" }, fields: { type: "object" } },
          required: ["key", "fields"],
          additionalProperties: false,
        },
      },
      {
        name: "xread",
        description: "XREAD from the start of a stream (COUNT)",
        inputSchema: {
          type: "object",
          properties: { key: { type: "string" }, count: { type: "integer", default: 10 } },
          required: ["key"],
          additionalProperties: false,
        },
      },
      {
        name: "xgroup_create",
        description: "XGROUP CREATE (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: { key: { type: "string" }, group: { type: "string" }, start: { type: "string", default: "0" } },
          required: ["key", "group"],
          additionalProperties: false,
        },
      },
      {
        name: "xreadgroup",
        description: "XREADGROUP (claims pending; requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: {
            key: { type: "string" },
            group: { type: "string" },
            consumer: { type: "string" },
            count: { type: "integer", default: 10 },
          },
          required: ["key", "group", "consumer"],
          additionalProperties: false,
        },
      },
      {
        name: "xack",
        description: "XACK (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: { key: { type: "string" }, group: { type: "string" }, id: { type: "string" } },
          required: ["key", "group", "id"],
          additionalProperties: false,
        },
      },
      {
        name: "publish",
        description: "PUBLISH a message to a channel (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: {
            channel: { type: "string" },
            message: {},
          },
          required: ["channel", "message"],
          additionalProperties: false,
        },
      },
      {
        name: "subscribe_once",
        description: "SUBSCRIBE and wait for a single message",
        inputSchema: {
          type: "object",
          properties: {
            channel: { type: "string" },
            timeoutMs: { type: "integer", default: 5000 },
          },
          required: ["channel"],
          additionalProperties: false,
        },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    if (WRITE_TOOLS.has(toolName) && !this.allowWrite) {
      throw new AdapterError("E_UNSUPPORTED", "Write blocked (config.allowWrite=false)", { protocol: "redis" });
    }
    const handle = this.handle!;
    if (toolName === "get") {
      const key = requiredString(args, "key");
      return { key, value: await handle.get(key) };
    }
    if (toolName === "set") {
      const key = requiredString(args, "key");
      const value = payloadToString(args.value);
      const ttl = typeof args.ttlSeconds === "number" ? args.ttlSeconds : undefined;
      await handle.set(key, value, ttl);
      return { ok: true, key };
    }
    if (toolName === "del") {
      const key = requiredString(args, "key");
      return { key, deleted: await handle.del(key) };
    }
    if (toolName === "keys") {
      const pattern = typeof args.pattern === "string" && args.pattern ? args.pattern : "*";
      return { keys: await handle.keys(pattern) };
    }
    if (toolName === "hget") {
      return { value: await handle.hget(requiredString(args, "key"), requiredString(args, "field")) };
    }
    if (toolName === "hset") {
      const n = await handle.hset(requiredString(args, "key"), requiredString(args, "field"), payloadToString(args.value));
      return { ok: true, added: n };
    }
    if (toolName === "hgetall") {
      return { hash: await handle.hgetall(requiredString(args, "key")) };
    }
    if (toolName === "lpush") {
      const len = await handle.lpush(requiredString(args, "key"), payloadToString(args.value));
      return { length: len };
    }
    if (toolName === "lrange") {
      const start = typeof args.start === "number" ? args.start : 0;
      const stop = typeof args.stop === "number" ? args.stop : -1;
      return { values: await handle.lrange(requiredString(args, "key"), start, stop) };
    }
    if (toolName === "xadd") {
      const fields =
        args.fields && typeof args.fields === "object" && !Array.isArray(args.fields)
          ? Object.fromEntries(Object.entries(args.fields as Record<string, unknown>).map(([k, v]) => [k, payloadToString(v)]))
          : {};
      const id = await handle.xadd(requiredString(args, "key"), fields);
      return { id };
    }
    if (toolName === "xread") {
      const count = typeof args.count === "number" ? args.count : 10;
      return { entries: await handle.xread(requiredString(args, "key"), count) };
    }
    if (toolName === "xgroup_create") {
      if (!handle.xgroupCreate) {
        throw new AdapterError("E_UNSUPPORTED", "Redis handle has no XGROUP", { protocol: "redis" });
      }
      return handle.xgroupCreate(
        requiredString(args, "key"),
        requiredString(args, "group"),
        typeof args.start === "string" && args.start ? args.start : "0",
      );
    }
    if (toolName === "xreadgroup") {
      if (!handle.xreadGroup) {
        throw new AdapterError("E_UNSUPPORTED", "Redis handle has no XREADGROUP", { protocol: "redis" });
      }
      const count = typeof args.count === "number" ? args.count : 10;
      return {
        entries: await handle.xreadGroup(
          requiredString(args, "group"),
          requiredString(args, "consumer"),
          requiredString(args, "key"),
          count,
        ),
      };
    }
    if (toolName === "xack") {
      if (!handle.xack) {
        throw new AdapterError("E_UNSUPPORTED", "Redis handle has no XACK", { protocol: "redis" });
      }
      return handle.xack(requiredString(args, "key"), requiredString(args, "group"), requiredString(args, "id"));
    }
    if (toolName === "publish") {
      const channel = requiredString(args, "channel");
      const message = payloadToString(args.message);
      const receivers = await handle.publish(channel, message);
      return { ok: true, channel, receivers };
    }
    if (toolName === "subscribe_once") {
      return handle.subscribeOnce(requiredString(args, "channel"), timeoutMs(args));
    }
    throw new Error(`Unknown Redis tool "${toolName}"`);
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return { ok: true, detail: `url=${this.url} allowWrite=${this.allowWrite} (hash/list/stream)` };
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) throw new Error("Redis adapter is not connected");
  }
}
