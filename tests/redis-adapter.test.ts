import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RedisAdapter, type RedisHandle } from "../src/adapters/redis/index.js";
import { AdapterError } from "../src/runtime/errors.js";

function fakeRedis(): RedisHandle {
  const kv = new Map<string, string>();
  const hashes = new Map<string, Map<string, string>>();
  const lists = new Map<string, string[]>();
  const streams = new Map<string, Array<{ id: string; fields: Record<string, string> }>>();
  const groups = new Map<string, Map<string, { last: string; pending: Set<string> }>>();
  let streamSeq = 1;
  const waiters = new Map<string, Array<(msg: { channel: string; message: string }) => void>>();
  const inbox = new Map<string, string[]>();
  return {
    async get(key) {
      return kv.get(key) ?? null;
    },
    async set(key, value) {
      kv.set(key, value);
    },
    async del(key) {
      return kv.delete(key) ? 1 : 0;
    },
    async keys(pattern) {
      const star = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
      return [...kv.keys()].filter((k) => (pattern === "*" ? true : k.startsWith(star) || k === pattern));
    },
    async publish(channel, message) {
      const waiter = waiters.get(channel)?.shift();
      if (waiter) {
        waiter({ channel, message });
        return 1;
      }
      const q = inbox.get(channel) ?? [];
      q.push(message);
      inbox.set(channel, q);
      return 0;
    },
    subscribeOnce(channel, ms) {
      const buffered = inbox.get(channel)?.shift();
      if (buffered) return Promise.resolve({ channel, message: buffered });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for Redis message on ${channel}`)), ms);
        const list = waiters.get(channel) ?? [];
        list.push((msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
        waiters.set(channel, list);
      });
    },
    async hget(key, field) {
      return hashes.get(key)?.get(field) ?? null;
    },
    async hset(key, field, value) {
      const h = hashes.get(key) ?? new Map();
      const added = h.has(field) ? 0 : 1;
      h.set(field, value);
      hashes.set(key, h);
      return added;
    },
    async hgetall(key) {
      return Object.fromEntries(hashes.get(key) ?? []);
    },
    async lpush(key, value) {
      const list = lists.get(key) ?? [];
      list.unshift(value);
      lists.set(key, list);
      return list.length;
    },
    async lrange(key, start, stop) {
      const list = lists.get(key) ?? [];
      const end = stop < 0 ? list.length + stop + 1 : stop + 1;
      return list.slice(start, end);
    },
    async xadd(key, fields) {
      const id = `${streamSeq++}-0`;
      const entries = streams.get(key) ?? [];
      entries.push({ id, fields });
      streams.set(key, entries);
      return id;
    },
    async xread(key) {
      return [...(streams.get(key) ?? [])];
    },
    async xgroupCreate(key, group) {
      const g = groups.get(key) ?? new Map();
      if (g.has(group)) return { ok: true as const, already: true };
      g.set(group, { last: "0-0", pending: new Set<string>() });
      groups.set(key, g);
      return { ok: true as const };
    },
    async xreadGroup(group, _consumer, key) {
      const g = groups.get(key)?.get(group);
      if (!g) throw new Error("NOGROUP");
      const entries = streams.get(key) ?? [];
      const unseen = entries.filter((e) => e.id > g.last);
      for (const e of unseen) g.pending.add(e.id);
      if (unseen[0]) g.last = unseen[unseen.length - 1]!.id;
      return unseen;
    },
    async xack(key, group, id) {
      const g = groups.get(key)?.get(group);
      if (!g) return { acked: 0 };
      const had = g.pending.delete(id);
      return { acked: had ? 1 : 0 };
    },
    async close() {
      kv.clear();
    },
  };
}

describe("RedisAdapter", () => {
  it("rejects missing url", async () => {
    await assert.rejects(() => new RedisAdapter("r", async () => fakeRedis()).connect({}), /url/);
  });

  it("GET/SET/DEL/KEYS/PUBLISH/SUBSCRIBE_ONCE on a fake client", async () => {
    const adapter = new RedisAdapter("cache", async () => fakeRedis());
    await adapter.connect({ url: "redis://127.0.0.1:6379", allowWrite: true });
    const names = (await adapter.listTools()).map((t) => t.name).sort();
    assert.ok(names.includes("hget"));
    assert.ok(names.includes("lrange"));
    assert.ok(names.includes("xadd"));
    await adapter.invoke("set", { key: "a", value: "1" });
    const got = (await adapter.invoke("get", { key: "a" })) as { value: string };
    assert.equal(got.value, "1");
    const keys = (await adapter.invoke("keys", { pattern: "*" })) as { keys: string[] };
    assert.deepEqual(keys.keys, ["a"]);
    const pending = adapter.invoke("subscribe_once", { channel: "events", timeoutMs: 500 });
    await new Promise((r) => setImmediate(r));
    await adapter.invoke("publish", { channel: "events", message: "ping" });
    const msg = (await pending) as { message: string };
    assert.equal(msg.message, "ping");
    const del = (await adapter.invoke("del", { key: "a" })) as { deleted: number };
    assert.equal(del.deleted, 1);
    await adapter.invoke("hset", { key: "user", field: "name", value: "Ada" });
    const hash = (await adapter.invoke("hgetall", { key: "user" })) as { hash: Record<string, string> };
    assert.equal(hash.hash.name, "Ada");
    await adapter.invoke("lpush", { key: "q", value: "one" });
    const list = (await adapter.invoke("lrange", { key: "q", start: 0, stop: -1 })) as { values: string[] };
    assert.deepEqual(list.values, ["one"]);
    await adapter.invoke("xadd", { key: "s", fields: { event: "hi" } });
    const stream = (await adapter.invoke("xread", { key: "s" })) as { entries: Array<{ fields: Record<string, string> }> };
    assert.equal(stream.entries[0]?.fields.event, "hi");
    await adapter.invoke("xgroup_create", { key: "s", group: "g1" });
    const claimed = (await adapter.invoke("xreadgroup", { key: "s", group: "g1", consumer: "c1" })) as {
      entries: Array<{ id: string }>;
    };
    assert.ok(claimed.entries.length >= 1);
    await adapter.invoke("xack", { key: "s", group: "g1", id: claimed.entries[0]!.id });
    await adapter.disconnect();
  });

  it("blocks SET/HSET/LPUSH/XADD when allowWrite is omitted", async () => {
    const adapter = new RedisAdapter("ro", async () => fakeRedis());
    await adapter.connect({ url: "redis://127.0.0.1:6379" });
    await assert.rejects(
      () => adapter.invoke("set", { key: "a", value: "1" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
    await assert.rejects(
      () => adapter.invoke("hset", { key: "u", field: "n", value: "x" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
    await assert.rejects(
      () => adapter.invoke("lpush", { key: "q", value: "1" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
    await assert.rejects(
      () => adapter.invoke("xadd", { key: "s", fields: { event: "hi" } }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
    await assert.rejects(
      () => adapter.invoke("xgroup_create", { key: "s", group: "g" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
    await assert.rejects(
      () => adapter.invoke("publish", { channel: "events", message: "ping" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
    const got = (await adapter.invoke("get", { key: "a" })) as { value: string | null };
    assert.equal(got.value, null);
    await adapter.disconnect();
  });

  it("rejects tools before connect and unknown tools", async () => {
    const adapter = new RedisAdapter("cache", async () => fakeRedis());
    await assert.rejects(() => adapter.listTools(), /not connected/);
    await adapter.connect({ url: "redis://127.0.0.1:6379" });
    try {
      await assert.rejects(() => adapter.invoke("nope", {}), /Unknown|unknown/);
    } finally {
      await adapter.disconnect();
    }
  });
});
