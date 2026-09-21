import { AdapterError } from "../../runtime/errors.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { stringField } from "../helpers.js";
import { DuckdbAdapter } from "../duckdb/index.js";
import { MysqlAdapter } from "../mysql/index.js";
import { PostgresAdapter } from "../postgres/index.js";
import { SqliteAdapter } from "../sqlite/index.js";
import { SqlServerAdapter } from "../sqlserver/index.js";
import {
  allowWriteFrom,
  invokeRelational,
  relationalToolSchemas,
  type RelationalConnectFn,
  type RelationalHandle,
} from "./common.js";

export type { RelationalHandle as SqlHandle, RelationalConnectFn as SqlConnectFn, SqlQueryResult, SqlExecuteResult } from "./common.js";

export type SqlDriver = "sqlite" | "postgres" | "mysql" | "sqlserver" | "duckdb";

export function inferSqlDriver(config: Record<string, unknown>): SqlDriver {
  const named = stringField(config, "driver")?.toLowerCase();
  if (named === "sqlite") return "sqlite";
  if (named === "pg" || named === "postgres" || named === "postgresql") return "postgres";
  if (named === "mysql" || named === "mariadb") return "mysql";
  if (named === "mssql" || named === "sqlserver" || named === "sql-server") return "sqlserver";
  if (named === "duckdb") return "duckdb";
  const url = stringField(config, "url") ?? stringField(config, "dsn") ?? "";
  if (/^postgres(ql)?:/i.test(url)) return "postgres";
  if (/^mysql:/i.test(url)) return "mysql";
  if (/^mssql:|^sqlserver:/i.test(url)) return "sqlserver";
  if (/\.duckdb$/i.test(url) || /^duckdb:/i.test(url)) return "duckdb";
  return "sqlite";
}

/**
 * Thin routing facade. Prefer protocol ids `sqlite` / `postgres` / `mysql` / `sqlserver` / `duckdb`.
 * `sql` still works: config.driver selects the inner engine.
 */
export class SqlAdapter implements ProtocolAdapter {
  readonly protocol = "sql";
  private inner: ProtocolAdapter | undefined;
  private handle: RelationalHandle | undefined;
  private connected = false;
  private driver: SqlDriver = "sqlite";
  private allowWrite = false;

  constructor(
    readonly id: string,
    private readonly connectFn?: RelationalConnectFn,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    this.driver = inferSqlDriver(config);
    this.allowWrite = allowWriteFrom(config);
    if (this.connectFn) {
      this.handle = await this.connectFn(config);
      this.connected = true;
      return;
    }
    this.inner = makeInner(this.driver, this.id);
    await this.inner.connect(config);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.inner) await this.inner.disconnect();
    if (this.handle) await this.handle.close();
    this.inner = undefined;
    this.handle = undefined;
    this.connected = false;
  }

  async listTools(): Promise<McpToolSchema[]> {
    this.assertConnected();
    if (this.inner) return this.inner.listTools();
    return relationalToolSchemas(`sql/${this.driver}`);
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    if (this.inner) {
      const out = await this.inner.invoke(toolName, args);
      if (out && typeof out === "object") return { driver: this.driver, ...(out as Record<string, unknown>) };
      return out;
    }
    const result = await invokeRelational(this.protocol, this.driver, this.handle!, this.allowWrite, toolName, args);
    if (result && typeof result === "object") return { driver: this.driver, ...(result as Record<string, unknown>) };
    return result;
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    const inner = this.inner?.health ? await this.inner.health() : undefined;
    return {
      ok: true,
      detail: `sql facade driver=${this.driver} (prefer protocol=${this.driver}) ${inner?.detail ?? ""}`.trim(),
    };
  }

  private assertConnected(): void {
    if (!this.connected) throw new AdapterError("E_NOT_CONNECTED", "SQL adapter is not connected", { protocol: "sql" });
  }
}

function makeInner(driver: SqlDriver, id: string): ProtocolAdapter {
  switch (driver) {
    case "postgres":
      return new PostgresAdapter(id);
    case "mysql":
      return new MysqlAdapter(id);
    case "sqlserver":
      return new SqlServerAdapter(id);
    case "duckdb":
      return new DuckdbAdapter(id);
    default:
      return new SqliteAdapter(id);
  }
}
