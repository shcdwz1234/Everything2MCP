import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EVENT_NODE_DATA,
  ZookeeperAdapter,
  decodeFrame,
  encodeConnectRequest,
  listenZkLoopback,
} from "../src/adapters/zookeeper/index.js";
import { AdapterError } from "../src/runtime/errors.js";

describe("ZookeeperAdapter", () => {
  it("memory get/exists; create gated by allowWrite", async () => {
    const adapter = new ZookeeperAdapter("zk.mem");
    await adapter.connect({ simulator: true });
    const got = (await adapter.invoke("get", { path: "/e2mcp" })) as { data: string };
    assert.equal(got.data, "hello zk");
    const ruok = (await adapter.invoke("ruok", {})) as { reply: string };
    assert.equal(ruok.reply, "imok");
    await assert.rejects(
      () => adapter.invoke("create", { path: "/new", data: "x" }),
      (err: unknown) => err instanceof AdapterError && /allowWrite/.test(String(err)),
    );
    await adapter.disconnect();
  });

  it("binary connect/get/create plus ruok four-letter on loopback", async () => {
    const framed = encodeConnectRequest();
    assert.ok(decodeFrame(framed)?.body.length);
    const loop = await listenZkLoopback();
    const adapter = new ZookeeperAdapter("zk.live");
    try {
      await adapter.connect({ host: "127.0.0.1", port: loop.port, allowWrite: true, timeoutMs: 1500 });
      const ruok = (await adapter.invoke("ruok", {})) as { reply: string };
      assert.match(ruok.reply, /imok/);
      const got = (await adapter.invoke("get", { path: "/e2mcp" })) as { data: string };
      assert.equal(got.data, "hello zk");
      await adapter.invoke("create", { path: "/e2mcp/child", data: "kid" });
      const kids = (await adapter.invoke("get_children", { path: "/e2mcp" })) as { children: string[] };
      assert.ok(kids.children.includes("child"));
    } finally {
      await adapter.disconnect();
      await loop.close();
    }
  });

  it("memory watch_once + multi; ACL/SASL stay E_UNSUPPORTED", async () => {
    const adapter = new ZookeeperAdapter("zk.watch");
    await adapter.connect({ simulator: true, allowWrite: true });
    try {
      const names = (await adapter.listTools()).map((t) => t.name);
      assert.ok(names.includes("watch_once"));
      assert.ok(names.includes("multi"));
      const pending = adapter.invoke("watch_once", { path: "/e2mcp", timeoutMs: 800 });
      await adapter.invoke("set", { path: "/e2mcp", data: "changed" });
      const ev = (await pending) as { type: number; path: string };
      assert.equal(ev.type, EVENT_NODE_DATA);
      assert.equal(ev.path, "/e2mcp");
      const multi = (await adapter.invoke("multi", {
        ops: [
          { op: "create", path: "/e2mcp/a", data: "1" },
          { op: "create", path: "/e2mcp/b", data: "2" },
        ],
      })) as { results: Array<{ ok: boolean; path: string }> };
      assert.equal(multi.results.length, 2);
      assert.ok(multi.results.every((r) => r.ok));
      await assert.rejects(
        () => adapter.invoke("set_acl", { path: "/e2mcp" }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED" && /ACL/.test(String(err)),
      );
      await assert.rejects(
        () => adapter.invoke("add_auth", { scheme: "sasl" }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
      );
    } finally {
      await adapter.disconnect();
    }
  });

  it("loopback one-shot watch and MULTI create", async () => {
    const loop = await listenZkLoopback();
    const watcher = new ZookeeperAdapter("zk.w");
    const writer = new ZookeeperAdapter("zk.m");
    try {
      await watcher.connect({ host: "127.0.0.1", port: loop.port, timeoutMs: 1500 });
      await writer.connect({ host: "127.0.0.1", port: loop.port, allowWrite: true, timeoutMs: 1500 });
      const pending = watcher.invoke("watch_once", { path: "/e2mcp", timeoutMs: 1500 });
      await new Promise((r) => setTimeout(r, 40));
      await writer.invoke("set", { path: "/e2mcp", data: "watched" });
      const ev = (await pending) as { type: number; path: string };
      assert.equal(ev.type, EVENT_NODE_DATA);
      const multi = (await writer.invoke("multi", {
        ops: [
          { op: "create", path: "/e2mcp/m1", data: "x" },
          { op: "create", path: "/e2mcp/m2", data: "y" },
        ],
      })) as { results: Array<{ ok: boolean }> };
      assert.equal(multi.results.length, 2);
      const kids = (await writer.invoke("get_children", { path: "/e2mcp" })) as { children: string[] };
      assert.ok(kids.children.includes("m1"));
      assert.ok(kids.children.includes("m2"));
    } finally {
      await watcher.disconnect();
      await writer.disconnect();
      await loop.close();
    }
  });
});
