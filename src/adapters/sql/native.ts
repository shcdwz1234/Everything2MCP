import { AdapterError } from "../../runtime/errors.js";
import { stringField } from "../helpers.js";
import type { RelationalHandle } from "./common.js";
import { sqliteValues } from "./common.js";

export type OptionalLoader = (name: string) => Promise<Record<string, unknown> | undefined>;

/** `native:true` or `driver:"native"` — do not confuse with sql-facade `driver: postgres|mysql`. */
export function wantsNativeDriver(config: Record<string, unknown>): boolean {
  if (config.native === true) return true;
  const driver = stringField(config, "driver")?.toLowerCase();
  const engine = stringField(config, "engine")?.toLowerCase();
  return driver === "native" || engine === "native";
}

export async function importOptional(name: string): Promise<Record<string, unknown> | undefined> {
  try {
    const dyn = Function("n", "return import(n)") as (n: string) => Promise<Record<string, unknown>>;
    return await dyn(name);
  } catch {
    return undefined;
  }
}

export function missingOptionalDriver(protocol: string, pkg: string): AdapterError {
  return new AdapterError(
    "E_UNSUPPORTED",
    `${protocol} native path needs optional '${pkg}' (npm i ${pkg}). CI stays on simulator:true / node:sqlite. Inject connectFn to test without installing the package.`,
    { protocol },
  );
}

export interface NativeSqlOptions {
  ssl: boolean | { rejectUnauthorized: boolean };
  poolMax: number;
  statementTimeoutMs: number;
}

export function nativeSqlOptions(config: Record<string, unknown>): NativeSqlOptions {
  let ssl: NativeSqlOptions["ssl"] = false;
  if (config.ssl === true) ssl = { rejectUnauthorized: true };
  else if (config.ssl && typeof config.ssl === "object") {
    const rec = config.ssl as { rejectUnauthorized?: boolean };
    ssl = { rejectUnauthorized: rec.rejectUnauthorized !== false };
  } else if (config.rejectUnauthorized === false) ssl = { rejectUnauthorized: false };
  const poolRaw = typeof config.poolMax === "number" ? config.poolMax : Number((config.pool as { max?: number } | undefined)?.max);
  const poolMax = Number.isFinite(poolRaw) && poolRaw > 0 ? Math.floor(poolRaw) : 1;
  const timeoutRaw = typeof config.statementTimeoutMs === "number" ? config.statementTimeoutMs : Number(config.cancelMs);
  const statementTimeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 0;
  return { ssl, poolMax, statementTimeoutMs };
}

async function withStatementTimeout<T>(
  protocol: string,
  ms: number,
  run: () => Promise<T>,
  cancel?: () => Promise<void> | void,
): Promise<T> {
  if (!ms) return run();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          void cancel?.();
          reject(
            new AdapterError("E_TIMEOUT", `${protocol} statement timed out after ${ms}ms (cancel requested)`, {
              protocol,
            }),
          );
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function requireUrl(config: Record<string, unknown>, protocol: string): string {
  const url = stringField(config, "url") ?? stringField(config, "dsn");
  if (!url) {
    throw new AdapterError(
      "E_INVALID_CONFIG",
      `${protocol} native path requires config.url (and optional '${protocol === "mysql" ? "mysql2" : "pg"}'). CI: omit url or set simulator:true.`,
      { protocol },
    );
  }
  return url;
}

interface PgClient {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows?: unknown[]; rowCount?: number }>;
  end(): Promise<void>;
}

type PgClientCfg = {
  connectionString: string;
  ssl?: boolean | { rejectUnauthorized: boolean };
  statement_timeout?: number;
};

type PgClientCtor = new (cfg: PgClientCfg) => PgClient;

interface PgPool {
  query(sql: string, params?: unknown[]): Promise<{ rows?: unknown[]; rowCount?: number }>;
  end(): Promise<void>;
}

type PgPoolCtor = new (cfg: PgClientCfg & { max?: number }) => PgPool;

function pickPgClient(mod: Record<string, unknown> | undefined): PgClientCtor | undefined {
  if (!mod) return undefined;
  if (typeof mod.Client === "function") return mod.Client as PgClientCtor;
  const def = mod.default as { Client?: PgClientCtor } | undefined;
  if (def && typeof def.Client === "function") return def.Client;
  return undefined;
}

function pickPgPool(mod: Record<string, unknown> | undefined): PgPoolCtor | undefined {
  if (!mod) return undefined;
  if (typeof mod.Pool === "function") return mod.Pool as PgPoolCtor;
  const def = mod.default as { Pool?: PgPoolCtor } | undefined;
  if (def && typeof def.Pool === "function") return def.Pool;
  return undefined;
}

