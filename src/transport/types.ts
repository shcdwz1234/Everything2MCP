import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

/** Transport kinds this process can attach. stdio is the default; http and sse share the HTTP listener. */
export type TransportKind = "stdio" | "sse" | "http";

export interface AttachableServer {
  connect(transport: unknown): Promise<void>;
}

export type McpServer = Server;

export interface HttpTransportOptions {
  host?: string;
  port?: number;
  path?: string;
  ssePath?: string;
  messagesPath?: string;
  token?: string;
  tokenHeader?: string;
}

/** @deprecated Use HttpTransportOptions. */
export type FutureHttpTransportOptions = HttpTransportOptions;
