import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AdapterError } from "../src/runtime/errors.js";
import { SqliteAdapter } from "../src/adapters/sqlite/index.js";
import { assertNotConnected } from "./p1-helpers.js";

describe("P1 sqlite", () => {
  it("refuses tools before connect", async () => {
    await assertNotConnected(new SqliteAdapter("x"));
  });

  it("defaults to allowWrite=false on :memory:", async () => {
    const locked = new SqliteAdapter("ro");
    await locked.connect({ filename: ":memory:" });
    try {
      await assert.rejects(
        () => locked.invoke("execute", { sql: "CREATE TABLE t (id INTEGER)" }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
      );
      const health = await locked.health();
      assert.match(health.detail ?? "", /allowWrite=false/);
    } finally {
      await locked.disconnect();
    }
  });

  it("query/execute/list_tables/describe on real node:sqlite", async () => {
    const adapter = new SqliteAdapter("rw");
    await adapter.connect({ filename: ":memory:", allowWrite: true });
    try {
      await adapter.invoke("execute", { sql: "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)" });
      await adapter.invoke("execute", { sql: "INSERT INTO t (name) VALUES (?)", params: ["ada"] });
      const q = (await adapter.invoke("query", { sql: "SELECT name FROM t" })) as {
        dialect: string;
        rows: Array<{ name: string }>;
      };
      assert.equal(q.dialect, "sqlite");
      assert.equal(q.rows[0]?.name, "ada");
      const d = (await adapter.invoke("describe", { table: "t" })) as { columns: Array<{ name: string }> };
      assert.ok(d.columns.some((c) => c.name === "name"));
    } finally {
      await adapter.disconnect();
    }
  });

  it("persists to a real file and stays read-only by default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "e2mcp-sqlite-"));
    const filename = join(dir, "app.db");
    try {
      const writer = new SqliteAdapter("disk-w");
      await writer.connect({ filename, allowWrite: true });
      await writer.invoke("execute", { sql: "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)" });
      await writer.invoke("execute", { sql: "INSERT INTO t (name) VALUES (?)", params: ["disk"] });
      await writer.disconnect();

      const reader = new SqliteAdapter("disk-r");
      await reader.connect({ filename });
      const q = (await reader.invoke("query", { sql: "SELECT name FROM t" })) as { rows: Array<{ name: string }> };
      assert.equal(q.rows[0]?.name, "disk");
      await assert.rejects(
        () => reader.invoke("execute", { sql: "INSERT INTO t (name) VALUES ('nope')" }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
      );
      await reader.disconnect();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
