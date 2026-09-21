import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CassandraAdapter, listenCassandraNative } from "../src/adapters/cassandra/index.js";
import { AdapterError } from "../src/runtime/errors.js";

describe("CassandraAdapter", () => {
  it("memory CQL subset + allowWrite gate", async () => {
    const ro = new CassandraAdapter("cass.ro");
    await ro.connect({ simulator: true });
    try {
      await assert.rejects(
        () => ro.invoke("cql", { statement: "CREATE KEYSPACE app" }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
      );
    } finally {
      await ro.disconnect();
    }

    const adapter = new CassandraAdapter("cass.mem");
    await adapter.connect({ simulator: true, allowWrite: true });
    try {
      await adapter.invoke("cql", { statement: "CREATE KEYSPACE app" });
      await adapter.invoke("cql", { statement: "CREATE TABLE app.users (id text PRIMARY KEY, name text)" });
      await adapter.invoke("cql", { statement: "INSERT INTO app.users (id, name) VALUES ('1', 'Ada')" });
      const selected = (await adapter.invoke("cql", { statement: "SELECT * FROM app.users WHERE id = '1'" })) as {
        rows: Array<{ name: string }>;
      };
      assert.equal(selected.rows[0]?.name, "Ada");
      const ks = (await adapter.invoke("list_keyspaces", {})) as { keyspaces: string[] };
      assert.ok(ks.keyspaces.includes("app"));
      const tables = (await adapter.invoke("list_tables", { keyspace: "app" })) as { tables: string[] };
      assert.deepEqual(tables.tables, ["users"]);
    } finally {
      await adapter.disconnect();
    }
  });

  it("native protocol v4 loopback STARTUP/QUERY", async () => {
    const loop = await listenCassandraNative();
    const adapter = new CassandraAdapter("cass.live");
    try {
      await adapter.connect({ host: "127.0.0.1", port: loop.port, allowWrite: true, timeoutMs: 800 });
      await adapter.invoke("cql", { statement: "CREATE KEYSPACE app" });
      await adapter.invoke("cql", { statement: "CREATE TABLE app.t (id text PRIMARY KEY, v text)" });
      await adapter.invoke("cql", { statement: "INSERT INTO app.t (id, v) VALUES ('a', 'ok')" });
      const got = (await adapter.invoke("cql", { statement: "SELECT * FROM app.t" })) as { rows: Array<{ v: string }> };
      assert.equal(got.rows[0]?.v, "ok");
      const ks = (await adapter.invoke("list_keyspaces", {})) as { keyspaces: string[] };
      assert.ok(ks.keyspaces.includes("app"));
    } finally {
      await adapter.disconnect();
      await loop.close();
    }
  });
});
