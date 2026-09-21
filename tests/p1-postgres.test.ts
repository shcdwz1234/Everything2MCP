import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AdapterError } from "../src/runtime/errors.js";
import { PostgresAdapter } from "../src/adapters/postgres/index.js";
import { createAdapter, registerBuiltinAdapters } from "../src/adapters/index.js";
import { createMemorySqlHandle } from "../src/adapters/sql/common.js";
import { assertNotConnected, assertRelationalRoundTrip, assertWriteBlocked } from "./p1-helpers.js";

registerBuiltinAdapters();

describe("P1 postgres", () => {
  it("refuses tools before connect", async () => {
    await assertNotConnected(new PostgresAdapter("x"));
  });

  it("simulator round-trip with dialect=postgres", async () => {
    await assertRelationalRoundTrip(new PostgresAdapter("pg"), "postgres");
  });

  it("allowWrite=false blocks execute", async () => {
    await assertWriteBlocked(new PostgresAdapter("ro"));
  });

  it("live url without pg is E_UNSUPPORTED (no Docker SQL CI in this environment)", async () => {
    await assert.rejects(
      () => new PostgresAdapter("live").connect({ url: "postgres://127.0.0.1/db" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
  });

  it("injected handle is the CI live-like path", async () => {
    const handle = createMemorySqlHandle("postgres");
    const adapter = new PostgresAdapter("inj", async () => handle);
    await adapter.connect({ url: "postgres://127.0.0.1/db", allowWrite: true });
    try {
      await adapter.invoke("execute", { sql: "CREATE TABLE t (id INTEGER, name TEXT)" });
      const q = (await adapter.invoke("query", { sql: "SELECT * FROM t" })) as { dialect: string };
      assert.equal(q.dialect, "postgres");
      const health = await adapter.health();
      assert.match(health.detail ?? "", /mode=injected/);
    } finally {
      await adapter.disconnect();
    }
  });

  it("pg / postgresql aliases construct PostgresAdapter", () => {
    assert.equal(createAdapter("pg", "a").protocol, "postgres");
    assert.equal(createAdapter("postgresql", "a").protocol, "postgres");
  });
});