export async function connectPostgresNative(
  config: Record<string, unknown>,
  loader: OptionalLoader = importOptional,
): Promise<RelationalHandle> {
  const url = requireUrl(config, "postgres");
  const opts = nativeSqlOptions(config);
  const mod = await loader("pg");
  const Client = pickPgClient(mod);
  const Pool = pickPgPool(mod);
  if (!Client && !Pool) throw missingOptionalDriver("postgres", "pg");
  const cfg: PgClientCfg & { max?: number } = {
    connectionString: url,
    ...(opts.ssl ? { ssl: opts.ssl } : {}),
    ...(opts.statementTimeoutMs ? { statement_timeout: opts.statementTimeoutMs } : {}),
    ...(opts.poolMax > 1 ? { max: opts.poolMax } : {}),
  };
  const pool = opts.poolMax > 1 && Pool ? new Pool(cfg) : undefined;
  const client = !pool && Client ? new Client(cfg) : undefined;
  if (client) await client.connect();
  const q = pool ?? client;
  if (!q) throw missingOptionalDriver("postgres", "pg");
  let cancelled = 0;
  const run = (sql: string, params: unknown[] = []) =>
    withStatementTimeout(
      "postgres",
      opts.statementTimeoutMs,
      () => q.query(sql, params),
      () => {
        cancelled += 1;
      },
    );
  return {
    async query(sql, params = []) {
      const res = await run(sql, params);
      const rows = Array.isArray(res.rows) ? res.rows : [];
      return { rows, rowCount: typeof res.rowCount === "number" ? res.rowCount : rows.length };
    },
    async execute(sql, params = []) {
      const res = await run(sql, params);
      return { changes: typeof res.rowCount === "number" ? res.rowCount : 0 };
    },
    async listTables() {
      const res = await run(
        "SELECT tablename AS name FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY 1",
      );
      return (res.rows ?? []).map((r) => String((r as { name?: string }).name ?? "")).filter(Boolean);
    },
    async describe(table) {
      const res = await run(
        "SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position",
        [table],
      );
      return {
        table,
        columns: (res.rows ?? []).map((r) => ({
          name: String((r as { name?: string }).name ?? ""),
          type: String((r as { type?: string }).type ?? ""),
        })),
      };
    },
    async close() {
      if (pool) await pool.end();
      else if (client) await client.end();
    },
  };
}

