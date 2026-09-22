import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PubsubAdapter, listenPubsubLoopback } from "../src/adapters/pubsub/index.js";
import { AdapterError } from "../src/runtime/errors.js";

describe("GCP Pub/Sub MVP", () => {
  it("list/pull readonly; publish gated", async () => {
    const a = new PubsubAdapter("ps:t");
    await a.connect({ simulator: true });
    const topics = (await a.invoke("list_topics", {})) as { topics: string[] };
    assert.ok(topics.topics.length >= 1);
    const pulled = (await a.invoke("pull", {})) as { messages: unknown[] };
    assert.ok(pulled.messages.length >= 1);
    await assert.rejects(
      () => a.invoke("publish", { data: "x" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
    const pub = new PubsubAdapter("ps:w");
    await pub.connect({ simulator: true, allowWrite: true });
    const published = (await pub.invoke("publish", { data: "hi" })) as { messageIds: string[] };
    assert.ok(published.messageIds.length >= 1);
    await pub.disconnect();
  });

  it("HTTP emulator list topics", async () => {
    const loop = await listenPubsubLoopback();
    const a = new PubsubAdapter("ps:http");
    try {
      await a.connect({ url: `http://127.0.0.1:${loop.port}`, project: "demo" });
      const topics = (await a.invoke("list_topics", {})) as { topics: string[] };
      assert.ok(topics.topics.length >= 1);
    } finally {
      await a.disconnect();
      await loop.close();
    }
  });
});
