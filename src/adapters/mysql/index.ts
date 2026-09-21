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
import { connectMysqlNative, wantsNativeDriver } from "../sql/native.js";

async function defaultConnect(config: Record<string, unknown>): Promise<RelationalHandle> {
  if (wantsNativeDriver(config)) return connectMysqlNative(config);
  const url = stringField(config, "url") ?? stringField(config, "dsn");
  if (config.simulator === true || !url) return createMemorySqlHandle("mysql", config);
  return connectMysqlNative(config);
}

/**
 * MySQL / MariaDB (same wire protocol).
 * CI: in-memory simulator. Live/native: optional `mysql2` (`native:true` + url).
 */
export class MysqlAdapter implements ProtocolAdapter {
  readonly protocol = "mysql";
  private handle: RelationalHandle | undefined;
  private connected = false;
  private allowWrite = false;
  private mode = "simulator";

  constructor(
    readonly id: string,
    private readonly connectFn: RelationalConnectFn = defaultConnect,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    this.allowWrite = allowWriteFrom(config);
    const url = stringField(config, "url");
    if (this.connectFn !== defaultConnect) this.mode = "injected";
    else if (wantsNativeDriver(config)) this.mode = "native";
    else if (config.simulator === true || !url) this.mode = "simulator";
    else this.mode = "live";
    this.handle = await this.connectFn(config);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.handle) await this.handle.close();
    this.handle = undefined;
    this.connected = false;
  }

  async listTools(): Promise<McpToolSchema[]> {
    if (!this.connected) throw new AdapterError("E_NOT_CONNECTED", "mysql adapter is not connected", { protocol: "mysql" });
    return relationalToolSchemas("mysql/mariadb");
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_NOT_CONNECTED", "mysql adapter is not connected", { protocol: "mysql" });
    }
    return invokeRelational(this.protocol, "mysql", this.handle, this.allowWrite, toolName, args);
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return {
      ok: true,
      detail: `mysql/mariadb mode=${this.mode} allowWrite=${this.allowWrite} (MariaDB wire-compatible)`,
    };
  }
}
