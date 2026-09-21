import { AdapterError } from "../../runtime/errors.js";
import type { McpToolSchema } from "../../runtime/types.js";

export interface SqlQueryResult {
  rows: unknown[];
  rowCount: number;
}

export interface SqlExecuteResult {
  changes: number;
  lastInsertRowid?: number;
}

export interface ColumnMeta {
  name: string;
  type: string;
  pk?: boolean;
}

export interface RelationalHandle {
  query(sql: string, params?: unknown[]): Promise<SqlQueryResult>;
  execute(sql: string, params?: unknown[]): Promise<SqlExecuteResult>;
  listTables(): Promise<string[]>;
  describe(table: string): Promise<{ table: string; columns: ColumnMeta[] }>;
  close(): Promise<void>;
}

export type RelationalConnectFn = (config: Record<string, unknown>) => Promise<RelationalHandle>;

export function allowWriteFrom(config: Record<string, unknown>): boolean {
  return config.allowWrite === true;
}

export function isWriteSql(sql: string): boolean {
  return /^\s*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE|REPLACE|MERGE|GRANT|REVOKE|COPY|VACUUM|ATTACH|DETACH|CALL|EXEC|EXECUTE)\b/i.test(
    sql,
  );
}

export function assertCanWrite(protocol: string, allowWrite: boolean, sql?: string): void {
  if (allowWrite) return;
  const extra = sql ? `: ${sql.slice(0, 80)}` : "";
  throw new AdapterError(
    "E_UNSUPPORTED",
    `Write blocked (config.allowWrite=false)${extra}. Re-register with allowWrite=true to mutate data.`,
    { protocol },
  );
}

export function asSqlParams(args: Record<string, unknown>): unknown[] {
  if (Array.isArray(args.params)) return args.params;
  if (Array.isArray(args.values)) return args.values;
  return [];
}

export function relationalToolSchemas(dialect: string): McpToolSchema[] {
  return [
    {
      name: "query",
      description: `Read-only SQL query (${dialect})`,
      inputSchema: {
        type: "object",
        properties: { sql: { type: "string" }, params: { type: "array" } },
        required: ["sql"],
        additionalProperties: false,
      },
    },
    {
      name: "execute",
      description: `SQL write/DDL (${dialect}). Requires config.allowWrite=true`,
      inputSchema: {
        type: "object",
        properties: { sql: { type: "string" }, params: { type: "array" } },
        required: ["sql"],
        additionalProperties: false,
      },
    },
    {
      name: "list_tables",
      description: "List tables / views in the connected catalog",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "describe",
      description: "Describe columns of a table",
      inputSchema: {
        type: "object",
        properties: { table: { type: "string" } },
        required: ["table"],
        additionalProperties: false,
      },
    },
  ];
}

type SqliteValue = null | number | bigint | string | Uint8Array | Buffer;

export function sqliteValues(params: unknown[]): SqliteValue[] {
  return params.map((p) => {
    if (p === undefined || p === null) return null;
    if (typeof p === "boolean") return p ? 1 : 0;
    if (typeof p === "number" || typeof p === "bigint" || typeof p === "string") return p;
    if (p instanceof Uint8Array || Buffer.isBuffer(p)) return p;
    return JSON.stringify(p);
  });
}

