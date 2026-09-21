import { createConnection, createServer, type Socket } from "node:net";
import { AdapterError } from "../../runtime/errors.js";
import { assertHostAllowed } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";
import { requiredString, stringField } from "../helpers.js";
import {
  OPCODE_QUERY,
  OPCODE_READY,
  OPCODE_STARTUP,
  decodeFrame,
  decodeQueryCql,
  decodeResult,
  encodeError,
  encodeQuery,
  encodeReady,
  encodeResultRows,
  encodeResultSetKeyspace,
  encodeResultVoid,
  encodeStartup,
} from "./wire.js";

export interface CassandraRow {
  [column: string]: unknown;
}

export interface CassandraHandle {
  listKeyspaces(): Promise<string[]>;
  listTables(keyspace?: string): Promise<string[]>;
  describe(keyspace: string, table: string): Promise<{ keyspace: string; table: string; columns: string[]; count: number }>;
  cql(statement: string): Promise<{ columns: string[]; rows: CassandraRow[]; keyspace?: string }>;
  close(): Promise<void>;
}

export type CassandraConnectFn = (config: Record<string, unknown>) => Promise<CassandraHandle>;

export function isWriteCql(statement: string): boolean {
  return /^\s*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE|BATCH|GRANT|REVOKE)\b/i.test(statement);
}

interface TableStore {
  columns: string[];
  rows: CassandraRow[];
}

