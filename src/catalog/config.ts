import { resolve } from "node:path";
import { log } from "../runtime/log.js";
import type { AppConfig, TransportKind } from "../runtime/types.js";

/** Uncommon default so we do not collide with 3000 / 5173 / 8080. */
export const DEFAULT_HTTP_PORT = 8742;

function truthy(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseTransportKind(value: string | undefined): TransportKind {
  const kind = (value ?? "stdio").trim().toLowerCase();
  if (kind === "http" || kind === "streamable" || kind === "streamable-http") return "http";
  if (kind === "sse") return "sse";
  return "stdio";
}

function normalizePath(value: string | undefined, fallback: string): string {
  const raw = (value ?? fallback).trim() || fallback;
  return raw.startsWith("/") ? raw : `/${raw}`;
}

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = resolve(env.EVERYTHING2MCP_DATA_DIR ?? "data");
  const portRaw = Number(env.EVERYTHING2MCP_HTTP_PORT ?? DEFAULT_HTTP_PORT);
  const port = Number.isFinite(portRaw) ? portRaw : DEFAULT_HTTP_PORT;
  const token = env.EVERYTHING2MCP_HTTP_TOKEN?.trim();
  const tokenHeader = env.EVERYTHING2MCP_HTTP_TOKEN_HEADER?.trim();
  const allowScanEnv = env.EVERYTHING2MCP_DISCOVERY_ALLOW_SCAN;
  if (allowScanEnv !== undefined && allowScanEnv !== "") {
    log("EVERYTHING2MCP_DISCOVERY_ALLOW_SCAN is ignored; CIDR / range scans are never allowed", {
      value: allowScanEnv,
    });
  }
  return {
    dataDir,
    discovery: {
      enabled: truthy(env.EVERYTHING2MCP_DISCOVERY_ENABLED, true),
      /** CIDR is never allowed. EVERYTHING2MCP_DISCOVERY_ALLOW_SCAN is a dead env. */
      allowScan: false,
      timeoutMs: Number(env.EVERYTHING2MCP_DISCOVERY_TIMEOUT_MS ?? 2500),
    },
    transport: {
      kind: parseTransportKind(env.EVERYTHING2MCP_TRANSPORT),
      host: env.EVERYTHING2MCP_HTTP_HOST?.trim() || "127.0.0.1",
      port,
      mcpPath: normalizePath(env.EVERYTHING2MCP_HTTP_PATH, "/mcp"),
      ssePath: normalizePath(env.EVERYTHING2MCP_SSE_PATH, "/sse"),
      messagesPath: normalizePath(env.EVERYTHING2MCP_SSE_MESSAGES_PATH, "/messages"),
      ...(token ? { token } : {}),
      ...(tokenHeader ? { tokenHeader } : {}),
    },
    rateLimit: {
      invokePerMinute: finiteRate(env.EVERYTHING2MCP_RATE_LIMIT_INVOKE, 60),
      discoverPerMinute: finiteRate(env.EVERYTHING2MCP_RATE_LIMIT_DISCOVER, 20),
    },
  };
}

function finiteRate(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