interface Mysql2Conn {
  query(sql: string, params?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
}

type MysqlCreateFn = (urlOrCfg: string | Record<string, unknown>) => Promise<Mysql2Conn> | Mysql2Conn;
type MysqlPoolFn = (cfg: Record<string, unknown>) => Mysql2Conn;

function pickMysqlCreate(mod: Record<string, unknown> | undefined): MysqlCreateFn | undefined {
  if (!mod) return undefined;
  const direct = mod.createConnection;
  if (typeof direct === "function") return direct as MysqlCreateFn;
  const def = mod.default as { createConnection?: MysqlCreateFn } | undefined;
  if (def && typeof def.createConnection === "function") return def.createConnection;
  return undefined;
}

function pickMysqlPool(mod: Record<string, unknown> | undefined): MysqlPoolFn | undefined {
  if (!mod) return undefined;
  const direct = mod.createPool;
  if (typeof direct === "function") return direct as MysqlPoolFn;
  const def = mod.default as { createPool?: MysqlPoolFn } | undefined;
  if (def && typeof def.createPool === "function") return def.createPool;
  return undefined;
}

function mysqlQueryResult(raw: unknown): { rows: unknown[]; changes: number } {
  if (Array.isArray(raw)) {
    const first = raw[0];
    if (Array.isArray(first)) {
      return { rows: first, changes: first.length };
    }
    if (first && typeof first === "object" && "affectedRows" in first) {
      return { rows: [], changes: Number((first as { affectedRows?: number }).affectedRows ?? 0) };
    }
  }
  if (raw && typeof raw === "object") {
    const rec = raw as { rows?: unknown[]; affectedRows?: number; rowCount?: number };
    if (Array.isArray(rec.rows)) {
      return { rows: rec.rows, changes: typeof rec.affectedRows === "number" ? rec.affectedRows : rec.rows.length };
    }
    if (typeof rec.affectedRows === "number") return { rows: [], changes: rec.affectedRows };
    if (typeof rec.rowCount === "number") return { rows: [], changes: rec.rowCount };
  }
  return { rows: [], changes: 0 };
}

export async function connectMysqlNative(
  config: Record<string, unknown>,
  loader: OptionalLoader = importOptional,
): Promise<RelationalHandle> {
  const url = requireUrl(config, "mysql");
  const opts = nativeSqlOptions(config);
  const mod = (await loader("mysql2/promise")) ?? (await loader("mysql2"));
  const createPool = pickMysqlPool(mod);
  const create = pickMysqlCreate(mod);
  if (!create && !createPool) throw missingOptionalDriver("mysql", "mysql2");
  const poolCfg: Record<string, unknown> = {
    uri: url,
    ...(opts.ssl ? { ssl: opts.ssl } : {}),
    ...(opts.poolMax > 1 ? { connectionLimit: opts.poolMax } : {}),
  };
  const pool = opts.poolMax > 1 && createPool ? createPool(poolCfg) : undefined;
  const conn = !pool && create ? await Promise.resolve(create(url)) : undefined;
  const q = pool ?? conn;
  if (!q) throw missingOptionalDriver("mysql", "mysql2");
  const run = (sql: string, params: unknown[] = []) =>
    withStatementTimeout("mysql", opts.statementTimeoutMs, () => q.query(sql, params));
  return {
    async query(sql, params = []) {
      const parsed = mysqlQueryResult(await run(sql, params));
      return { rows: parsed.rows, rowCount: parsed.rows.length };
    },
    async execute(sql, params = []) {
      const parsed = mysqlQueryResult(await run(sql, params));
      return { changes: parsed.changes };
    },
    async listTables() {
      const parsed = mysqlQueryResult(await run("SHOW TABLES"));
      return parsed.rows
        .map((r) => {
          if (r && typeof r === "object") return String(Object.values(r as Record<string, unknown>)[0] ?? "");
          return String(r ?? "");
        })
        .filter(Boolean);
    },
    async describe(table) {
      const parsed = mysqlQueryResult(await run(`SHOW COLUMNS FROM ??`, [table]));
      return {
        table,
        columns: parsed.rows.map((r) => {
          const rec = (r ?? {}) as Record<string, unknown>;
          return {
            name: String(rec.Field ?? rec.name ?? ""),
            type: String(rec.Type ?? rec.type ?? ""),
          };
        }),
      };
    },
    async close() {
      await q.end();
    },
  };
}

type BetterSqliteCtor = new (filename: string) => {
  prepare(sql: string): {
    all: (...params: unknown[]) => unknown[];
    run: (...params: unknown[]) => { changes?: number; lastInsertRowid?: number };
  };
  close(): void;
};

function pickBetterSqlite(mod: Record<string, unknown> | undefined): BetterSqliteCtor | undefined {
  if (!mod) return undefined;
  if (typeof mod.default === "function") return mod.default as BetterSqliteCtor;
  const nested = mod.default as { default?: unknown } | undefined;
  if (nested && typeof nested.default === "function") return nested.default as BetterSqliteCtor;
  if (typeof (mod as unknown as BetterSqliteCtor) === "function") return mod as unknown as BetterSqliteCtor;
  return undefined;
}

function sqliteFilename(config: Record<string, unknown>): string {
  return (
    (typeof config.filename === "string" && config.filename.trim()) ||
    (typeof config.database === "string" && config.database.trim()) ||
    (typeof config.path === "string" && config.path.trim()) ||
    ":memory:"
  );
}

export async function connectBetterSqliteNative(
  config: Record<string, unknown>,
  loader: OptionalLoader = importOptional,
): Promise<RelationalHandle> {
  const Database = pickBetterSqlite(await loader("better-sqlite3"));
  if (!Database) throw missingOptionalDriver("sqlite", "better-sqlite3");
  const db = new Database(sqliteFilename(config));
  return {
    async query(sql, params = []) {
      const bind = sqliteValues(params);
      const rows = (bind.length ? db.prepare(sql).all(...bind) : db.prepare(sql).all()) as unknown[];
      return { rows, rowCount: rows.length };
    },
    async execute(sql, params = []) {
      const bind = sqliteValues(params);
      const info = bind.length ? db.prepare(sql).run(...bind) : db.prepare(sql).run();
      return {
        changes: Number(info.changes ?? 0),
        lastInsertRowid: info.lastInsertRowid !== undefined ? Number(info.lastInsertRowid) : undefined,
      };
    },
    async listTables() {
      const rows = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as Array<{ name?: string }>;
      return rows.map((r) => String(r.name ?? "")).filter(Boolean);
    },
    async describe(table) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
        throw new AdapterError("E_INVALID_ARGUMENT", `Unsafe table name "${table}"`, { protocol: "sqlite" });
      }
      const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
        name?: string;
        type?: string;
        pk?: number;
      }>;
      return {
        table,
        columns: rows.map((r) => ({
          name: String(r.name ?? ""),
          type: String(r.type ?? ""),
          pk: Boolean(r.pk),
        })),
      };
    },
    async close() {
      db.close();
    },
  };
}
