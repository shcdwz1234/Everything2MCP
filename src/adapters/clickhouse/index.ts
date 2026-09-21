import { AdapterError } from "../../runtime/errors.js";
import { fetchSafe } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { stringField } from "../helpers.js";
import {
  allowWriteFrom,
  createMemorySqlHandle,
  invokeRelational,
  relationalToolSchemas,
  type RelationalConnectFn,
  type RelationalHandle,
} from "../sql/common.js";

async function httpClickhouse(url: string, timeoutMs: number): Promise<RelationalHandle> {
  const root = url.replace(/\/+$/, "");
  const run = async (sql: string): Promise<string> => {
    const target = new URL(root.includes("?") ? root : `${root}/`);
    const res = await fetchSafe(target.toString(), {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: sql,
      timeoutMs,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new AdapterError("E_PROTOCOL", `ClickHouse HTTP ${res.status}: ${text.slice(0, 200)}`, {
        protocol: "clickhouse",
      });
    }
    return text;
  };
  const parseRows = (text: string): unknown[] => {
    const trimmed = text.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const json = JSON.parse(trimmed) as { data?: unknown[] } | unknown[];
        if (Array.isArray(json)) return json;
        if (json && typeof json === "object" && Array.isArray(json.data)) return json.data;
      } catch {
        /* JSONEachRow */
      }
    }
    return trimmed
      .split(/\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { value: line };
        }
      });
  };
  return {
    async query(sql) {
      const text = await run(/format\s+/i.test(sql) ? sql : `${sql} FORMAT JSONEachRow`);
      const rows = parseRows(text);
      return { rows, rowCount: rows.length };
    },
    async execute(sql) {
      await run(sql);
      return { changes: 1 };
    },
    async listTables() {
      const text = await run("SHOW TABLES FORMAT JSONEachRow");
      return parseRows(text).map((row) => {
        if (row && typeof row === "object") {
          const rec = row as Record<string, unknown>;
          return String(rec.name ?? rec.table ?? Object.values(rec)[0] ?? "");
        }
        return String(row);
      }).filter(Boolean);
    },
    async describe(table) {
      const text = await run(`DESCRIBE TABLE ${table} FORMAT JSONEachRow`);
      const columns = parseRows(text).map((row) => {
        const rec = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
        return { name: String(rec.name ?? rec.column ?? ""), type: String(rec.type ?? "String") };
      });
      return { table, columns };
    },
    async close() {
      /* stateless */
    },
  };
}

async function defaultConnect(config: Record<string, unknown>): Promise<RelationalHandle> {
  const url = stringField(config, "url");
  if (config.simulator === true || !url) return createMemorySqlHandle("clickhouse", config);
  const timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 4000;
  return httpClickhouse(url, timeoutMs);
}

/** ClickHouse. SQL-ish query/execute; CI memory catalog. No distributed DDL. */
export class ClickhouseAdapter implements ProtocolAdapter {
  readonly protocol = "clickhouse";
  private handle: RelationalHandle | undefined;
  private connected = false;
  private allowWrite = false;

  constructor(
    readonly id: string,
    private readonly connectFn: RelationalConnectFn = defaultConnect,
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
    if (!this.connected) {
      throw new AdapterError("E_NOT_CONNECTED", "clickhouse adapter is not connected", { protocol: "clickhouse" });
    }
    return relationalToolSchemas("clickhouse");
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_NOT_CONNECTED", "clickhouse adapter is not connected", { protocol: "clickhouse" });
    }
    return invokeRelational(this.protocol, "clickhouse", this.handle, this.allowWrite, toolName, args);
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return { ok: true, detail: `clickhouse allowWrite=${this.allowWrite} (no cluster DDL)` };
  }
}
