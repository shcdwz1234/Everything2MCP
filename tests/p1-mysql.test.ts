import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AdapterError } from "../src/runtime/errors.js";
import { MysqlAdapter } from "../src/adapters/mysql/index.js";
import { createAdapter, registerBuiltinAdapters } from "../src/adapters/index.js";
import { createMemorySqlHandle } from "../src/adapters/sql/common.js";
import { assertNotConnected, assertRelationalRoundTrip, assertWriteBlocked } from "./p1-helpers.js";

registerBuiltinAdapters();

describe("P1 mysql / mariadb", () => {
  it("refuses tools before connect", async () => {
    await assertNotConnected(new MysqlAdapter("x"));
  });

  it("simulator round-trip with dialect=mysql", async () => {
    await assertRelationalRoundTrip(new MysqlAdapter("my"), "mysql");
  });

  it("allowWrite=false blocks execute", async () => {
    await assertWriteBlocked(new MysqlAdapter("ro"));
  });

  it("live url without a driver is E_UNSUPPORTED", async () => {
    await assert.rejects(
      () => new MysqlAdapter("live").connect({ url: "mysql://127.0.0.1/db" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
  });

  it("injected handle plus mariadb alias", async () => {
    const handle = createMemorySqlHandle("mysql");
    const adapter = new MysqlAdapter("inj", async () => handle);
    await adapter.connect({ url: "mysql://127.0.0.1/db", allowWrite: true });
    try {
      await adapter.invoke("execute", { sql: "CREATE TABLE t (id INTEGER, name TEXT)" });
      const health = await adapter.health();
      assert.match(health.detail ?? "", /MariaDB/);
    } finally {
      await adapter.disconnect();
    }
    assert.equal(createAdapter("mariadb", "a").protocol, "mysql");
  });
});
