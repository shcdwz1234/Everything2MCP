import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AdapterError } from "../src/runtime/errors.js";
import {
  KafkaAdapter,
  createHermeticKafkaHandle,
  kafkaProducerOptions,
  kafkaTransactionalRequested,
  type KafkaHandle,
} from "../src/adapters/kafka/index.js";

function fakeKafka(): KafkaHandle {
  const log = new Map<string, Array<{ topic: string; value: string; key?: string }>>();
  const committed = new Map<string, number>();
  const waiters = new Map<string, Array<(msg: { topic: string; value: string; key?: string }) => void>>();
  return {
    async produce(topic, value, key) {
      const msg = { topic, value, key };
      const q = log.get(topic) ?? [];
      q.push(msg);
      log.set(topic, q);
      const waiter = waiters.get(topic)?.shift();
      if (waiter) waiter(msg);
    },
    consumeOnce(topic, ms, opts) {
      const gid = opts?.groupId ?? "default";
      const ckey = `${gid}::${topic}`;
      const offset = committed.get(ckey) ?? 0;
      const q = log.get(topic) ?? [];
      if (offset < q.length) {
        committed.set(ckey, offset + 1);
        return Promise.resolve({ ...q[offset]!, groupId: gid });
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for Kafka message on ${topic}`)), ms);
        const list = waiters.get(topic) ?? [];
        list.push((msg) => {
          clearTimeout(timer);
          const next = committed.get(ckey) ?? 0;
          committed.set(ckey, next + 1);
          resolve({ ...msg, groupId: gid });
        });
        waiters.set(topic, list);
      });
    },
    async listTopics() {
      return [...log.keys()];
    },
    async groupSnapshot(groupId) {
      const out: Record<string, number> = {};
      for (const [k, v] of committed.entries()) {
        const prefix = `${groupId}::`;
        if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
      }
      return { committed: out };
    },
    async close() {
      log.clear();
    },
  };
}

describe("KafkaAdapter", () => {
  it("rejects missing brokers", async () => {
    await assert.rejects(
      () => new KafkaAdapter("k", async () => fakeKafka()).connect({}),
      /brokers/,
    );
  });

  it("produces and consume_once via a fake client", async () => {
    const adapter = new KafkaAdapter("events", async () => fakeKafka());
    await adapter.connect({ brokers: ["127.0.0.1:9092"], topic: "orders", groupId: "g1", allowWrite: true });
    const names = (await adapter.listTools()).map((t) => t.name).sort();
    assert.deepEqual(names, ["consume_once", "group_status", "list_topics", "produce"]);
    const pending = adapter.invoke("consume_once", { topic: "orders", timeoutMs: 500 });
    await new Promise((r) => setImmediate(r));
    await adapter.invoke("produce", { topic: "orders", payload: { sku: "x" }, key: "1" });
    const msg = (await pending) as { value: string; topic: string };
    assert.equal(msg.topic, "orders");
    assert.equal(JSON.parse(msg.value).sku, "x");
    await adapter.disconnect();
  });

  it("tracks consumer-group offsets independently", async () => {
    const adapter = new KafkaAdapter("groups", async () => fakeKafka());
    await adapter.connect({ brokers: ["127.0.0.1:9092"], topic: "orders", groupId: "alpha", allowWrite: true });
    try {
      await adapter.invoke("produce", { payload: "one" });
      await adapter.invoke("produce", { payload: "two" });
      const a1 = (await adapter.invoke("consume_once", {})) as { value: string; groupId?: string };
      const b1 = (await adapter.invoke("consume_once", { groupId: "beta" })) as { value: string };
      const a2 = (await adapter.invoke("consume_once", { groupId: "alpha" })) as { value: string };
      assert.equal(a1.value, "one");
      assert.equal(b1.value, "one");
      assert.equal(a2.value, "two");
      const health = await adapter.health();
      assert.match(health.detail ?? "", /groupId=alpha/);
      assert.match(health.detail ?? "", /rebalance=none/);
      const status = (await adapter.invoke("group_status", {})) as {
        groupId: string;
        rebalance: string;
        consumeModel: string;
        transactional: boolean;
        staticMembership: { effective: boolean; requested: boolean };
        committed: Record<string, number>;
        unsupported: string[];
      };
      assert.equal(status.groupId, "alpha");
      assert.equal(status.rebalance, "none");
      assert.equal(status.consumeModel, "one-shot");
      assert.equal(status.transactional, false);
      assert.equal(status.staticMembership.effective, false);
      assert.equal(status.staticMembership.requested, false);
      assert.equal(status.committed.orders, 2);
      assert.ok(status.unsupported.includes("transactions"));
    } finally {
      await adapter.disconnect();
    }
  });

  it("defaults allowWrite=false and blocks produce; consume still works", async () => {
    const adapter = new KafkaAdapter("ro", async () => fakeKafka());
    await adapter.connect({ brokers: ["127.0.0.1:9092"], topic: "orders" });
    try {
      await assert.rejects(() => adapter.invoke("produce", { payload: "x" }), /allowWrite/);
      const listed = (await adapter.invoke("list_topics", {})) as { topics: string[] };
      assert.ok(listed.topics.includes("orders"));
    } finally {
      await adapter.disconnect();
    }
  });

  it("reports requested static membership as not effective", async () => {
    const adapter = new KafkaAdapter("static", async () => fakeKafka());
    await adapter.connect({
      brokers: ["127.0.0.1:9092"],
      topic: "orders",
      groupId: "desk",
      groupInstanceId: "desk-1",
    });
    try {
      const status = (await adapter.invoke("group_status", {})) as {
        staticMembership: { requested: boolean; effective: boolean; groupInstanceId?: string };
        transactional: boolean;
      };
      assert.equal(status.staticMembership.requested, true);
      assert.equal(status.staticMembership.effective, false);
      assert.equal(status.staticMembership.groupInstanceId, "desk-1");
      assert.equal(status.transactional, false);
    } finally {
      await adapter.disconnect();
    }
  });

  it("nails transactions/EOS as unsupported; idempotent is a producer flag only", async () => {
    assert.deepEqual(kafkaProducerOptions({ idempotent: true }), { idempotent: true, maxInFlightRequests: 1 });
    assert.deepEqual(kafkaProducerOptions({}), {});
    assert.equal(kafkaTransactionalRequested({ transactionalId: "txn-1" }).requested, true);
    assert.equal(kafkaTransactionalRequested({}).requested, false);

    const handle = fakeKafka();
    handle.producerCaps = { idempotent: true };
    const adapter = new KafkaAdapter("eos", async () => handle);
    await adapter.connect({
      brokers: ["127.0.0.1:9092"],
      topic: "orders",
      idempotent: true,
      transactionalId: "txn-desk",
    });
    try {
      const status = (await adapter.invoke("group_status", {})) as {
        transactional: boolean;
        transactionalId: { requested: boolean; effective: boolean; transactionalId?: string };
        idempotent: { requested: boolean; effective: boolean };
        unsupported: string[];
      };
      assert.equal(status.transactional, false);
      assert.equal(status.transactionalId.requested, true);
      assert.equal(status.transactionalId.effective, false);
      assert.equal(status.transactionalId.transactionalId, "txn-desk");
      assert.equal(status.idempotent.requested, true);
      assert.equal(status.idempotent.effective, true);
      assert.ok(status.unsupported.includes("exactly-once"));
      assert.ok(status.unsupported.includes("init_transactions"));
      const live = (await adapter.invoke("group_status", {})) as {
        cluster: { eos: boolean; cooperativeRebalance: boolean; requiresBroker: boolean };
      };
      assert.equal(live.cluster.eos, false);
      assert.equal(live.cluster.cooperativeRebalance, false);
      assert.equal(live.cluster.requiresBroker, true);
      for (const tool of ["begin_transaction", "commit_transaction", "abort_transaction", "init_transactions"]) {
        await assert.rejects(
          () => adapter.invoke(tool, {}),
          (err: unknown) =>
            err instanceof AdapterError && err.code === "E_UNSUPPORTED" && /EOS|transaction/i.test(err.message),
        );
      }
    } finally {
      await adapter.disconnect();
    }
  });

  it("hermetic handle exposes InitProducerId stub and static membership flag", async () => {
    const adapter = new KafkaAdapter("hermetic", async () => createHermeticKafkaHandle());
    await adapter.connect({
      brokers: ["127.0.0.1:9092"],
      topic: "orders",
      transactionalId: "txn-h",
      groupInstanceId: "desk-1",
      allowWrite: true,
    });
    try {
      const before = (await adapter.invoke("group_status", {})) as {
        transactional: boolean;
        transactionalId: { effective: boolean };
        staticMembership: { requested: boolean; effective: boolean };
        rebalance: string;
        generation: number;
        hermetic: { transactions: boolean; staticMembership: boolean; txn?: { state: string } };
      };
      assert.equal(before.staticMembership.requested, true);
      assert.equal(before.staticMembership.effective, true);
      assert.equal(before.rebalance, "hermetic-generation");
      assert.equal(before.generation, 0);
      assert.equal(before.transactional, false);
      assert.equal(before.transactionalId.effective, false);
      assert.equal(before.hermetic.transactions, true);

      const init = (await adapter.invoke("init_transactions", {})) as {
        hermetic: boolean;
        txn: { state: string; transactionalId: string; epoch: number };
      };
      assert.equal(init.hermetic, true);
      assert.equal(init.txn.state, "ready");
      assert.equal(init.txn.transactionalId, "txn-h");

      const afterInit = (await adapter.invoke("group_status", {})) as {
        transactional: boolean;
        transactionalId: { effective: boolean };
      };
      assert.equal(afterInit.transactional, true);
      assert.equal(afterInit.transactionalId.effective, true);

      const begin = (await adapter.invoke("begin_transaction", {})) as { txn: { state: string } };
      assert.equal(begin.txn.state, "in_txn");
      await assert.rejects(
        () => adapter.invoke("begin_transaction", {}),
        (err: unknown) => err instanceof AdapterError && err.code === "E_CONFLICT",
      );
      const commit = (await adapter.invoke("commit_transaction", {})) as { txn: { state: string; epoch: number } };
      assert.equal(commit.txn.state, "ready");
      assert.equal(commit.txn.epoch, 1);

      await adapter.invoke("begin_transaction", {});
      const abort = (await adapter.invoke("abort_transaction", {})) as { txn: { epoch: number; state: string } };
      assert.equal(abort.txn.epoch, 2);
      assert.equal(abort.txn.state, "ready");

      await adapter.invoke("produce", { payload: "one" });
      const msg = (await adapter.invoke("consume_once", {})) as { value: string };
      assert.equal(msg.value, "one");
      const afterConsume = (await adapter.invoke("group_status", {})) as { generation: number; rebalance: string };
      assert.equal(afterConsume.generation, 1);
      assert.equal(afterConsume.rebalance, "hermetic-generation");
    } finally {
      await adapter.disconnect();
    }

    const ro = new KafkaAdapter("hermetic-ro", async () => createHermeticKafkaHandle());
    await ro.connect({ brokers: ["127.0.0.1:9092"], topic: "orders", transactionalId: "txn-ro" });
    try {
      await ro.invoke("init_transactions", {});
      await assert.rejects(
        () => ro.invoke("begin_transaction", {}),
        (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED" && /allowWrite/.test(err.message),
      );
    } finally {
      await ro.disconnect();
    }
  });

  it("rejects tools before connect, unknown tools, and consume timeout", async () => {
    const adapter = new KafkaAdapter("events", async () => fakeKafka());
    await assert.rejects(() => adapter.listTools(), /not connected/);
    await adapter.connect({ brokers: ["127.0.0.1:9092"], topic: "orders" });
    try {
      await assert.rejects(() => adapter.invoke("nope", {}), /Unknown Kafka tool/);
      await assert.rejects(
        () => adapter.invoke("consume_once", { topic: "idle", timeoutMs: 30 }),
        /Timed out/,
      );
    } finally {
      await adapter.disconnect();
    }
  });
});
