import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WecomAdapter, listenWecomLoopback } from "../src/adapters/wecom/index.js";
import { AdapterError } from "../src/runtime/errors.js";

describe("wecom native adapter", () => {
  it("lists dept/users; send gated", async () => {
    const a = new WecomAdapter("wecom:t");
    await a.connect({ simulator: true });
    const depts = (await a.invoke("list_departments", {})) as { department: unknown[] };
    assert.ok(depts.department.length >= 1);
    await assert.rejects(
      () => a.invoke("send_app_message", { touser: "zhangsan", content: "hi" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
    await a.disconnect();
  });

  it("HTTP loopback", async () => {
    const loop = await listenWecomLoopback();
    const a = new WecomAdapter("wecom:http");
    try {
      await a.connect({ url: `http://127.0.0.1:${loop.port}` });
      const users = (await a.invoke("list_users", {})) as { userlist: unknown[] };
      assert.ok(users.userlist.length >= 1);
    } finally {
      await a.disconnect();
      await loop.close();
    }
  });
});
