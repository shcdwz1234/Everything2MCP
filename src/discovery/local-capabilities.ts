import { canonicalProtocol } from "../catalog/validate.js";
import type { EnvironmentSuggestion } from "./environment-suggest.js";

/**
 * Local/platform capabilities that are not produced by network port fingerprinting.
 * Surfaced from environment inventory during auto-discovery (especially self/localhost).
 */
export const LOCAL_PLATFORM_PROTOCOLS = new Set([
  "os_info",
  "platform_fs",
  "platform_process",
  "platform_service",
  "browser",
  "docker",
  "podman",
  "journal",
  "smb",
  "cifs",
  "nfs",
]);

/** Stable candidate id — not host:port (these are not scan hits). */
export function localCandidateId(protocol: string): string {
  return `${canonicalProtocol(protocol)}|local`;
}

export function isLocalPlatformProtocol(protocol: string): boolean {
  return LOCAL_PLATFORM_PROTOCOLS.has(canonicalProtocol(protocol));
}

/**
 * Filter environment suggestions to local/platform caps only.
 * Port-based suggestions (redis@6379, …) stay out — network scan already covers them.
 */
export function filterLocalPlatformSuggestions(suggestions: EnvironmentSuggestion[]): EnvironmentSuggestion[] {
  const out: EnvironmentSuggestion[] = [];
  const seen = new Set<string>();
  for (const s of suggestions) {
    const protocol = canonicalProtocol(s.protocol);
    if (!LOCAL_PLATFORM_PROTOCOLS.has(protocol)) continue;
    // Skip TCP-style inventory hits that mirror port fingerprinting.
    if (/Listening TCP/i.test(s.reason)) continue;
    if (seen.has(protocol)) continue;
    seen.add(protocol);
    out.push({ ...s, protocol });
  }
  return out;
}

export function localCapabilityUrl(protocol: string): string {
  return `local://${canonicalProtocol(protocol)}`;
}
