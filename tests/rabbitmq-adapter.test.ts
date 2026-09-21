import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listenRabbitmqLoopback, RabbitmqAdapter } from "../src/adapters/rabbitmq/index.js";
import { AdapterError } from "../src/runtime/errors.js";

describe("RabbitmqAdapter", () => {
  it("management publish/get gated; not AMQP wire", async () => {
    const ro = new RabbitmqAdapter("rmq.ro");
    await ro.connect({ simulator: true });
    try {
      await assert.rejects(
        () => ro.invoke("publish", { routingKey: "jobs", payload: "x" }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
      );
      const health = await ro.health();
      assert.match(health.detail ?? "", /not AMQP/);
    } finally {
      await ro.disconnect();
    }

    const adapter = new RabbitmqAdapter("rmq.mem");
    await adapter.connect({ simulator: true, allowWrite: true });
    try {
      await adapter.invoke("publish", { routingKey: "jobs", payload: "hello" });
      const got = (await adapter.invoke("get", { queue: "jobs" })) as { payload: string };
      assert.equal(got.payload, "hello");
      const qs = (await adapter.invoke("list_queues", {})) as { queues: Array<{ name: string }> };
      assert.ok(qs.queues.some((q) => q.name === "jobs"));
    } finally {
      await adapter.disconnect();
    }
  });

  it("HTTP /api/overview loopback publish/get", async () => {
    const loop = await listenRabbitmqLoopback();
    const adapter = new RabbitmqAdapter("rmq.http");
    try {
      await adapter.connect({ url: `http://127.0.0.1:${loop.port}`, allowWrite: true });
      await adapter.invoke("publish", { exchange: "amq.default", routingKey: "q1", payload: "n" });
      const got = (await adapter.invoke("get", { queue: "q1" })) as { payload: string };
      assert.equal(got.payload, "n");
    } finally {
      await adapter.disconnect();
      await loop.close();
    }
  });
});
