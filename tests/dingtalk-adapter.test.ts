import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DingTalkAdapter, listenDingTalkLoopback } from "../src/adapters/dingtalk/index.js";
import { AdapterError } from "../src/runtime/errors.js";

describe("dingtalk native adapter", () => {
  it("probe readonly; writes gated", async () => {
    const a = new DingTalkAdapter("dingtalk:t");
    await a.connect({ simulator: true });
    const probe = (await a.invoke("probe", {})) as { users: unknown[] };
    assert.ok(probe.users.length >= 1);
    await assert.rejects(
      () => a.invoke("send_work_notice", { userid: "u1", text: "n" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
    await assert.rejects(
      () => a.invoke("send_robot", { text: "n" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
    await a.disconnect();
  });

  it("HTTP probe loopback", async () => {
    const loop = await listenDingTalkLoopback();
    const a = new DingTalkAdapter("dingtalk:http");
    try {
      await a.connect({ url: `http://127.0.0.1:${loop.port}` });
      const probe = await a.invoke("probe", {});
      assert.ok(probe);
    } finally {
      await a.disconnect();
      await loop.close();
    }
  });
});
