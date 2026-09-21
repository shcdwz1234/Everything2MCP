import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JsonRpcAdapter, type JsonRpcTransport } from "../src/adapters/jsonrpc/index.js";

function fakeJsonRpc(): JsonRpcTransport {
  return async (payload) => {
    const handleOne = (req: Record<string, unknown>) => {
      if (req.id === undefined) return undefined;
      if (req.method === "sum") {
        const params = Array.isArray(req.params) ? req.params : [];
        const n = params.reduce((a: number, b) => a + Number(b), 0);
        return { jsonrpc: "2.0", id: req.id, result: n };
      }
      return { jsonrpc: "2.0", id: req.id, result: req.params ?? null };
    };
    if (Array.isArray(payload)) {
      return payload
        .map((item) => handleOne(item as Record<string, unknown>))
        .filter((x) => x !== undefined);
    }
    return handleOne(payload as Record<string, unknown>);
  };
}

describe("JsonRpcAdapter", () => {
  it("rejects missing url", async () => {
    await assert.rejects(() => new JsonRpcAdapter("j", () => fakeJsonRpc()).connect({}), /url/);
  });

  it("call / notify / batch over an injected HTTP transport", async () => {
    const adapter = new JsonRpcAdapter("api", () => fakeJsonRpc());
    await adapter.connect({ url: "http://127.0.0.1:8545", allowWrite: true });
    const names = (await adapter.listTools()).map((t) => t.name).sort();
    assert.deepEqual(names, ["batch", "call", "notify"]);
    const call = (await adapter.invoke("call", { method: "sum", params: [1, 2, 3] })) as {
      result: number;
      id: number;
    };
    assert.equal(call.result, 6);
    const note = (await adapter.invoke("notify", { method: "ping", params: [] })) as { notification: boolean };
    assert.equal(note.notification, true);
    const batch = (await adapter.invoke("batch", {
      calls: [
        { method: "sum", params: [4, 5] },
        { method: "log", params: ["x"], notify: true },
      ],
    })) as Array<{ result: number }>;
    assert.equal(batch.length, 1);
    assert.equal(batch[0]?.result, 9);
    await adapter.disconnect();
  });

  it("defaults allowWrite=false and blocks call/notify/batch", async () => {
    const adapter = new JsonRpcAdapter("ro", () => fakeJsonRpc());
    await adapter.connect({ url: "http://127.0.0.1:8545" });
    try {
      await assert.rejects(() => adapter.invoke("call", { method: "sum", params: [1, 2] }), /allowWrite/);
      await assert.rejects(() => adapter.invoke("notify", { method: "ping" }), /allowWrite/);
      await assert.rejects(
        () => adapter.invoke("batch", { calls: [{ method: "sum", params: [1] }] }),
        /allowWrite/,
      );
      const read = (await adapter.invoke("call", { method: "getStatus", params: [] })) as { result: unknown };
      assert.ok(read);
      const allRead = await adapter.invoke("batch", { calls: [{ method: "getStatus", params: [] }] });
      assert.ok(allRead);
    } finally {
      await adapter.disconnect();
    }
  });

  it("rejects tools before connect, unknown tools, and batch without calls", async () => {
    const adapter = new JsonRpcAdapter("api", () => fakeJsonRpc());
    await assert.rejects(() => adapter.listTools(), /not connected/);
    await adapter.connect({ url: "http://127.0.0.1:8545", allowWrite: true });
    try {
      await assert.rejects(() => adapter.invoke("nope", {}), /Unknown JSON-RPC tool/);
      await assert.rejects(() => adapter.invoke("batch", {}), /calls/);
    } finally {
      await adapter.disconnect();
    }
  });
});
