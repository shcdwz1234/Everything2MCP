import { AdapterError } from "../runtime/errors.js";
import { assertHostAllowed } from "../runtime/ssrf.js";
import type { DiscoveryCandidate } from "../runtime/types.js";
import { looksLikeNetworkRange } from "./probe.js";
import { udpExchange } from "./net.js";

export const SSDP_PORT = 1900;

/** Multicast LAN browse stays disabled (would be a network scan). */
export function mdnsDiscover(): never {
  throw new AdapterError(
    "E_UNSUPPORTED",
    "mDNS multicast browse is disabled. Use mdnsUnicastQuery on a single host:5353 or ssdpUnicastSearch on host:1900 (not 224.0.0.251 / 239.255.255.250).",
  );
}

export function encodeSsdpMsearch(host: string, port = SSDP_PORT, st = "upnp:rootdevice"): Buffer {
  return Buffer.from(
    `M-SEARCH * HTTP/1.1\r\nHOST: ${host}:${port}\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: ${st}\r\n\r\n`,
    "utf8",
  );
}

export function parseSsdpResponse(buf: Buffer): { location?: string; st?: string; usn?: string; server?: string } | undefined {
  const text = buf.toString("utf8");
  if (!/^HTTP\/1\.[01]\s+200/i.test(text)) return undefined;
  const header = (name: string) => {
    const m = text.match(new RegExp(`^${name}\\s*:\\s*(.+)$`, "im"));
    return m?.[1]?.trim();
  };
  return {
    location: header("LOCATION"),
    st: header("ST"),
    usn: header("USN"),
    server: header("SERVER"),
  };
}

/**
 * Unicast M-SEARCH to one host:port (default 1900).
 * Does **not** send to 239.255.255.250 and never accepts a CIDR host.
 */
export async function ssdpUnicastSearch(opts: {
  host: string;
  port?: number;
  timeoutMs: number;
  st?: string;
}): Promise<DiscoveryCandidate | undefined> {
  if (looksLikeNetworkRange(opts.host)) {
    throw new AdapterError("E_UNSUPPORTED", "Host looks like a range; single host/IP only");
  }
  await assertHostAllowed(opts.host);
  const port = opts.port ?? SSDP_PORT;
  const buf = await udpExchange(opts.host, port, encodeSsdpMsearch(opts.host, port, opts.st), opts.timeoutMs);
  if (!buf) return undefined;
  const parsed = parseSsdpResponse(buf);
  if (!parsed?.location) return undefined;
  return {
    protocol: "openapi",
    url: parsed.location,
    hint: "Unicast SSDP LOCATION — schema_import or discovery_probe this URL (not a LAN browse)",
    status: 200,
    title: parsed.st ?? parsed.server ?? "ssdp",
    confidence: 0.58,
    detail: [parsed.st, parsed.usn, parsed.server].filter(Boolean).join(" | "),
    config: { spec: parsed.location },
  };
}
