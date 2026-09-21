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
  const url = stringField(config, "url") ?? stringField(config, "dsn");
  if (config.simulator === true || !url) return createMemorySqlHandle("sqlserver", config);
  throw new AdapterError(
    "E_UNSUPPORTED",
    "sqlserver is Thin: no bundled TDS client. Inject connectFn or use simulator:true.",
    { protocol: "sqlserver" },
  );
}

/** Microsoft SQL Server / Azure SQL. Thin — simulator or injected handle only. */
export class SqlServerAdapter implements ProtocolAdapter {
  readonly protocol = "sqlserver";
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
    if (!this.connected) throw new AdapterError("E_NOT_CONNECTED", "sqlserver adapter is not connected", { protocol: "sqlserver" });
    return relationalToolSchemas("sqlserver");
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_NOT_CONNECTED", "sqlserver adapter is not connected", { protocol: "sqlserver" });
    }
    return invokeRelational(this.protocol, "sqlserver", this.handle, this.allowWrite, toolName, args);
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return { ok: true, detail: `sqlserver Thin simulator/inject allowWrite=${this.allowWrite} (no TDS)` };
  }
}
