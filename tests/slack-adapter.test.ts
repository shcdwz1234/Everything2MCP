import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SlackAdapter, listenSlackLoopback } from "../src/adapters/slack/index.js";
import { AdapterError } from "../src/runtime/errors.js";

describe("slack native adapter", () => {
  it("conversations.list; post gated", async () => {
    const a = new SlackAdapter("slack:t");
    await a.connect({ simulator: true });
    const list = (await a.invoke("conversations_list", {})) as { channels: unknown[] };
    assert.ok(list.channels.length >= 1);
    await assert.rejects(
      () => a.invoke("post_message", { channel: "C1", text: "hi" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
    await a.disconnect();
  });

  it("HTTP loopback", async () => {
    const loop = await listenSlackLoopback();
    const a = new SlackAdapter("slack:http");
    try {
      await a.connect({ url: `http://127.0.0.1:${loop.port}` });
      const list = (await a.invoke("conversations_list", {})) as { channels: Array<{ id: string }> };
      assert.equal(list.channels[0]?.id, "Chttp");
    } finally {
      await a.disconnect();
      await loop.close();
    }
  });
});