export function createMemoryCassandra(): CassandraHandle {
  const keyspaces = new Map<string, Map<string, TableStore>>();
  let current = "system";
  keyspaces.set("system", new Map());
  keyspaces.set("system_schema", new Map());

  const resolve = (raw: string): { ks: string; table: string } => {
    const name = raw.replace(/"/g, "");
    if (name.includes(".")) {
      const [ks, table] = name.split(".");
      return { ks: ks || current, table: table || name };
    }
    return { ks: current, table: name };
  };

  const literal = (raw: string): unknown => {
    const s = raw.trim();
    if (/^'.*'$/.test(s) || /^".*"$/.test(s)) return s.slice(1, -1);
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    if (/^(true|false)$/i.test(s)) return /^true$/i.test(s);
    if (/^null$/i.test(s)) return null;
    return s;
  };

  return {
    async listKeyspaces() {
      return [...keyspaces.keys()].filter((k) => !k.startsWith("system")).sort();
    },
    async listTables(keyspace) {
      const ks = keyspace || current;
      return [...(keyspaces.get(ks)?.keys() ?? [])].sort();
    },
    async describe(keyspace, table) {
      const t = keyspaces.get(keyspace)?.get(table);
      return { keyspace, table, columns: t?.columns ?? [], count: t?.rows.length ?? 0 };
    },
    async cql(statement) {
      const s = statement.trim().replace(/;$/, "");
      const use = /^USE\s+([A-Za-z0-9_]+)\s*$/i.exec(s);
      if (use) {
        current = use[1]!;
        if (!keyspaces.has(current)) keyspaces.set(current, new Map());
        return { columns: [], rows: [], keyspace: current };
      }
      const createKs = /^CREATE\s+KEYSPACE(?:\s+IF\s+NOT\s+EXISTS)?\s+([A-Za-z0-9_]+)/i.exec(s);
      if (createKs) {
        if (!keyspaces.has(createKs[1]!)) keyspaces.set(createKs[1]!, new Map());
        return { columns: [], rows: [] };
      }
      const createTable =
        /^CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([A-Za-z0-9_."]+)\s*\((.+)\)\s*$/is.exec(s);
      if (createTable) {
        const { ks, table } = resolve(createTable[1]!);
        if (!keyspaces.has(ks)) keyspaces.set(ks, new Map());
        const columns = createTable[2]!
          .split(",")
          .map((part) => part.trim().split(/\s+/)[0]?.replace(/"/g, "") ?? "")
          .filter((c) => c && !/^(PRIMARY|WITH)$/i.test(c));
        keyspaces.get(ks)!.set(table, { columns, rows: [] });
        return { columns: [], rows: [] };
      }
      const insert = /^INSERT\s+INTO\s+([A-Za-z0-9_."]+)\s*\(([^)]+)\)\s*VALUES\s*\((.+)\)\s*$/is.exec(s);
      if (insert) {
        const { ks, table } = resolve(insert[1]!);
        const store = keyspaces.get(ks)?.get(table);
        if (!store) {
          throw new AdapterError("E_NOT_FOUND", `cassandra table ${ks}.${table} missing`, { protocol: "cassandra" });
        }
        const cols = insert[2]!.split(",").map((c) => c.trim().replace(/"/g, ""));
        const vals = splitArgs(insert[3]!).map(literal);
        const row: CassandraRow = {};
        cols.forEach((c, i) => {
          row[c] = vals[i];
        });
        store.rows.push(row);
        return { columns: [], rows: [] };
      }
      const select =
        /^SELECT\s+([\w*.,\s]+)\s+FROM\s+([A-Za-z0-9_."]+)(?:\s+WHERE\s+([A-Za-z0-9_]+)\s*=\s*(.+))?\s*$/i.exec(s);
      if (select) {
        const { ks, table } = resolve(select[2]!);
        if (ks === "system_schema" && table === "keyspaces") {
          const names = [...keyspaces.keys()].filter((k) => !k.startsWith("system"));
          return { columns: ["keyspace_name"], rows: names.map((keyspace_name) => ({ keyspace_name })) };
        }
        if (ks === "system_schema" && table === "tables") {
          const names: CassandraRow[] = [];
          for (const [keyspace, tables] of keyspaces) {
            if (keyspace.startsWith("system")) continue;
            for (const t of tables.keys()) names.push({ keyspace_name: keyspace, table_name: t });
          }
          return { columns: ["keyspace_name", "table_name"], rows: names };
        }
        const store = keyspaces.get(ks)?.get(table);
        const rows = store?.rows ?? [];
        const filtered = select[3]
          ? rows.filter((r) => String(r[select[3]!]) === String(literal(select[4] ?? "")))
          : rows;
        const cols =
          select[1]!.trim() === "*"
            ? store?.columns ?? Object.keys(filtered[0] ?? {})
            : select[1]!.split(",").map((c) => c.trim());
        return {
          columns: cols,
          rows: filtered.map((r) => {
            const out: CassandraRow = {};
            for (const c of cols) out[c] = r[c];
            return out;
          }),
        };
      }
      const update =
        /^UPDATE\s+([A-Za-z0-9_."]+)\s+SET\s+([A-Za-z0-9_]+)\s*=\s*(.+?)\s+WHERE\s+([A-Za-z0-9_]+)\s*=\s*(.+)\s*$/i.exec(
          s,
        );
      if (update) {
        const { ks, table } = resolve(update[1]!);
        const store = keyspaces.get(ks)?.get(table);
        if (!store) throw new AdapterError("E_NOT_FOUND", `cassandra table ${ks}.${table} missing`, { protocol: "cassandra" });
        const value = literal(update[3]!);
        const where = String(literal(update[5]!));
        for (const row of store.rows) {
          if (String(row[update[4]!]) === where) row[update[2]!] = value;
        }
        return { columns: [], rows: [] };
      }
      const del = /^DELETE\s+FROM\s+([A-Za-z0-9_."]+)\s+WHERE\s+([A-Za-z0-9_]+)\s*=\s*(.+)\s*$/i.exec(s);
      if (del) {
        const { ks, table } = resolve(del[1]!);
        const store = keyspaces.get(ks)?.get(table);
        if (!store) return { columns: [], rows: [] };
        const where = String(literal(del[3]!));
        store.rows = store.rows.filter((r) => String(r[del[2]!]) !== where);
        return { columns: [], rows: [] };
      }
      throw new AdapterError(
        "E_UNSUPPORTED",
        "cassandra CQL subset: USE / CREATE KEYSPACE|TABLE / INSERT / SELECT / UPDATE / DELETE",
        { protocol: "cassandra" },
      );
    },
    async close() {
      keyspaces.clear();
    },
  };
}

function splitArgs(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | undefined;
  for (const ch of raw) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
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

class FrameReader {
  private leftover = Buffer.alloc(0);
  constructor(private readonly socket: Socket) {}
  async readFrame(timeoutMs: number): Promise<Buffer> {
    if (this.leftover.length >= 9) {
      const length = this.leftover.readInt32BE(5);
      const total = 9 + length;
      if (this.leftover.length >= total) {
        const out = this.leftover.subarray(0, total);
        this.leftover = this.leftover.subarray(total);
        return out;
      }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new AdapterError("E_TIMEOUT", "cassandra timeout", { protocol: "cassandra" })),
        timeoutMs,
      );
      const onData = (chunk: Buffer) => {
        this.leftover = Buffer.concat([this.leftover, chunk]);
        if (this.leftover.length >= 9) {
          const length = this.leftover.readInt32BE(5);
          if (this.leftover.length >= 9 + length) {
            this.socket.off("data", onData);
            clearTimeout(timer);
            resolve(this.readFrame(timeoutMs));
          }
        }
      };
      this.socket.on("data", onData);
      this.socket.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
}

async function liveCassandra(config: Record<string, unknown>): Promise<CassandraHandle> {
  const url = stringField(config, "url") ?? "";
  const fromUrl = url.replace(/^cassandra:\/\//i, "");
  const host = stringField(config, "host") ?? fromUrl.split(":")[0];
  if (!host) throw new AdapterError("E_INVALID_CONFIG", "cassandra adapter requires config.host or config.url", { protocol: "cassandra" });
  await assertHostAllowed(host);
  const port = typeof config.port === "number" ? config.port : Number(fromUrl.split(":")[1] ?? 9042);
  const timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 4000;
  const socket = await new Promise<Socket>((resolve, reject) => {
    const s = createConnection({ host, port, timeout: timeoutMs }, () => resolve(s));
    s.once("error", reject);
  });
  const reader = new FrameReader(socket);
  socket.write(encodeStartup());
  const ready = decodeFrame(await reader.readFrame(timeoutMs));
  if (!ready || ready.opcode !== OPCODE_READY) {
    socket.destroy();
    throw new AdapterError("E_PROTOCOL", "cassandra STARTUP did not return READY", { protocol: "cassandra" });
  }
  let stream = 1;
  const query = async (cql: string) => {
    const id = stream++;
    socket.write(encodeQuery(cql, id));
    const frame = decodeFrame(await reader.readFrame(timeoutMs));
    if (!frame) throw new AdapterError("E_PROTOCOL", "cassandra empty frame", { protocol: "cassandra" });
    if (frame.opcode !== 0x08) {
      throw new AdapterError("E_PROTOCOL", `cassandra opcode ${frame.opcode}`, { protocol: "cassandra" });
    }
    return decodeResult(frame.body);
  };
  return {
    async listKeyspaces() {
      const r = await query("SELECT keyspace_name FROM system_schema.keyspaces");
      return r.rows.map((row) => String(row.keyspace_name ?? "")).filter(Boolean);
    },
    async listTables(keyspace) {
      const r = await query("SELECT keyspace_name, table_name FROM system_schema.tables");
      return r.rows
        .filter((row) => !keyspace || String(row.keyspace_name) === keyspace)
        .map((row) => String(row.table_name ?? ""))
        .filter(Boolean);
    },
    async describe(keyspace, table) {
      const r = await query(`SELECT * FROM ${keyspace}.${table}`);
      return { keyspace, table, columns: r.columns, count: r.rows.length };
    },
    async cql(statement) {
      const r = await query(statement);
      return { columns: r.columns, rows: r.rows, keyspace: r.keyspace };
    },
    async close() {
      socket.destroy();
    },
  };
}

async function defaultConnect(config: Record<string, unknown>): Promise<CassandraHandle> {
  const host = stringField(config, "host") ?? stringField(config, "url");
  if (config.simulator === true || !host) return createMemoryCassandra();
  return liveCassandra(config);
}

/** In-process native protocol v4 server backed by the memory CQL subset. */
export async function listenCassandraNative(mem: CassandraHandle = createMemoryCassandra()): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = createServer((socket) => {
    const reader = new FrameReader(socket);
    const feed = async () => {
      try {
        for (;;) {
          const buf = await reader.readFrame(8000);
          const frame = decodeFrame(buf);
          if (!frame) break;
          if (frame.opcode === OPCODE_STARTUP) {
            socket.write(encodeReady(frame.stream));
            continue;
          }
          if (frame.opcode === OPCODE_QUERY) {
            const cql = decodeQueryCql(frame.body);
            try {
              const result = await mem.cql(cql);
              if (/^USE\s+/i.test(cql) && result.keyspace) {
                socket.write(encodeResultSetKeyspace(result.keyspace, frame.stream));
              } else if (result.columns.length || result.rows.length) {
                socket.write(encodeResultRows("ks", "t", result.columns, result.rows, frame.stream));
              } else {
                socket.write(encodeResultVoid(frame.stream));
              }
            } catch (err) {
              socket.write(encodeError(err instanceof Error ? err.message : String(err), frame.stream));
            }
            continue;
          }
          socket.write(encodeError(`unsupported opcode ${frame.opcode}`, frame.stream));
        }
      } catch {
        socket.destroy();
      }
    };
    void feed();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as { port: number }).port, close: () => new Promise((r) => server.close(() => r())) };
}

/** Cassandra CQL subset. Memory or native protocol v4 STARTUP/QUERY. Writes need allowWrite. */
export class CassandraAdapter implements ProtocolAdapter {
  readonly protocol = "cassandra";
  private handle: CassandraHandle | undefined;
  private connected = false;
  private allowWrite = false;

  constructor(
    readonly id: string,
    private readonly connectFn: CassandraConnectFn = defaultConnect,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    this.allowWrite = allowWriteFrom(config);
    this.handle = await this.connectFn(config);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.handle) await this.handle.close();
    this.handle = undefined;
    this.connected = false;
  }

  async listTools(): Promise<McpToolSchema[]> {
    this.assertConnected();
    return [
      {
        name: "list_keyspaces",
        description: "List non-system keyspaces",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "list_tables",
        description: "List tables in a keyspace",
        inputSchema: {
          type: "object",
          properties: { keyspace: { type: "string" } },
          additionalProperties: false,
        },
      },
      {
        name: "describe",
        description: "Table columns and row count",
        inputSchema: {
          type: "object",
          properties: { keyspace: { type: "string" }, table: { type: "string" } },
          required: ["keyspace", "table"],
          additionalProperties: false,
        },
      },
      {
        name: "cql",
        description: "CQL subset (INSERT/UPDATE/DELETE/CREATE require allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: { statement: { type: "string" } },
          required: ["statement"],
          additionalProperties: false,
        },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const h = this.handle!;
    if (toolName === "list_keyspaces") return { keyspaces: await h.listKeyspaces() };
    if (toolName === "list_tables") {
      return { tables: await h.listTables(typeof args.keyspace === "string" ? args.keyspace : undefined) };
    }
    if (toolName === "describe") {
      return h.describe(requiredString(args, "keyspace"), requiredString(args, "table"));
    }
    if (toolName === "cql") {
      const statement = requiredString(args, "statement");
      if (isWriteCql(statement)) assertCanWrite("cassandra", this.allowWrite, statement);
      return h.cql(statement);
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown cassandra tool "${toolName}"`, { protocol: "cassandra" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return { ok: true, detail: `cassandra allowWrite=${this.allowWrite} (CQL subset; native v4 STARTUP/QUERY)` };
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_NOT_CONNECTED", "cassandra adapter is not connected", { protocol: "cassandra" });
    }
  }
}
