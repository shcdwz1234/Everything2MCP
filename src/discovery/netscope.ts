import { isIP } from "node:net";
import { isBlockedIp, parseIpv4Literal } from "../runtime/ssrf.js";
import { AdapterError } from "../runtime/errors.js";

/**
 * Address-scope helpers for auto-discovery (S4). Kept separate from
 * looksLikeNetworkRange / scanHost: the single-host tool API still refuses
 * ranges; only the auto-discovery engine expands bounded private CIDRs into
 * individual hosts and then calls scanHost once per host.
 *
 * "Private" (auto-scannable without opt-in):
 *   10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16  (RFC 1918)
 *   100.64.0.0/10                               (RFC 6598 CGNAT / Tailscale-style overlays)
 *   127.0.0.0/8                                 (loopback)
 *   fc00::/7 (ULA) and ::1                      (single IPv6 hosts only, never expanded)
 * Never scanned, even with allowPublic: 169.254.0.0/16 link-local, fe80::/10,
 * and everything isBlockedIp() blocks (cloud metadata endpoints).
 */
const PRIVATE_V4: Array<[string, number]> = [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
];

export const PRIVATE_RANGES_DOC = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10 (CGNAT)",
  "127.0.0.0/8",
  "fc00::/7 (单主机)",
];

export const NEVER_SCAN_DOC = ["169.254.0.0/16 link-local", "fe80::/10", "云元数据地址 (169.254.169.254, fd00:ec2::254, metadata.google.internal…)"];

/** Largest manual CIDR accepted (/16 = 65 534 hosts; the per-run host cap still applies). */
export const MIN_MANUAL_PREFIX = 16;
/** Auto (interface-derived) subnets are clamped to at most a /24 around our address. */
export const AUTO_PREFIX_CAP = 24;

function toInt(ip: string): number {
  const n = parseIpv4Literal(ip);
  if (n === undefined) throw new AdapterError("E_INVALID_ARGUMENT", `Not an IPv4 address: ${ip}`);
  return n >>> 0;
}

export function intToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

function maskOf(bits: number): number {
  return bits === 0 ? 0 : (~((1 << (32 - bits)) - 1)) >>> 0;
}

function inRange(ip: number, net: string, bits: number): boolean {
  const m = maskOf(bits);
  return ((ip & m) >>> 0) === ((toInt(net) & m) >>> 0);
}

export function isLinkLocal(ip: string): boolean {
  const v4 = parseIpv4Literal(ip);
  if (v4 !== undefined) return inRange(v4 >>> 0, "169.254.0.0", 16);
  return ip.toLowerCase().startsWith("fe8") || ip.toLowerCase().startsWith("fe9") || ip.toLowerCase().startsWith("fea") || ip.toLowerCase().startsWith("feb");
}

export function isPrivateIp(ip: string): boolean {
  const v4 = parseIpv4Literal(ip);
  if (v4 !== undefined) return PRIVATE_V4.some(([net, bits]) => inRange(v4 >>> 0, net, bits));
  const h = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "::1") return true;
  return /^f[cd][0-9a-f]{2}:/.test(h);
}

/** Never scan: link-local + metadata, regardless of allowPublic. */
export function isNeverScan(ip: string): boolean {
  return isLinkLocal(ip) || isBlockedIp(ip);
}

export function prefixToNetmaskBits(netmask: string): number {
  const n = toInt(netmask);
  let bits = 0;
  for (let i = 31; i >= 0; i--) {
    if ((n >>> i) & 1) bits++;
    else break;
  }
  return bits;
}

export interface ParsedCidr {
  network: string;
  prefix: number;
}

export function parseCidr(raw: string): ParsedCidr | undefined {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(raw.trim());
  if (!m) return undefined;
  const prefix = Number(m[2]);
  if (prefix < 0 || prefix > 32 || parseIpv4Literal(m[1]!) === undefined) return undefined;
  const net = (toInt(m[1]!) & maskOf(prefix)) >>> 0;
  return { network: intToIp(net), prefix };
}

/** Host addresses of an IPv4 CIDR (network/broadcast dropped for prefix ≤ 30), at most `cap`. */
export function expandCidr(cidr: ParsedCidr, cap: number): { hosts: string[]; truncated: boolean } {
  const base = toInt(cidr.network);
  const size = 2 ** (32 - cidr.prefix);
  const first = cidr.prefix >= 31 ? 0 : 1;
  const last = cidr.prefix >= 31 ? size - 1 : size - 2;
  const hosts: string[] = [];
  for (let i = first; i <= last; i++) {
    if (hosts.length >= cap) return { hosts, truncated: true };
    hosts.push(intToIp((base + i) >>> 0));
  }
  return { hosts, truncated: false };
}