export async function connectNodeSqlite(config: Record<string, unknown>): Promise<RelationalHandle> {
  const filename =
    typeof config.filename === "string" && config.filename.trim()
      ? config.filename.trim()
      : typeof config.database === "string" && config.database.trim()
        ? config.database.trim()
        : typeof config.path === "string" && config.path.trim()
          ? config.path.trim()
          : ":memory:";
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(filename);
  return {
    async query(sql, params = []) {
      const stmt = db.prepare(sql);
      const bind = sqliteValues(params);
      const rows = (bind.length ? stmt.all(...bind) : stmt.all()) as unknown[];
      return { rows, rowCount: rows.length };
    },
    async execute(sql, params = []) {
      const stmt = db.prepare(sql);
      const bind = sqliteValues(params);
      const info = bind.length ? stmt.run(...bind) : stmt.run();
      return {
        changes: Number(info.changes ?? 0),
        lastInsertRowid: info.lastInsertRowid !== undefined ? Number(info.lastInsertRowid) : undefined,
      };
    },
    async listTables() {
      const stmt = db.prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
      );
      const rows = stmt.all() as Array<{ name?: string }>;
      return rows.map((r) => String(r.name ?? "")).filter(Boolean);
    },
    async describe(table) {
      const stmt = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`);
      const rows = stmt.all() as Array<{ name?: string; type?: string; pk?: number }>;
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

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new AdapterError("E_INVALID_ARGUMENT", `Unsafe table name "${name}"`);
  }
  return `"${name}"`;
}

interface MemoryTable {
  columns: ColumnMeta[];
  rows: Array<Record<string, unknown>>;
}

/** Tiny in-memory SQL catalog for hermetic CI of non-sqlite engines. Not a full dialect. */
export function createMemorySqlHandle(dialect: string, seed?: Record<string, unknown>): RelationalHandle {
  const tables = new Map<string, MemoryTable>();
  const seeded = seed?.tables;
  if (Array.isArray(seeded)) {
    for (const raw of seeded) {
      if (!raw || typeof raw !== "object") continue;
      const rec = raw as Record<string, unknown>;
      const name = typeof rec.name === "string" ? rec.name : "";
      if (!name) continue;
      const columns = Array.isArray(rec.columns)
        ? (rec.columns as Array<Record<string, unknown>>).map((c) => ({
            name: String(c.name ?? ""),
            type: String(c.type ?? "TEXT"),
          }))
        : [];
      const rows = Array.isArray(rec.rows) ? (rec.rows as Array<Record<string, unknown>>).map((r) => ({ ...r })) : [];
      tables.set(name, { columns, rows });
    }
  }
  return {
    async query(sql, params = []) {
      return memoryQuery(tables, bindParams(sql, params), dialect);
    },
    async execute(sql, params = []) {
      return memoryExecute(tables, bindParams(sql, params));
    },
    async listTables() {
      return [...tables.keys()].sort();
    },
    async describe(table) {
      const t = tables.get(table);
      if (!t) throw new AdapterError("E_NOT_FOUND", `Unknown table ${table}`, { protocol: dialect });
      return { table, columns: t.columns };
    },
    async close() {
      tables.clear();
    },
  };
}

function bindParams(sql: string, params: unknown[]): string {
  let i = 0;
  return sql.replace(/\?/g, () => {
    const v = params[i++];
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "number") return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  });
}

function memoryQuery(tables: Map<string, MemoryTable>, sql: string, dialect: string): SqlQueryResult {
  const trimmed = sql.trim();
  if (/^select\s+1\b/i.test(trimmed) && !/\bfrom\b/i.test(trimmed)) {
    return { rows: [{ "?column?": 1, n: 1 }], rowCount: 1 };
  }
  const from = /\bFROM\s+([A-Za-z0-9_."`\[\]]+)/i.exec(trimmed);
  if (!from) {
    throw new AdapterError("E_UNSUPPORTED", `${dialect} simulator only handles SELECT … FROM table (or SELECT 1)`, {
      protocol: dialect,
    });
  }
  const table = unwrapIdent(from[1]!);
  const t = tables.get(table);
  if (!t) throw new AdapterError("E_NOT_FOUND", `Unknown table ${table}`, { protocol: dialect });
  let rows = t.rows.map((r) => ({ ...r }));
  const where = /\bWHERE\s+([A-Za-z0-9_]+)\s*=\s*(.+)$/i.exec(trimmed.replace(/;+\s*$/, ""));
  if (where) {
    const col = where[1]!;
    const raw = where[2]!.trim().replace(/;+\s*$/, "");
    const want = unquote(raw);
    rows = rows.filter((r) => String(r[col]) === String(want));
  }
  return { rows, rowCount: rows.length };
}

