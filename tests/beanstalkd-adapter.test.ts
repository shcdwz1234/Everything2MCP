import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BeanstalkdAdapter, listenBeanstalkLoopback } from "../src/adapters/beanstalkd/index.js";
import { AdapterError } from "../src/runtime/errors.js";

describe("BeanstalkdAdapter", () => {
  it("memory stats/peek; put/reserve gated by allowWrite", async () => {
    const adapter = new BeanstalkdAdapter("bs.mem");
    await adapter.connect({ simulator: true });
    const st = (await adapter.invoke("stats", {})) as { stats: { "current-jobs-ready": string } };
    assert.equal(st.stats["current-jobs-ready"], "0");
    await assert.rejects(
      () => adapter.invoke("put", { body: "job" }),
      (err: unknown) => err instanceof AdapterError && /allowWrite/.test(String(err)),
    );
    await adapter.disconnect();

    const w = new BeanstalkdAdapter("bs.w");
    await w.connect({ simulator: true, allowWrite: true });
    const put = (await w.invoke("put", { body: "hello" })) as { id: number };
    const peek = (await w.invoke("peek", {})) as { body: string };
    assert.equal(peek.body, "hello");
    const job = (await w.invoke("reserve", {})) as { id: number; body: string };
    assert.equal(job.body, "hello");
    await w.invoke("delete", { id: put.id });
    await w.disconnect();
  });

  it("text protocol put/stats against loopback", async () => {
    const loop = await listenBeanstalkLoopback();
    const adapter = new BeanstalkdAdapter("bs.live");
    try {
      await adapter.connect({ host: "127.0.0.1", port: loop.port, allowWrite: true, timeoutMs: 1500 });
      await adapter.invoke("put", { body: "wire" });
      const st = (await adapter.invoke("stats", {})) as { stats: Record<string, string> };
      assert.ok(Number(st.stats["current-jobs-ready"]) >= 1);
      const job = (await adapter.invoke("reserve", {})) as { body: string };
      assert.equal(job.body, "wire");
    } finally {
      await adapter.disconnect();
      await loop.close();
    }
  });
});
