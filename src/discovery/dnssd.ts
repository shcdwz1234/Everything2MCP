import { AdapterError } from "../runtime/errors.js";
import { assertHostAllowed } from "../runtime/ssrf.js";
import type { DiscoveryCandidate } from "../runtime/types.js";
import { looksLikeNetworkRange } from "./probe.js";
import { udpExchange } from "./net.js";

export const MDNS_PORT = 5353;
export const MDNS_MULTICAST = "224.0.0.251";

export const DNS_TYPE_PTR = 12;
export const DNS_TYPE_SRV = 33;
export const DNS_TYPE_TXT = 16;
export const DNS_TYPE_A = 1;

export interface DnsRecord {
  name: string;
  type: number;
  ttl: number;
  data: string;
}

export function encodeDnsName(name: string): Buffer {
  const labels = name.replace(/\.$/, "").split(".").filter(Boolean);
  const parts = labels.map((label) => {
    const b = Buffer.from(label, "utf8");
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  return Buffer.concat([...parts, Buffer.from([0])]);
}

export function decodeDnsName(buf: Buffer, offset: number): { name: string; next: number } {
  const labels: string[] = [];
  let o = offset;
  let jumped = false;
  let next = offset;
  let hops = 0;
  while (o < buf.length && hops < 16) {
    const len = buf[o]!;
    if (len === 0) {
      if (!jumped) next = o + 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      const ptr = ((len & 0x3f) << 8) | buf[o + 1]!;
      if (!jumped) next = o + 2;
      o = ptr;
      jumped = true;
      hops += 1;
      continue;
    }
    labels.push(buf.subarray(o + 1, o + 1 + len).toString("utf8"));
    o += 1 + len;
    if (!jumped) next = o;
  }
  return { name: labels.join("."), next };
}

/** Standard DNS query (QDCOUNT=1). Used for unicast DNS-SD / mDNS to one host:5353. */
export function encodeDnsQuery(qname: string, type = DNS_TYPE_PTR, id = 0x1234): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id & 0xffff, 0);
  header.writeUInt16BE(0, 2);
  header.writeUInt16BE(1, 4);
  const q = Buffer.alloc(4);
  q.writeUInt16BE(type, 0);
  q.writeUInt16BE(1, 2);
  return Buffer.concat([header, encodeDnsName(qname), q]);
}

export function decodeDnsMessage(buf: Buffer): { id: number; answers: DnsRecord[] } {
  if (buf.length < 12) return { id: 0, answers: [] };
  const id = buf.readUInt16BE(0);
  const ancount = buf.readUInt16BE(6);
  const nscount = buf.readUInt16BE(8);
  const arcount = buf.readUInt16BE(10);
  let o = 12;
  const skipName = () => {
    const d = decodeDnsName(buf, o);
    o = d.next;
    return d.name;
  };
  skipName();
  o += 4;
  const answers: DnsRecord[] = [];
  const total = ancount + nscount + arcount;
  for (let i = 0; i < total && o + 10 <= buf.length; i += 1) {
    const name = skipName();
    const type = buf.readUInt16BE(o);
    o += 4;
    const ttl = buf.readUInt32BE(o);
    o += 4;
    const rdlen = buf.readUInt16BE(o);
    o += 2;
    const rstart = o;
    const rdata = buf.subarray(o, o + rdlen);
    o += rdlen;
    let data = rdata.toString("utf8");
    if (type === DNS_TYPE_PTR) {
      data = decodeDnsName(buf, rstart).name;
    } else if (type === DNS_TYPE_A && rdata.length === 4) {
      data = `${rdata[0]}.${rdata[1]}.${rdata[2]}.${rdata[3]}`;
    }
    answers.push({ name, type, ttl, data });
  }
  return { id, answers };
}

/** Encode a single PTR answer (for hermetic loopback). */
export function encodeDnsPtrResponse(qname: string, ptr: string, id = 0x1234): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(1, 6);
  const q = Buffer.alloc(4);
  q.writeUInt16BE(DNS_TYPE_PTR, 0);
  q.writeUInt16BE(1, 2);
  const ptrName = encodeDnsName(ptr);
  const rrHead = Buffer.alloc(10);
  rrHead.writeUInt16BE(DNS_TYPE_PTR, 0);
  rrHead.writeUInt16BE(1, 2);
  rrHead.writeUInt32BE(120, 4);
  rrHead.writeUInt16BE(ptrName.length, 8);
  return Buffer.concat([header, encodeDnsName(qname), q, encodeDnsName(qname), rrHead, ptrName]);
}

function protocolFromService(
  name: string,
  host: string,
): { protocol: string; config: Record<string, unknown> } {
  const n = name.toLowerCase();
  if (n.includes("_imap")) return { protocol: "imap", config: { host, port: 143, allowWrite: false } };
  if (n.includes("_pop3") || n.includes("_pop")) return { protocol: "pop3", config: { host, port: 110, allowWrite: false } };
  if (n.includes("_ftp")) return { protocol: "ftp", config: { host, port: 21, allowWrite: false } };
  if (n.includes("_consul")) return { protocol: "consul", config: { url: `http://${host}:8500`, allowWrite: false } };
  return { protocol: "openapi", config: { spec: `http://${host}/${name}` } };
}

/**
 * Unicast DNS-SD / mDNS query to one host:port (default 5353).
 * Never sends to 224.0.0.251.
 */
export async function mdnsUnicastQuery(opts: {
  host: string;
  port?: number;
  timeoutMs: number;
  name?: string;
}): Promise<DiscoveryCandidate | undefined> {
  if (looksLikeNetworkRange(opts.host)) {
    throw new AdapterError("E_UNSUPPORTED", "Host looks like a range; single host/IP only");
  }
  if (opts.host === MDNS_MULTICAST) {
    throw new AdapterError("E_UNSUPPORTED", "mDNS multicast 224.0.0.251 is disabled (would browse the LAN)");
  }
  await assertHostAllowed(opts.host);
  const qname = opts.name ?? "_services._dns-sd._udp.local";
  const port = opts.port ?? MDNS_PORT;
  const buf = await udpExchange(opts.host, port, encodeDnsQuery(qname), opts.timeoutMs);
  if (!buf) return undefined;
  const decoded = decodeDnsMessage(buf);
  const ptr = decoded.answers.find((a) => a.type === DNS_TYPE_PTR) ?? decoded.answers[0];
  if (!ptr) return undefined;
  const mapped = protocolFromService(ptr.data || qname, opts.host);
  return {
    protocol: mapped.protocol,
    url: `dnssd://${opts.host}:${port}/${ptr.data || qname}`,
    hint: "Unicast DNS-SD PTR — not a multicast LAN browse",
    status: 1,
    title: ptr.data || qname,
    confidence: 0.62,
    detail: decoded.answers.map((a) => a.data).join(" | "),
    config: mapped.config,
  };
}

export function mdnsMulticastBrowse(): never {
  throw new AdapterError(
    "E_UNSUPPORTED",
    "mDNS multicast browse (224.0.0.251) is disabled. Use mdnsUnicastQuery on a single host:5353.",
  );
}
