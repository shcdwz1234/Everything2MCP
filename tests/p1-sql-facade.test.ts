import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AdapterError } from "../src/runtime/errors.js";
import { SqlAdapter } from "../src/adapters/sql/index.js";
import { assertWriteBlocked } from "./p1-helpers.js";

describe("P1 sql facade (optional)", () => {
  it("routes driver=sqlite and documents prefer protocol=sqlite", async () => {
    const adapter = new SqlAdapter("facade");
    await adapter.connect({ driver: "sqlite", filename: ":memory:", allowWrite: true });
    try {
      await adapter.invoke("execute", { sql: "CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT)" });
      const rows = (await adapter.invoke("query", { sql: "SELECT name FROM widgets WHERE 1=1" })) as {
        driver: string;
        rows: unknown[];
      };
      assert.equal(rows.driver, "sqlite");
      const health = await adapter.health();
      assert.match(health.detail ?? "", /prefer protocol=sqlite/);
    } finally {
      await adapter.disconnect();
    }
  });

  it("routes driver=postgres to the simulator", async () => {
    const adapter = new SqlAdapter("pg");
    await adapter.connect({ driver: "postgres", simulator: true, allowWrite: true });
    try {
      await adapter.invoke("execute", { sql: "CREATE TABLE t (id INTEGER, name TEXT)" });
      const q = (await adapter.invoke("query", { sql: "SELECT * FROM t" })) as { driver: string; dialect: string };
      assert.equal(q.driver, "postgres");
      assert.equal(q.dialect, "postgres");
    } finally {
      await adapter.disconnect();
    }
  });

  it("allowWrite=false and live postgres without pg", async () => {
    await assertWriteBlocked(new SqlAdapter("ro"), { driver: "postgres" });
    await assert.rejects(
      () => new SqlAdapter("pg").connect({ driver: "postgres", url: "postgres://127.0.0.1/db" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
  });
});
