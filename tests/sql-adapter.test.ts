import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AdapterError } from "../src/runtime/errors.js";
import { SqlAdapter, type SqlHandle } from "../src/adapters/sql/index.js";

describe("SqlAdapter", () => {
  it("runs query/execute against in-memory sqlite", async () => {
    const adapter = new SqlAdapter("local");
    await adapter.connect({ driver: "sqlite", filename: ":memory:", allowWrite: true });
    await adapter.invoke("execute", { sql: "CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT)" });
    const inserted = (await adapter.invoke("execute", {
      sql: "INSERT INTO widgets (name) VALUES (?)",
      params: ["gizmo"],
    })) as { changes: number; lastInsertRowid?: number };
    assert.equal(inserted.changes, 1);
    const rows = (await adapter.invoke("query", { sql: "SELECT name FROM widgets" })) as {
      rows: Array<{ name: string }>;
      rowCount: number;
      driver: string;
    };
    assert.equal(rows.driver, "sqlite");
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0]?.name, "gizmo");
    const tables = (await adapter.invoke("list_tables", {})) as { tables: string[] };
    assert.ok(tables.tables.includes("widgets"));
    await adapter.disconnect();
  });

  it("pg/mysql without a package are E_UNSUPPORTED unless connectFn is injected", async () => {
    await assert.rejects(
      () => new SqlAdapter("pg").connect({ driver: "pg", url: "postgres://127.0.0.1/db" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
    const fake: SqlHandle = {
      async query() {
        return { rows: [{ n: 1 }], rowCount: 1 };
      },
      async execute() {
        return { changes: 1 };
      },
      async close() {
        /* noop */
      },
    };
    const adapter = new SqlAdapter("mysql", async () => fake);
    await adapter.connect({ driver: "mysql", url: "mysql://127.0.0.1/db" });
    const q = (await adapter.invoke("query", { sql: "SELECT 1" })) as { rows: Array<{ n: number }> };
    assert.equal(q.rows[0]?.n, 1);
    await adapter.disconnect();
  });

  it("defaults allowWrite=false and rejects unknown tools", async () => {
    const adapter = new SqlAdapter("ro");
    await assert.rejects(() => adapter.listTools(), /not connected/);
    await adapter.connect({ driver: "sqlite", filename: ":memory:" });
    try {
      await assert.rejects(
        () => adapter.invoke("execute", { sql: "CREATE TABLE widgets (id INTEGER)" }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
      );
      const read = (await adapter.invoke("query", { sql: "SELECT 1 AS n" })) as { rowCount: number };
      assert.ok(read.rowCount >= 1);
      await assert.rejects(() => adapter.invoke("__nope__", {}), (err: unknown) => err instanceof Error);
    } finally {
      await adapter.disconnect();
    }
  });
});
