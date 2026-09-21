import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemcachedAdapter, listenMemcachedLoopback } from "../src/adapters/memcached/index.js";
import { AdapterError } from "../src/runtime/errors.js";

describe("MemcachedAdapter", () => {
  it("memory get/stats; set/delete gated by allowWrite", async () => {
    const adapter = new MemcachedAdapter("mc.mem");
    await adapter.connect({ simulator: true });
    const miss = (await adapter.invoke("get", { key: "k" })) as { missing?: boolean };
    assert.equal(miss.missing, true);
    await assert.rejects(
      () => adapter.invoke("set", { key: "k", value: "v" }),
      (err: unknown) => err instanceof AdapterError && /allowWrite/.test(String(err)),
    );
    await adapter.disconnect();

    const writer = new MemcachedAdapter("mc.w");
    await writer.connect({ simulator: true, allowWrite: true });
    await writer.invoke("set", { key: "k", value: "v" });
    const got = (await writer.invoke("get", { key: "k" })) as { value: string };
    assert.equal(got.value, "v");
    await writer.disconnect();
  });

  it("text protocol GET/SET against loopback", async () => {
    const loop = await listenMemcachedLoopback();
    const adapter = new MemcachedAdapter("mc.live");
    try {
      await adapter.connect({ host: "127.0.0.1", port: loop.port, allowWrite: true, timeoutMs: 1500 });
      await adapter.invoke("set", { key: "n", value: "42" });
      const got = (await adapter.invoke("get", { key: "n" })) as { value: string };
      assert.equal(got.value, "42");
      const st = (await adapter.invoke("stats", {})) as { stats: { curr_items?: string } };
      assert.ok(st.stats.curr_items);
    } finally {
      await adapter.disconnect();
      await loop.close();
    }
  });
});
