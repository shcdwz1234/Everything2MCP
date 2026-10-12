import { AdapterError } from "../../runtime/errors.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import {
  allowWriteFrom,
  connectNodeSqlite,
  invokeRelational,
  relationalToolSchemas,
  type RelationalConnectFn,
  type RelationalHandle,
} from "../sql/common.js";
import { connectBetterSqliteNative, wantsNativeDriver } from "../sql/native.js";

/** sqlite — CI default relational engine via `node:sqlite`, with better-sqlite3 fallback on Node 18/20. */
export class SqliteAdapter implements ProtocolAdapter {
  readonly protocol = "sqlite";
  private handle: RelationalHandle | undefined;
  private connected = false;
  private allowWrite = false;
  private filename = ":memory:";
  private mode = "node-sqlite";

  constructor(
    readonly id: string,
    private readonly connectFn: RelationalConnectFn = connectNodeSqlite,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    this.filename =
      (typeof config.filename === "string" && config.filename) ||
      (typeof config.database === "string" && config.database) ||
      (typeof config.path === "string" && config.path) ||
      ":memory:";
    this.allowWrite = allowWriteFrom(config);
    if (this.connectFn !== connectNodeSqlite) {
      this.mode = "injected";
      this.handle = await this.connectFn(config);
    } else if (wantsNativeDriver(config)) {
      this.mode = "native";
      this.handle = await connectBetterSqliteNative(config);
    } else {
      this.handle = await this.connectFn(config);
      this.mode = this.handle.backend ?? "node-sqlite";
    }
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.handle) await this.handle.close();
    this.handle = undefined;
    this.connected = false;
  }

  async listTools(): Promise<McpToolSchema[]> {
    this.assertConnected();
    return relationalToolSchemas("sqlite");
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    return invokeRelational(this.protocol, "sqlite", this.handle!, this.allowWrite, toolName, args);
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return { ok: true, detail: `sqlite filename=${this.filename} mode=${this.mode} allowWrite=${this.allowWrite}` };
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_NOT_CONNECTED", "sqlite adapter is not connected", { protocol: "sqlite" });
    }
  }
}