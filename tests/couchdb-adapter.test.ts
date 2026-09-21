import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CouchdbAdapter, listenCouchLoopback } from "../src/adapters/couchdb/index.js";
import { AdapterError } from "../src/runtime/errors.js";

describe("CouchdbAdapter", () => {
  it("memory _all_docs / get / put gated by allowWrite", async () => {
    const ro = new CouchdbAdapter("couch.ro");
    await ro.connect({ simulator: true });
    try {
      await assert.rejects(
        () => ro.invoke("put", { db: "docs", id: "1", document: { n: 1 } }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
      );
    } finally {
      await ro.disconnect();
    }

    const adapter = new CouchdbAdapter("couch.mem");
    await adapter.connect({ simulator: true, allowWrite: true });
    try {
      await adapter.invoke("put", { db: "docs", id: "1", document: { title: "hi" } });
      const got = (await adapter.invoke("get", { db: "docs", id: "1" })) as { title: string };
      assert.equal(got.title, "hi");
      const listed = (await adapter.invoke("all_docs", { db: "docs" })) as { rows: Array<{ id: string }> };
      assert.equal(listed.rows[0]?.id, "1");
      const dbs = (await adapter.invoke("list_dbs", {})) as { dbs: string[] };
      assert.ok(dbs.dbs.includes("docs"));
    } finally {
      await adapter.disconnect();
    }
  });

  it("HTTP loopback _all_docs / get / put", async () => {
    const loop = await listenCouchLoopback();
    const adapter = new CouchdbAdapter("couch.http");
    try {
      await adapter.connect({ url: `http://127.0.0.1:${loop.port}`, allowWrite: true });
      await adapter.invoke("put", { db: "docs", id: "a", document: { n: 2 } });
      const got = (await adapter.invoke("get", { db: "docs", id: "a" })) as { n: number };
      assert.equal(got.n, 2);
    } finally {
      await adapter.disconnect();
      await loop.close();
    }
  });
});
