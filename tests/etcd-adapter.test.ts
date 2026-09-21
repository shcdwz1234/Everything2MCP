import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { EtcdAdapter } from "../src/adapters/etcd/index.js";
import { AdapterError } from "../src/runtime/errors.js";

describe("EtcdAdapter", () => {
  it("memory range / put gated by allowWrite", async () => {
    const adapter = new EtcdAdapter("etcd.mem");
    await adapter.connect({ simulator: true });
    const empty = (await adapter.invoke("range", { key: "a" })) as { kvs: unknown[] };
    assert.deepEqual(empty.kvs, []);
    await assert.rejects(
      () => adapter.invoke("put", { key: "a", value: "1" }),
      (err: unknown) => err instanceof AdapterError && /allowWrite/.test(String(err)),
    );
    await adapter.disconnect();

    const writer = new EtcdAdapter("etcd.w");
    await writer.connect({ simulator: true, allowWrite: true });
    await writer.invoke("put", { key: "app/x", value: "1" });
    await writer.invoke("put", { key: "app/y", value: "2" });
    const pref = (await writer.invoke("range", { key: "app/", prefix: true })) as { kvs: Array<{ key: string }> };
    assert.deepEqual(pref.kvs.map((k) => k.key), ["app/x", "app/y"]);
    const del = (await writer.invoke("delete", { key: "app/x" })) as { deleted: number };
    assert.equal(del.deleted, 1);
    await writer.disconnect();
  });

  it("HTTP /v3/kv against loopback", async () => {
    const store = new Map<string, string>();
    const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
    const fromB64 = (s: string) => Buffer.from(s, "base64").toString("utf8");
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, string>;
        res.setHeader("content-type", "application/json");
        if (req.url === "/version") {
          res.end(JSON.stringify({ etcdserver: "3.5.0-test" }));
          return;
        }
        if (req.url === "/v3/kv/put") {
          store.set(fromB64(body.key), fromB64(body.value));
          res.end("{}");
          return;
        }
        if (req.url === "/v3/kv/range") {
          const key = fromB64(body.key);
          const value = store.get(key);
          res.end(JSON.stringify({ kvs: value === undefined ? [] : [{ key: b64(key), value: b64(value) }] }));
          return;
        }
        if (req.url === "/v3/kv/deleterange") {
          const ok = store.delete(fromB64(body.key));
          res.end(JSON.stringify({ deleted: ok ? 1 : 0 }));
          return;
        }
        res.statusCode = 404;
        res.end("{}");
      });
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
    const adapter = new EtcdAdapter("etcd.http");
    try {
      await adapter.connect({ url: `http://127.0.0.1:${port}`, allowWrite: true });
      await adapter.invoke("put", { key: "k", value: "v" });
      const got = (await adapter.invoke("range", { key: "k" })) as { kvs: Array<{ value: string }> };
      assert.equal(got.kvs[0]?.value, "v");
    } finally {
      await adapter.disconnect();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
