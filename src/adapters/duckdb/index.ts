import { AdapterError } from "../../runtime/errors.js";
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

async function defaultConnect(config: Record<string, unknown>): Promise<RelationalHandle> {
  const filename = stringField(config, "filename") ?? stringField(config, "database");
  const url = stringField(config, "url");
  if (config.simulator === true || (!filename && !url)) return createMemorySqlHandle("duckdb", config);
  throw new AdapterError(
    "E_UNSUPPORTED",
    "duckdb live path needs the optional 'duckdb' package or an injected connectFn. Use simulator:true in CI.",
    { protocol: "duckdb" },
  );
}

/** DuckDB. File/in-process OLAP; CI uses the memory SQL simulator. */
export class DuckdbAdapter implements ProtocolAdapter {
  readonly protocol = "duckdb";
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
    if (!this.connected) throw new AdapterError("E_NOT_CONNECTED", "duckdb adapter is not connected", { protocol: "duckdb" });
    return relationalToolSchemas("duckdb");
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_NOT_CONNECTED", "duckdb adapter is not connected", { protocol: "duckdb" });
    }
    return invokeRelational(this.protocol, "duckdb", this.handle, this.allowWrite, toolName, args);
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return { ok: true, detail: `duckdb allowWrite=${this.allowWrite}` };
  }
}
