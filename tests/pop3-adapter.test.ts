import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Pop3Adapter, listenPop3Loopback } from "../src/adapters/pop3/index.js";
import { AdapterError } from "../src/runtime/errors.js";

describe("Pop3Adapter", () => {
  it("memory STAT/LIST/RETR; DELE/RSET gated by allowWrite", async () => {
    const adapter = new Pop3Adapter("pop3.mem");
    await adapter.connect({ simulator: true });
    const st = (await adapter.invoke("stat", {})) as { count: number };
    assert.equal(st.count, 1);
    const listed = (await adapter.invoke("list", {})) as { messages: Array<{ id: number }> };
    assert.equal(listed.messages[0]?.id, 1);
    const got = (await adapter.invoke("retr", { id: 1 })) as { raw: string };
    assert.match(got.raw, /hello pop3/);
    await assert.rejects(
      () => adapter.invoke("dele", { id: 1 }),
      (err: unknown) => err instanceof AdapterError && /allowWrite/.test(String(err)),
    );
    await adapter.disconnect();

    const writer = new Pop3Adapter("pop3.w");
    await writer.connect({ simulator: true, allowWrite: true });
    await writer.invoke("dele", { id: 1 });
    const after = (await writer.invoke("stat", {})) as { count: number };
    assert.equal(after.count, 0);
    await writer.invoke("rset", {});
    const reset = (await writer.invoke("stat", {})) as { count: number };
    assert.equal(reset.count, 1);
    await writer.disconnect();
  });

  it("POP3 loopback STAT/LIST/RETR", async () => {
    const loop = await listenPop3Loopback();
    const adapter = new Pop3Adapter("pop3.live");
    try {
      await adapter.connect({ host: "127.0.0.1", port: loop.port, timeoutMs: 1500 });
      const st = (await adapter.invoke("stat", {})) as { count: number; octets: number };
      assert.equal(st.count, 1);
      assert.ok(st.octets > 0);
      const listed = (await adapter.invoke("list", {})) as { messages: Array<{ id: number }> };
      assert.equal(listed.messages.length, 1);
      const got = (await adapter.invoke("retr", { id: 1 })) as { raw: string };
      assert.match(got.raw, /hello pop3/);
    } finally {
      await adapter.disconnect();
      await loop.close();
    }
  });

  it("POP3 loopback DELE is write-gated", async () => {
    const loop = await listenPop3Loopback();
    const ro = new Pop3Adapter("pop3.ro");
    const writer = new Pop3Adapter("pop3.dele");
    try {
      await ro.connect({ host: "127.0.0.1", port: loop.port, timeoutMs: 1500 });
      await assert.rejects(
        () => ro.invoke("dele", { id: 1 }),
        (err: unknown) => err instanceof AdapterError && /allowWrite/.test(String(err)),
      );
      await ro.disconnect();
      await writer.connect({ host: "127.0.0.1", port: loop.port, allowWrite: true, timeoutMs: 1500 });
      await writer.invoke("dele", { id: 1 });
      const st = (await writer.invoke("stat", {})) as { count: number };
      assert.equal(st.count, 0);
    } finally {
      await writer.disconnect();
      await loop.close();
    }
  });
});
