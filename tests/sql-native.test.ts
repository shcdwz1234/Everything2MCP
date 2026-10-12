import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AdapterError } from "../src/runtime/errors.js";
import { MysqlAdapter } from "../src/adapters/mysql/index.js";
import { PostgresAdapter } from "../src/adapters/postgres/index.js";
import { SqliteAdapter } from "../src/adapters/sqlite/index.js";
import {
  connectBetterSqliteNative,
  connectMysqlNative,
  connectPostgresNative,
  nativeSqlOptions,
  wantsNativeDriver,
} from "../src/adapters/sql/native.js";

describe("SQL native optional drivers", () => {
  it("wantsNativeDriver reads native:true and driver=native", () => {
    assert.equal(wantsNativeDriver({ native: true }), true);
    assert.equal(wantsNativeDriver({ driver: "native" }), true);
    assert.equal(wantsNativeDriver({ engine: "native" }), true);
    assert.equal(wantsNativeDriver({ driver: "postgres" }), false);
    assert.equal(wantsNativeDriver({}), false);
  });

  it("postgres native without url is E_INVALID_CONFIG", async () => {
    await assert.rejects(
      () => new PostgresAdapter("n").connect({ native: true }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_INVALID_CONFIG" && /url/.test(err.message),
    );
    await assert.rejects(
      () => new PostgresAdapter("n").connect({ driver: "native" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_INVALID_CONFIG",
    );
  });

  it("postgres/mysql/sqlite native without the optional package is E_UNSUPPORTED", async () => {
    await assert.rejects(
      () => new PostgresAdapter("n").connect({ native: true, url: "postgres://127.0.0.1/db" }),
      (err: unknown) =>
        err instanceof AdapterError && err.code === "E_UNSUPPORTED" && /optional 'pg'|npm i pg/.test(err.message),
    );
    await assert.rejects(
      () => new MysqlAdapter("n").connect({ driver: "native", url: "mysql://127.0.0.1/db" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED" && /mysql2/.test(err.message),
    );
    // better-sqlite3 is a hard dependency (Node 18/20 lack node:sqlite). Probe missing via loader.
    await assert.rejects(
      () => connectBetterSqliteNative({ filename: ":memory:" }, async () => undefined),
      (err: unknown) =>
        err instanceof AdapterError && err.code === "E_UNSUPPORTED" && /better-sqlite3/.test(err.message),
    );
    // When the package is present, native:true must succeed.
    const nativeSqlite = new SqliteAdapter("n");
    await nativeSqlite.connect({ native: true, filename: ":memory:", allowWrite: true });
    try {
      const health = await nativeSqlite.health();
      assert.match(health.detail ?? "", /mode=native/);
      await nativeSqlite.invoke("execute", { sql: "CREATE TABLE t (id INTEGER)" });
    } finally {
      await nativeSqlite.disconnect();
    }
  });

  it("CI default stays simulator / node:sqlite (or better-sqlite3 fallback) when native is omitted", async () => {
    const pg = new PostgresAdapter("sim");
    await pg.connect({ simulator: true });
    try {
      const health = await pg.health();
      assert.match(health.detail ?? "", /mode=simulator/);
    } finally {
      await pg.disconnect();
    }
    const sqlite = new SqliteAdapter("node");
    await sqlite.connect({ filename: ":memory:" });
    try {
      const health = await sqlite.health();
      // Node >= 22.5 → node-sqlite; Node 18/20 → better-sqlite3 fallback.
      assert.match(health.detail ?? "", /mode=(node-sqlite|better-sqlite3)/);
    } finally {
      await sqlite.disconnect();
    }
  });

  it("maps a fake pg Client through connectPostgresNative", async () => {
    const handle = await connectPostgresNative({ url: "postgres://127.0.0.1/db" }, async () => ({
      Client: class {
        async connect() {
          /* fake */
        }
        async query(sql: string) {
          if (/pg_tables/i.test(sql)) return { rows: [{ name: "t" }], rowCount: 1 };
          if (/information_schema/i.test(sql)) return { rows: [{ name: "id", type: "integer" }], rowCount: 1 };
          return { rows: [{ n: 1 }], rowCount: 1 };
        }
        async end() {
          /* fake */
        }
      },
    }));
    try {
      const q = await handle.query("SELECT 1 AS n");
      assert.deepEqual(q.rows, [{ n: 1 }]);
      assert.deepEqual(await handle.listTables(), ["t"]);
      const desc = await handle.describe("t");
      assert.equal(desc.columns[0]?.name, "id");
    } finally {
      await handle.close();
    }
  });

  it("maps a fake mysql2 connection through connectMysqlNative", async () => {
    const handle = await connectMysqlNative({ url: "mysql://127.0.0.1/db" }, async () => ({
      createConnection: async () => ({
        async query(sql: string) {
          if (/SHOW TABLES/i.test(sql)) return [[{ Tables_in_db: "t" }]];
          if (/SHOW COLUMNS/i.test(sql)) return [[{ Field: "id", Type: "int" }]];
          return [[{ n: 2 }]];
        },
        async end() {
          /* fake */
        },
      }),
    }));
    try {
      const q = await handle.query("SELECT 2 AS n");
      assert.deepEqual(q.rows, [{ n: 2 }]);
      assert.deepEqual(await handle.listTables(), ["t"]);
      assert.equal((await handle.describe("t")).columns[0]?.type, "int");
    } finally {
      await handle.close();
    }
  });

  it("nativeSqlOptions reads pool / ssl / statement timeout", () => {
    assert.deepEqual(nativeSqlOptions({}), { ssl: false, poolMax: 1, statementTimeoutMs: 0 });
    assert.deepEqual(nativeSqlOptions({ ssl: true, poolMax: 4, statementTimeoutMs: 50 }), {
      ssl: { rejectUnauthorized: true },
      poolMax: 4,
      statementTimeoutMs: 50,
    });
    assert.deepEqual(nativeSqlOptions({ rejectUnauthorized: false, pool: { max: 8 }, cancelMs: 20 }), {
      ssl: { rejectUnauthorized: false },
      poolMax: 8,
      statementTimeoutMs: 20,
    });
  });

  it("postgres native uses Pool + ssl when poolMax>1", async () => {
    const seen: Array<Record<string, unknown>> = [];
    let ended = 0;
    const handle = await connectPostgresNative(
      { url: "postgres://127.0.0.1/db", poolMax: 4, ssl: true },
      async () => ({
        Pool: class {
          constructor(cfg: Record<string, unknown>) {
            seen.push(cfg);
          }
          async query(sql: string) {
            if (/pg_tables/i.test(sql)) return { rows: [{ name: "t" }], rowCount: 1 };
            return { rows: [{ n: 4 }], rowCount: 1 };
          }
          async end() {
            ended += 1;
          }
        },
        Client: class {
          async connect() {
            throw new Error("Client must not be used when Pool is selected");
          }
          async query() {
            throw new Error("Client.query");
          }
          async end() {
            /* unused */
          }
        },
      }),
    );
    try {
      assert.equal(seen.length, 1);
      assert.equal(seen[0]?.max, 4);
      assert.deepEqual(seen[0]?.ssl, { rejectUnauthorized: true });
      const q = await handle.query("SELECT 4 AS n");
      assert.deepEqual(q.rows, [{ n: 4 }]);
      assert.deepEqual(await handle.listTables(), ["t"]);
    } finally {
      await handle.close();
    }
    assert.equal(ended, 1);
  });

  it("postgres native statementTimeoutMs cancels a hanging query", async () => {
    const handle = await connectPostgresNative(
      { url: "postgres://127.0.0.1/db", statementTimeoutMs: 30 },
      async () => ({
        Client: class {
          async connect() {
            /* fake */
          }
          async query() {
            return new Promise<{ rows: unknown[]; rowCount: number }>(() => {
              /* hang */
            });
          }
          async end() {
            /* fake */
          }
        },
      }),
    );
    try {
      await assert.rejects(
        () => handle.query("SELECT pg_sleep(9)"),
        (err: unknown) =>
          err instanceof AdapterError && err.code === "E_TIMEOUT" && /timed out|cancel/i.test(err.message),
      );
    } finally {
      await handle.close();
    }
  });

  it("mysql native uses createPool when poolMax>1", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const handle = await connectMysqlNative({ url: "mysql://127.0.0.1/db", poolMax: 3, ssl: true }, async () => ({
      createPool: (cfg: Record<string, unknown>) => {
        seen.push(cfg);
        return {
          async query(sql: string) {
            if (/SHOW TABLES/i.test(sql)) return [[{ Tables_in_db: "t" }]];
            return [[{ n: 5 }]];
          },
          async end() {
            /* fake */
          },
        };
      },
    }));
    try {
      assert.equal(seen[0]?.connectionLimit, 3);
      assert.deepEqual(seen[0]?.ssl, { rejectUnauthorized: true });
      const q = await handle.query("SELECT 5 AS n");
      assert.deepEqual(q.rows, [{ n: 5 }]);
      assert.deepEqual(await handle.listTables(), ["t"]);
    } finally {
      await handle.close();
    }
  });

  it("maps a fake better-sqlite3 Database through connectBetterSqliteNative", async () => {
    const handle = await connectBetterSqliteNative({ filename: ":memory:" }, async () => ({
      default: class {
        prepare(sql: string) {
          return {
            all: () => {
              if (/sqlite_master/i.test(sql)) return [{ name: "t" }];
              if (/PRAGMA table_info/i.test(sql)) return [{ name: "id", type: "INTEGER", pk: 1 }];
              return [{ n: 3 }];
            },
            run: () => ({ changes: 1, lastInsertRowid: 1 }),
          };
        }
        close() {
          /* fake */
        }
      },
    }));
    try {
      const q = await handle.query("SELECT 3 AS n");
      assert.deepEqual(q.rows, [{ n: 3 }]);
      assert.equal((await handle.execute("INSERT INTO t VALUES (1)")).changes, 1);
      assert.deepEqual(await handle.listTables(), ["t"]);
    } finally {
      await handle.close();
    }
  });
});
