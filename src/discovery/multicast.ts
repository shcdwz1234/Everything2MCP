import { createSocket } from "node:dgram";
import { decodeDnsMessage, encodeDnsQuery, MDNS_MULTICAST, MDNS_PORT } from "./dnssd.js";
import { encodeSsdpMsearch, parseSsdpResponse, SSDP_PORT } from "./ssdp.js";
import { isNeverScan, isPrivateIp } from "./netscope.js";

/**
 * Opt-in LAN multicast browse used only by the auto-discovery engine (S4).
 * The legacy `mdnsMulticastBrowse()` / `mdnsDiscover()` helpers keep throwing
 * E_UNSUPPORTED so the single-host tool API is unchanged; this module is the
 * separate, bounded path the scheduler calls:
 *   - one query, fixed listen window (default 1500 ms), max 64 responders
 *   - only private, non-link-local, non-metadata responders are returned
 *   - responders become *hosts to fingerprint*, never registrations
 */
export interface MulticastHit {
  host: string;
  via: "mdns" | "ssdp";
  name?: string;
  location?: string;
}

export const SSDP_MULTICAST = "239.255.255.250";
const MAX_RESPONDERS = 64;

function collect(
  group: string,
  port: number,
  payload: Buffer,
  timeoutMs: number,
  onMessage: (msg: Buffer, from: string) => MulticastHit | undefined,
): Promise<MulticastHit[]> {
  return new Promise((resolve) => {
    const hits = new Map<string, MulticastHit>();
    let socket: ReturnType<typeof createSocket>;
    try {
      socket = createSocket({ type: "udp4", reuseAddr: true });
    } catch {
      resolve([]);
      return;
    }
    const finish = () => {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      resolve([...hits.values()]);
    };
    const timer = setTimeout(finish, timeoutMs);
    socket.on("error", () => {
      clearTimeout(timer);
      finish();
    });
    socket.on("message", (msg, rinfo) => {
      const from = rinfo.address;
      if (!isPrivateIp(from) || isNeverScan(from) || hits.has(from)) return;
      try {
        const hit = onMessage(msg, from);
        if (hit) hits.set(from, hit);
      } catch {
        /* malformed */
      }
      if (hits.size >= MAX_RESPONDERS) {
        clearTimeout(timer);
        finish();
      }
    });
    socket.bind(0, () => {
      try {
        socket.setMulticastTTL(1);
        socket.send(payload, port, group);
      } catch {
        clearTimeout(timer);
        finish();
      }
    });
  });
}

/** mDNS PTR browse for `_services._dns-sd._udp.local` on 224.0.0.251:5353 (TTL 1). */
export function mdnsMulticastQuery(timeoutMs = 1500): Promise<MulticastHit[]> {
  return collect(MDNS_MULTICAST, MDNS_PORT, encodeDnsQuery("_services._dns-sd._udp.local", 12, 0), timeoutMs, (msg, from) => {
    const decoded = decodeDnsMessage(msg);
    const name = decoded.answers.map((a) => a.data).filter(Boolean).slice(0, 3).join(", ");
    return { host: from, via: "mdns", name: name || undefined };
  });
}

/** SSDP M-SEARCH ssdp:all to 239.255.255.250:1900 (TTL 1). */
export function ssdpMulticastSearch(timeoutMs = 1500): Promise<MulticastHit[]> {
  return collect(SSDP_MULTICAST, SSDP_PORT, encodeSsdpMsearch(SSDP_MULTICAST, SSDP_PORT, "ssdp:all"), timeoutMs, (msg, from) => {
    const parsed = parseSsdpResponse(msg);
    if (!parsed) return undefined;
    return { host: from, via: "ssdp", name: parsed.server, location: parsed.location };
  });
}