export interface InterfaceAddr {
  family: string | number;
  address: string;
  netmask: string;
  internal: boolean;
}

/** Private IPv4 subnets from local interfaces, each clamped to ≤ /24 around our address. */
export function subnetsFromInterfaces(ifaces: Record<string, InterfaceAddr[] | undefined>): Array<{ iface: string; cidr: ParsedCidr; self: string }> {
  const out: Array<{ iface: string; cidr: ParsedCidr; self: string }> = [];
  const seen = new Set<string>();
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs ?? []) {
      const fam = typeof a.family === "number" ? `IPv${a.family}` : a.family;
      if (fam !== "IPv4" || a.internal) continue;
      if (!isPrivateIp(a.address) || isNeverScan(a.address)) continue;
      if (a.address.startsWith("127.")) continue;
      let prefix = 24;
      try {
        prefix = prefixToNetmaskBits(a.netmask);
      } catch {
        /* default /24 */
      }
      prefix = Math.max(prefix, AUTO_PREFIX_CAP);
      const net = (toInt(a.address) & maskOf(prefix)) >>> 0;
      const cidr = { network: intToIp(net), prefix };
      const key = `${cidr.network}/${prefix}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ iface: name, cidr, self: a.address });
    }
  }
  return out;
}

export type ScopeKind = "ip" | "cidr" | "domain";

export interface ScopeEntry {
  raw: string;
  kind: ScopeKind;
}

const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i;

/**
 * Validate one manual scope entry (host IP, domain, or CIDR).
 * Public IPs / CIDRs require allowPublic. Link-local + metadata always refused.
 * Domains are resolved at run time and each resolved address is re-checked.
 */
export function parseScopeEntry(raw: string, allowPublic: boolean): ScopeEntry {
  const s = raw.trim();
  if (!s) throw new AdapterError("E_INVALID_ARGUMENT", "empty scope entry");
  const cidr = parseCidr(s);
  if (cidr) {
    if (cidr.prefix < MIN_MANUAL_PREFIX) {
      throw new AdapterError("E_INVALID_ARGUMENT", `CIDR ${s} is larger than /${MIN_MANUAL_PREFIX}; split it into smaller ranges`, {
        details: { scope: s },
      });
    }
    const netIp = cidr.network;
    const lastIp = intToIp((toInt(netIp) + 2 ** (32 - cidr.prefix) - 1) >>> 0);
    if (isNeverScan(netIp) || isNeverScan(lastIp)) {
      throw new AdapterError("E_UNSUPPORTED", `Refusing link-local / metadata range ${s}`, { details: { scope: s } });
    }
    if (!allowPublic && !(isPrivateIp(netIp) && isPrivateIp(lastIp))) {
      throw new AdapterError("E_UNSUPPORTED", `Public range ${s} needs allowPublic=true`, { details: { scope: s } });
    }
    return { raw: `${cidr.network}/${cidr.prefix}`, kind: "cidr" };
  }
  const bare = s.replace(/^\[|\]$/g, "");
  if (isIP(bare)) {
    if (isNeverScan(bare)) throw new AdapterError("E_UNSUPPORTED", `Refusing link-local / metadata host ${s}`, { details: { scope: s } });
    if (!allowPublic && !isPrivateIp(bare)) {
      throw new AdapterError("E_UNSUPPORTED", `Public host ${s} needs allowPublic=true`, { details: { scope: s } });
    }
    return { raw: bare, kind: "ip" };
  }
  if (DOMAIN.test(s) && !s.includes("*")) {
    const lower = s.toLowerCase().replace(/\.$/, "");
    if (lower === "metadata" || lower.includes("metadata.google") || lower.endsWith(".internal") && lower.includes("metadata")) {
      throw new AdapterError("E_UNSUPPORTED", `Refusing metadata hostname ${s}`, { details: { scope: s } });
    }
    return { raw: lower, kind: "domain" };
  }
  throw new AdapterError("E_INVALID_ARGUMENT", `Unrecognized scope entry: ${s} (host, domain, or a.b.c.d/nn)`, {
    details: { scope: s },
  });
}

/** Exclusion match: exact IP/host, or IPv4 inside an excluded CIDR. */
export function isExcluded(host: string, exclude: string[]): boolean {
  const h = host.toLowerCase();
  for (const raw of exclude) {
    const e = raw.trim().toLowerCase();
    if (!e) continue;
    if (e === h) return true;
    const c = parseCidr(e);
    if (c && parseIpv4Literal(h) !== undefined && inRange(toInt(h), c.network, c.prefix)) return true;
  }
  return false;
}
