import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CoapAdapter, type CoapHandle } from "../src/adapters/coap/index.js";

function fakeCoap(): CoapHandle {
  const store = new Map<string, string>();
  const observers = new Set<string>();
  const waiters = new Map<string, Array<(payload: string) => void>>();
  return {
    async request(method, pathname, payload, confirmable = true) {
      if (method === "PUT" || method === "POST") {
        store.set(pathname, payload ?? "");
        const w = waiters.get(pathname)?.shift();
        if (w) w(payload ?? "");
        return { code: method === "POST" ? "2.01" : "2.04", payload: payload ?? "", confirmable, type: confirmable ? "CON" : "NON" };
      }
      if (method === "DELETE") {
        store.delete(pathname);
        return { code: "2.02", payload: "", confirmable, type: confirmable ? "CON" : "NON" };
      }
      return {
        code: "2.05",
        payload: store.get(pathname) ?? "",
        confirmable,
        type: confirmable ? "CON" : "NON",
      };
    },
    observeOnce(pathname, ms, confirmable = true) {
      observers.add(pathname);
      if (store.has(pathname)) {
        return Promise.resolve({
          code: "2.05",
          payload: store.get(pathname) ?? "",
          confirmable,
          type: "CON",
          observe: 0,
        });
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for CoAP Observe on ${pathname}`)), ms);
        const list = waiters.get(pathname) ?? [];
        list.push((payload) => {
          clearTimeout(timer);
          resolve({ code: "2.05", payload, confirmable, type: "CON", observe: 1 });
        });
        waiters.set(pathname, list);
      });
    },
    async cancelObserve(pathname) {
      observers.delete(pathname);
    },
    async close() {
      store.clear();
      observers.clear();
    },
  };
}

describe("CoapAdapter", () => {
  it("rejects missing host", async () => {
    await assert.rejects(() => new CoapAdapter("c", async () => fakeCoap()).connect({}), /host/);
  });

  it("CRUD plus Observe once/cancel against a fake datagram client", async () => {
    const adapter = new CoapAdapter("iot", async () => fakeCoap());
    await adapter.connect({ host: "127.0.0.1", port: 5683, allowWrite: true });
    const names = (await adapter.listTools()).map((t) => t.name).sort();
    assert.ok(names.includes("observe_once"));
    assert.ok(names.includes("observe_cancel"));
    const pending = adapter.invoke("observe_once", { path: "/temp", timeoutMs: 500 });
    await new Promise((r) => setImmediate(r));
    await adapter.invoke("put", { path: "/temp", payload: "21" });
    const note = (await pending) as { payload: string; observe: number };
    assert.equal(note.payload, "21");
    const cancel = (await adapter.invoke("observe_cancel", { path: "/temp" })) as { cancelled: boolean };
    assert.equal(cancel.cancelled, true);
    const health = await adapter.health();
    assert.match(health.detail ?? "", /DTLS no/);
    await adapter.disconnect();
  });

  it("defaults allowWrite=false and blocks put/post/delete; get still works", async () => {
    const adapter = new CoapAdapter("ro", async () => fakeCoap());
    await adapter.connect({ host: "127.0.0.1", port: 5683 });
    try {
      await assert.rejects(() => adapter.invoke("put", { path: "/res", payload: "x" }), /allowWrite/);
      await assert.rejects(() => adapter.invoke("post", { path: "/res", payload: "x" }), /allowWrite/);
      await assert.rejects(() => adapter.invoke("delete", { path: "/res" }), /allowWrite/);
      const got = (await adapter.invoke("get", { path: "/res" })) as { payload: string };
      assert.equal(got.payload, "");
    } finally {
      await adapter.disconnect();
    }
  });

  it("rejects tools before connect, unknown tools, and GET after PUT", async () => {
    const adapter = new CoapAdapter("iot", async () => fakeCoap());
    await assert.rejects(() => adapter.listTools(), /not connected/);
    await adapter.connect({ host: "127.0.0.1", port: 5683, allowWrite: true });
    try {
      await assert.rejects(() => adapter.invoke("nope", {}), /Unknown CoAP tool/);
      await adapter.invoke("put", { path: "/res", payload: "ok" });
      const got = (await adapter.invoke("get", { path: "/res" })) as { payload: string };
      assert.equal(got.payload, "ok");
    } finally {
      await adapter.disconnect();
    }
  });
});
