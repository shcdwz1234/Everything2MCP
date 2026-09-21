import { looksLikeNetworkRange } from "../discovery/probe.js";
import { AdapterError } from "../runtime/errors.js";
import { assertHostAllowed, assertUrlAllowed } from "../runtime/ssrf.js";
import type { JsonObject } from "../runtime/types.js";

/**
 * Refuse CIDR / range / wildcard hosts. The allowScan argument is ignored
 * (EVERYTHING2MCP_DISCOVERY_ALLOW_SCAN is a dead env and cannot re-enable CIDR).
 */
export function assertHostProbeAllowed(host: string, _allowScan = false): void {
  if (looksLikeNetworkRange(host)) {
    throw new AdapterError(
      "E_UNSUPPORTED",
      "Refusing to scan a network range. CIDR / ranges / wildcards are never allowed (Safe and Full).",
    );
  }
}

export async function assertProbeTarget(host: string, _allowScan = false): Promise<void> {
  assertHostProbeAllowed(host, false);
  await assertHostAllowed(host);
}

/** Reject metadata/link-local URLs in mcp_add configs. */
export async function assertConfigTargetsAllowed(config: JsonObject): Promise<void> {
  for (const value of Object.values(config)) {
    if (typeof value !== "string" || !value.trim()) continue;
    if (/^(https?|mqtts?|rediss?|amqps?|wss?|nats|coaps?|ldaps?|grpc|tcp|opc\.tcp|kafka|postgres(ql)?|mysql|mongodb|bolt|sqlserver|mssql):/i.test(value)) {
      await assertUrlAllowed(value);
      continue;
    }
    if (/^file:|^[./]/i.test(value)) continue;
    if (/^[A-Za-z0-9.-]+:\d+$/.test(value) || /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/.test(value)) {
      await assertHostAllowed(value);
    }
  }
}

/** Reserved hook for later allowlists / rate limits. No-op today. */
export function allowRegistration(_protocol: string, _name: string): void {
  /* policy no-op */
}
