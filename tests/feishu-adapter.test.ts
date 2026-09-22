import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FeishuAdapter, listenFeishuLoopback } from "../src/adapters/feishu/index.js";
import { AdapterError } from "../src/runtime/errors.js";

describe("feishu native adapter", () => {
  it("lists chats; send_message gated when allowWrite=false", async () => {
    const a = new FeishuAdapter("feishu:t");
    await a.connect({ simulator: true });
    const chats = (await a.invoke("list_chats", {})) as { chats: unknown[] };
    assert.ok(chats.chats.length >= 1);
    await assert.rejects(
      () => a.invoke("send_message", { chat_id: "oc_demo", text: "hi" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
    await a.disconnect();
  });

  it("HTTP loopback send with allowWrite", async () => {
    const loop = await listenFeishuLoopback();
    const a = new FeishuAdapter("feishu:http");
    try {
      await a.connect({ url: `http://127.0.0.1:${loop.port}`, allowWrite: true });
      const sent = (await a.invoke("send_message", { chat_id: "oc_http", text: "hi" })) as { data?: { chat_id?: string } };
      assert.equal(sent.data?.chat_id, "oc_http");
    } finally {
      await a.disconnect();
      await loop.close();
    }
  });
});