function memoryExecute(tables: Map<string, MemoryTable>, sql: string): SqlExecuteResult {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  const create = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_."`\[\]]+)\s*\((.+)\)\s*$/i.exec(trimmed);
  if (create) {
    const name = unwrapIdent(create[1]!);
    const columns = create[2]!.split(",").map((part) => {
      const bits = part.trim().split(/\s+/);
      return { name: unwrapIdent(bits[0] ?? "col"), type: (bits[1] ?? "TEXT").toUpperCase() };
    });
    tables.set(name, { columns, rows: [] });
    return { changes: 0 };
  }
  const insert = /^INSERT\s+INTO\s+([A-Za-z0-9_."`\[\]]+)\s*(?:\(([^)]+)\))?\s*VALUES\s*\((.+)\)\s*$/i.exec(trimmed);
  if (insert) {
    const name = unwrapIdent(insert[1]!);
    const t = tables.get(name);
    if (!t) throw new AdapterError("E_NOT_FOUND", `Unknown table ${name}`);
    const cols = insert[2] ? insert[2].split(",").map((c) => unwrapIdent(c.trim())) : t.columns.map((c) => c.name);
    const vals = splitCsv(insert[3]!).map(unquote);
    const row: Record<string, unknown> = {};
    cols.forEach((c, i) => {
      row[c] = vals[i] ?? null;
    });
    t.rows.push(row);
    return { changes: 1, lastInsertRowid: t.rows.length };
  }
  const del = /^DELETE\s+FROM\s+([A-Za-z0-9_."`\[\]]+)(?:\s+WHERE\s+([A-Za-z0-9_]+)\s*=\s*(.+))?$/i.exec(trimmed);
  if (del) {
    const name = unwrapIdent(del[1]!);
    const t = tables.get(name);
    if (!t) throw new AdapterError("E_NOT_FOUND", `Unknown table ${name}`);
    if (!del[2]) {
      const n = t.rows.length;
      t.rows = [];
      return { changes: n };
    }
    const col = del[2]!;
    const want = unquote(del[3]!.trim());
    const before = t.rows.length;
    t.rows = t.rows.filter((r) => String(r[col]) !== String(want));
    return { changes: before - t.rows.length };
  }
  throw new AdapterError(
    "E_UNSUPPORTED",
    "Simulator execute supports CREATE TABLE / INSERT / DELETE only",
  );
}

function unwrapIdent(raw: string): string {
  return raw.trim().replace(/^["`\[\[]|[\]"`']$/g, "");
}

function unquote(raw: string): unknown {
  const s = raw.trim();
  if (/^NULL$/i.test(s)) return null;
  if (/^'.*'$/.test(s) || /^".*"$/.test(s)) return s.slice(1, -1).replace(/''/g, "'");
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function splitCsv(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | undefined;
  for (const ch of s) {
    if (q) {
      cur += ch;
      if (ch === q) q = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      q = ch;
      cur += ch;
      continue;
    }
    if (ch === ",") {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export async function invokeRelational(
  protocol: string,
  dialect: string,
  handle: RelationalHandle,
  allowWrite: boolean,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (toolName === "query") {
    const sql = String(args.sql ?? "").trim();
    if (!sql) throw new AdapterError("E_INVALID_ARGUMENT", 'Missing required string "sql"', { protocol });
    if (isWriteSql(sql)) assertCanWrite(protocol, allowWrite, sql);
    const result = await handle.query(sql, asSqlParams(args));
    return { dialect, ...result };
  }
  if (toolName === "execute") {
    const sql = String(args.sql ?? "").trim();
    if (!sql) throw new AdapterError("E_INVALID_ARGUMENT", 'Missing required string "sql"', { protocol });
    assertCanWrite(protocol, allowWrite, sql);
    const result = await handle.execute(sql, asSqlParams(args));
    return { dialect, ...result };
  }
  if (toolName === "list_tables") {
    return { dialect, tables: await handle.listTables() };
  }
  if (toolName === "describe") {
    const table = String(args.table ?? "").trim();
    if (!table) throw new AdapterError("E_INVALID_ARGUMENT", 'Missing required string "table"', { protocol });
    return handle.describe(table);
  }
  throw new AdapterError("E_UNKNOWN_TOOL", `Unknown ${protocol} tool "${toolName}"`, { protocol });
}
