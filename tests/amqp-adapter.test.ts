import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AmqpAdapter, type AmqpHandle } from "../src/adapters/amqp/index.js";

function fakeAmqp(): AmqpHandle {
  const inbox = new Map<string, Array<{ content: string; routingKey: string }>>();
  const waiters = new Map<string, Array<(msg: { content: string; routingKey: string }) => void>>();
  return {
    async publish(_exchange, routingKey, content) {
      const msg = { content: content.toString("utf8"), routingKey };
      const waiter = waiters.get(routingKey)?.shift();
      if (waiter) waiter(msg);
      else {
        const q = inbox.get(routingKey) ?? [];
        q.push(msg);
        inbox.set(routingKey, q);
      }
    },
    consumeOnce(queue, ms) {
      const buffered = inbox.get(queue)?.shift();
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
    async rpc(queue, content) {
      return {
        content: `reply:${content.toString("utf8")}`,
        routingKey: queue,
        correlationId: "cid-test",
      };
    },
    async close() {
      inbox.clear();
    },
  };
}

describe("AmqpAdapter", () => {
  it("rejects missing url", async () => {
    await assert.rejects(() => new AmqpAdapter("a", async () => fakeAmqp()).connect({}), /config\.url/);
  });

  it("publishes and consume_once via a fake channel", async () => {
    const adapter = new AmqpAdapter("bus", async () => fakeAmqp());
    await adapter.connect({ url: "amqp://127.0.0.1", queue: "jobs", queues: ["jobs"], allowWrite: true });
    const names = (await adapter.listTools()).map((t) => t.name).sort();
    assert.ok(names.includes("publish"));
    assert.ok(names.includes("get"));
    assert.ok(names.includes("ack"));
    assert.ok(names.includes("nack"));
    const pending = adapter.invoke("consume_once", { queue: "jobs", timeoutMs: 500 });
    await new Promise((r) => setImmediate(r));
    await adapter.invoke("publish", { payload: { id: 1 }, routingKey: "jobs" });
    const msg = (await pending) as { content: string; routingKey: string };
    assert.equal(msg.routingKey, "jobs");
    assert.equal(JSON.parse(msg.content).id, 1);
    const listed = (await adapter.invoke("list_queues", {})) as { queues: string[] };
    assert.deepEqual(listed.queues, ["jobs"]);
    const rpc = (await adapter.invoke("rpc", { payload: { id: 9 }, queue: "jobs" })) as {
      content: string;
      correlationId: string;
    };
    assert.equal(rpc.correlationId, "cid-test");
    assert.match(rpc.content, /reply:/);
    await adapter.disconnect();
  });

  it("simulator get/ack/nack with write gate on ack", async () => {
    const adapter = new AmqpAdapter("mem");
    await adapter.connect({ simulator: true, queue: "jobs", allowWrite: true });
    try {
      await adapter.invoke("publish", { payload: "one", routingKey: "jobs" });
      const got = (await adapter.invoke("get", { queue: "jobs" })) as { content: string; deliveryTag: number };
      assert.equal(got.content, "one");
      const acked = (await adapter.invoke("ack", { deliveryTag: got.deliveryTag })) as { ok: boolean };
      assert.equal(acked.ok, true);
      await adapter.invoke("publish", { payload: "two", routingKey: "jobs" });
      const again = (await adapter.invoke("get", { queue: "jobs" })) as { deliveryTag: number };
      const nacked = (await adapter.invoke("nack", { deliveryTag: again.deliveryTag, requeue: true })) as {
        requeued: boolean;
      };
      assert.equal(nacked.requeued, true);
      const back = (await adapter.invoke("get", { queue: "jobs" })) as { content: string };
      assert.equal(back.content, "two");
    } finally {
      await adapter.disconnect();
    }
  });

  it("defaults allowWrite=false and blocks publish/rpc; consume still works", async () => {
    const adapter = new AmqpAdapter("ro", async () => fakeAmqp());
    await adapter.connect({ url: "amqp://127.0.0.1", queue: "jobs" });
    try {
      await assert.rejects(() => adapter.invoke("publish", { payload: { id: 1 }, routingKey: "jobs" }), /allowWrite/);
      await assert.rejects(() => adapter.invoke("rpc", { payload: { id: 1 }, queue: "jobs" }), /allowWrite/);
      const listed = (await adapter.invoke("list_queues", {})) as { queues: string[] };
      assert.deepEqual(listed.queues, ["jobs"]);
    } finally {
      await adapter.disconnect();
    }
  });

  it("rejects tools before connect, unknown tools, and consume timeout", async () => {
    const adapter = new AmqpAdapter("bus", async () => fakeAmqp());
    await assert.rejects(() => adapter.listTools(), /not connected/);
    await adapter.connect({ url: "amqp://127.0.0.1", queue: "jobs" });
    try {
      await assert.rejects(() => adapter.invoke("nope", {}), /Unknown AMQP tool/);
      await assert.rejects(
        () => adapter.invoke("consume_once", { queue: "idle", timeoutMs: 30 }),
        /Timed out/,
      );
    } finally {
      await adapter.disconnect();
    }
  });
});
