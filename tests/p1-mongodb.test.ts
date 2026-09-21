import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AdapterError } from "../src/runtime/errors.js";
import { MongodbAdapter, createMemoryMongo, listenMongoOpMsg, encodeOpMsg, decodeOpMsg, encodeBson, decodeBson } from "../src/adapters/mongodb/index.js";

describe("P1 mongodb", () => {
  it("refuses tools before connect", async () => {
    const adapter = new MongodbAdapter("x");
    await assert.rejects(
      () => adapter.listTools(),
      (err: unknown) => err instanceof AdapterError && err.code === "E_NOT_CONNECTED",
    );
  });

  it("find/insert with allowWrite gate", async () => {
    const adapter = new MongodbAdapter("docs");
    await adapter.connect({ simulator: true, allowWrite: true });
    try {
      await adapter.invoke("insert_one", { collection: "users", document: { name: "Ada" } });
      const found = (await adapter.invoke("find", { collection: "users", filter: { name: "Ada" } })) as {
        count: number;
      };
      assert.equal(found.count, 1);
      const cols = (await adapter.invoke("list_collections", {})) as { collections: string[] };
      assert.ok(cols.collections.includes("users"));
      const desc = (await adapter.invoke("describe", { collection: "users" })) as { count: number };
      assert.equal(desc.count, 1);
    } finally {
      await adapter.disconnect();
    }
  });

  it("allowWrite=false blocks insert_one", async () => {
    const ro = new MongodbAdapter("ro");
    await ro.connect({ simulator: true });
    try {
      await assert.rejects(
        () => ro.invoke("insert_one", { collection: "users", document: { name: "Bob" } }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
      );
    } finally {
      await ro.disconnect();
    }
  });

  it("OP_MSG hello/find/insert on loopback; codec round-trips", async () => {
    const bson = encodeBson({ hello: 1, name: "Ada" });
    assert.equal(decodeBson(bson).value.name, "Ada");
    const msg = encodeOpMsg({ find: "users", filter: { name: "Ada" }, $db: "test" }, 7);
    assert.equal(decodeOpMsg(msg).doc.find, "users");

    const mem = createMemoryMongo();
    await mem.insertOne("users", { name: "Ada", _id: "1" });
    const loop = await listenMongoOpMsg(mem);
    const adapter = new MongodbAdapter("mongo.wire");
    try {
      await adapter.connect({ url: `mongodb://127.0.0.1:${loop.port}/test`, allowWrite: true, timeoutMs: 1500 });
      const found = (await adapter.invoke("find", { collection: "users", filter: { name: "Ada" } })) as { count: number };
      assert.equal(found.count, 1);
      await adapter.invoke("insert_one", { collection: "users", document: { name: "Bob" } });
      const cols = (await adapter.invoke("list_collections", {})) as { collections: string[] };
      assert.ok(cols.collections.includes("users"));
    } finally {
      await adapter.disconnect();
      await loop.close();
    }
  });
});
