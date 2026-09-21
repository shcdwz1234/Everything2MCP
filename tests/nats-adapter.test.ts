import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NatsAdapter, type NatsHandle } from "../src/adapters/nats/index.js";

function fakeNats(): NatsHandle {
  const inbox = new Map<string, string[]>();
  const waiters = new Map<string, Array<(msg: { subject: string; data: string; queue?: string }) => void>>();
  const responders = new Map<string, (payload: string) => string>();
  const jsStream: Array<{ subject: string; data: string; seq: number }> = [];
  const jsWaiters: Array<(msg: { subject: string; data: string; stream: string; seq: number }) => void> = [];
  responders.set("echo", (p) => p);
  let seq = 0;
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
      if (!fn) throw new Error(`no responder for ${subject}`);
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
      /* noop */
    },
    async jsPublish(subject, payload) {
      seq += 1;
      const rec = { subject, data: payload, seq };
      const waiter = jsWaiters.shift();
      if (waiter) waiter({ ...rec, stream: "EVERYTHING2MCP" });
      else jsStream.push(rec);
      return { stream: "EVERYTHING2MCP", seq, duplicate: false };
    },
    jsSubscribeOnce(subject, ms) {
      const hit = jsStream.findIndex((m) => m.subject === subject);
      if (hit >= 0) {
        const rec = jsStream.splice(hit, 1)[0]!;
        return Promise.resolve({ ...rec, stream: "EVERYTHING2MCP" });
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for JetStream message on ${subject}`)), ms);
        jsWaiters.push((msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
      });
    },
    async jsInfo() {
      return { jetstream: true, deferred: false, stream: "EVERYTHING2MCP", messages: seq };
    },
    async close() {
      inbox.clear();
    },
  };
}

describe("NatsAdapter", () => {
  it("rejects missing servers", async () => {
    await assert.rejects(() => new NatsAdapter("n", async () => fakeNats()).connect({}), /servers/);
  });

  it("core publish/request plus JetStream publish/subscribe_once", async () => {
    const adapter = new NatsAdapter("core", async () => fakeNats());
    await adapter.connect({ servers: ["nats://127.0.0.1:4222"], subjects: ["events"], allowWrite: true });
    const names = (await adapter.listTools()).map((t) => t.name);
    assert.ok(names.includes("js_publish"));
    assert.ok(names.includes("js_subscribe_once"));
    const pending = adapter.invoke("subscribe_once", { subject: "events", timeoutMs: 500, queue: "workers" });
    await new Promise((r) => setImmediate(r));
    await adapter.invoke("publish", { subject: "events", payload: "ping" });
    const msg = (await pending) as { data: string; queue?: string };
    assert.equal(msg.data, "ping");
    const reply = (await adapter.invoke("request", { subject: "echo", payload: "hi" })) as { data: string };
    assert.equal(reply.data, "hi");
    const jsPending = adapter.invoke("js_subscribe_once", { subject: "orders", timeoutMs: 500 });
    await new Promise((r) => setImmediate(r));
    const pub = (await adapter.invoke("js_publish", { subject: "orders", payload: "n1" })) as {
      seq: number;
      stream: string;
    };
    assert.equal(pub.stream, "EVERYTHING2MCP");
    assert.equal(pub.seq, 1);
    const jsMsg = (await jsPending) as { data: string; seq: number };
    assert.equal(jsMsg.data, "n1");
    const info = (await adapter.invoke("js_info", {})) as { jetstream: boolean };
    assert.equal(info.jetstream, true);
    await adapter.disconnect();
  });

  it("simulator JetStream consumer interest + fetch/ack/nack", async () => {
    const adapter = new NatsAdapter("js");
    await adapter.connect({ simulator: true, allowWrite: true, stream: "ORDERS" });
    try {
      await adapter.invoke("js_consumer_add", { name: "workers", filter: "orders.>" });
      await adapter.invoke("js_publish", { subject: "orders.new", payload: "n1" });
      await adapter.invoke("js_publish", { subject: "other", payload: "skip" });
      const next = (await adapter.invoke("js_next", { consumer: "workers", timeoutMs: 200 })) as {
        data: string;
        seq: number;
        subject: string;
      };
      assert.equal(next.subject, "orders.new");
      assert.equal(next.data, "n1");
      const acked = (await adapter.invoke("js_ack", { consumer: "workers", seq: next.seq })) as { ok: boolean };
      assert.equal(acked.ok, true);
      await adapter.invoke("js_publish", { subject: "orders.new", payload: "n2" });
      const second = (await adapter.invoke("js_next", { consumer: "workers", timeoutMs: 200 })) as { seq: number };
      await adapter.invoke("js_nack", { consumer: "workers", seq: second.seq });
      const again = (await adapter.invoke("js_next", { consumer: "workers", timeoutMs: 200 })) as { data: string };
      assert.equal(again.data, "n2");
      const info = (await adapter.invoke("js_info", {})) as { stream: string; consumers: Array<{ name: string }> };
      assert.equal(info.stream, "ORDERS");
      assert.ok(info.consumers.some((c) => c.name === "workers"));
    } finally {
      await adapter.disconnect();
    }
  });

  it("defaults allowWrite=false and blocks publish/request/js_publish", async () => {
    const adapter = new NatsAdapter("ro", async () => fakeNats());
    await adapter.connect({ servers: ["nats://127.0.0.1:4222"], subjects: ["events"] });
    try {
      await assert.rejects(() => adapter.invoke("publish", { subject: "events", payload: "x" }), /allowWrite/);
      await assert.rejects(() => adapter.invoke("request", { subject: "echo", payload: "x" }), /allowWrite/);
      await assert.rejects(() => adapter.invoke("js_publish", { subject: "orders", payload: "x" }), /allowWrite/);
      const listed = (await adapter.invoke("list_subjects", {})) as { subjects: string[] };
      assert.deepEqual(listed.subjects, ["events"]);
    } finally {
      await adapter.disconnect();
    }
  });

  it("rejects tools before connect, unknown tools, and subscribe timeout", async () => {
    const adapter = new NatsAdapter("core", async () => fakeNats());
    await assert.rejects(() => adapter.listTools(), /not connected/);
    await adapter.connect({ servers: ["nats://127.0.0.1:4222"] });
    try {
      await assert.rejects(() => adapter.invoke("nope", {}), /Unknown NATS tool/);
      await assert.rejects(
        () => adapter.invoke("subscribe_once", { subject: "idle", timeoutMs: 30 }),
        /Timed out/,
      );
    } finally {
      await adapter.disconnect();
    }
  });
});
