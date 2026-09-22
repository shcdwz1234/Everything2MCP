export const APP_NAME = "everything2mcp";
export const APP_VERSION = "0.1.0";

export type JsonObject = Record<string, unknown>;

export interface McpJsonSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean | Record<string, unknown>;
  description?: string;
  [key: string]: unknown;
}

export interface McpToolSchema {
  name: string;
  description: string;
  inputSchema: McpJsonSchema;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  /** MCP extra metadata. `layer` is management vs business so agents can filter. */
  _meta?: JsonObject;
}

export interface DiscoveredTool {
  name: string;
  description?: string;
  protocol: string;
  metadata?: JsonObject;
}

export type AuthType = "none" | "apiKey" | "bearer" | "basic";

/** Placeholder auth hook. MVP does not implement OAuth or secret stores. */
export interface AuthConfig {
  type: AuthType;
  apiKey?: string;
  token?: string;
  username?: string;
  password?: string;
  headerName?: string;
  queryName?: string;
}

export interface RegistrationRecord {
  id: string;
  name: string;
  protocol: string;
  config: JsonObject;
  createdAt: string;
  updatedAt: string;
}

export interface AdapterHealth {
  ok: boolean;
  detail?: string;
}

export type IngressKind = "partner" | "native" | "mcp_bridge";

export interface AdapterSnapshot {
  id: string;
  name: string;
  protocol: string;
  toolCount: number;
  tools: string[];
  health?: AdapterHealth;
  status: "live" | "restore_failed";
  error?: string;
  /** Southbound ingress. Northbound Agent surface is always MCP. */
  ingress?: IngressKind;
}

export interface DiscoveryCandidate {
  protocol: string;
  url: string;
  hint: string;
  status: number;
  contentType?: string;
  title?: string;
  confidence?: number;
  detail?: string;
  config?: JsonObject;
}

export type TransportKind = "stdio" | "sse" | "http";

export interface TransportConfig {
  /** Process MCP transport. `stdio` is the default; `http` and `sse` both bind the HTTP listener. */
  kind: TransportKind;
  host: string;
  port: number;
  /** Streamable HTTP path (modern MCP). */
  mcpPath: string;
  /** Legacy SSE GET path. */
  ssePath: string;
  /** Legacy SSE POST path (SDK appends ?sessionId=). */
  messagesPath: string;
  /** When set, require Authorization: Bearer or x-api-key (or tokenHeader). */
  token?: string;
  /** Extra header that may carry the token (in addition to Authorization and x-api-key). */
  tokenHeader?: string;
}

export interface RateLimitConfig {
  invokePerMinute: number;
  discoverPerMinute: number;
}

export interface AppConfig {
  dataDir: string;
  discovery: {
    enabled: boolean;
    /** Always false. CIDR is never allowed; EVERYTHING2MCP_DISCOVERY_ALLOW_SCAN cannot set this. */
    allowScan: boolean;
    timeoutMs: number;
  };
  transport: TransportConfig;
  rateLimit: RateLimitConfig;
}

/** Nested-partial overrides for `createEverything2McpServer` / `startHttp`. */
export type AppConfigOverrides = Partial<Omit<AppConfig, "discovery" | "transport" | "rateLimit">> & {
  discovery?: Partial<AppConfig["discovery"]>;
  transport?: Partial<TransportConfig>;
  rateLimit?: Partial<RateLimitConfig>;
};
