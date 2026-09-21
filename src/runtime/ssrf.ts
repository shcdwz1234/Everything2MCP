import { lookup } from "node:dns/promises";
import { AdapterError } from "./errors.js";

/** Cloud metadata, link-local IMDS, and other non-probeable destinations. */
const BLOCKED_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.google.com",
  "metadata",
  "instance-data",
  "kubernetes.default",
  "kubernetes.default.svc",
]);

const BLOCKED_IPV4: Array<[number, number]> = [
  [ipv4("169.254.169.254"), 32],
  [ipv4("169.254.170.2"), 32],
  [ipv4("169.254.169.253"), 32],
  [ipv4("100.100.100.200"), 32],
  [ipv4("169.254.169.0"), 24],
  [ipv4("0.0.0.0"), 32],
  [ipv4("255.255.255.255"), 32],
];

const BLOCKED_IPV6 = new Set(["fd00:ec2::254", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe"]);

function ipv4(dotted: string): number {
  const p = dotted.split(".").map((x) => Number(x));
  return ((p[0]! << 24) | (p[1]! << 16) | (p[2]! << 8) | p[3]!) >>> 0;
}

function inCidr(ip: number, network: number, bits: number): boolean {
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return (ip & mask) === (network & mask);
}

export function parseIpv4Literal(host: string): number | undefined {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return undefined;
  const parts = host.split(".").map((x) => Number(x));
  if (parts.some((n) => n > 255)) return undefined;
  return ipv4(host);
}

export function isBlockedIp(ip: string): boolean {
  const trimmed = stripZone(ip);
  const v4 = parseIpv4Literal(trimmed);
  if (v4 !== undefined) {
    return BLOCKED_IPV4.some(([net, bits]) => inCidr(v4, net, bits));
  }
  const mapped = trimmed.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped?.[1]) return isBlockedIp(mapped[1]);
  const compact = trimmed.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_IPV6.has(compact)) return true;
  if (compact.startsWith("fe80:")) return true;
  return false;
}

export function isBlockedHostname(host: string): boolean {
  const h = stripBrackets(host).trim().toLowerCase();
  if (!h) return true;
  if (BLOCKED_HOSTS.has(h)) return true;
  if (h.endsWith(".internal") && h.includes("metadata")) return true;
  return isBlockedIp(h);
}

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function stripZone(host: string): string {
  return stripBrackets(host).split("%")[0] ?? host;
}

export function hostnameOf(hostOrHostPort: string): string {
  const s = hostOrHostPort.trim();
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    return end >= 0 ? s.slice(1, end) : s;
  }
  const colon = s.lastIndexOf(":");
  if (colon > 0 && /^\d+$/.test(s.slice(colon + 1)) && s.includes(".")) return s.slice(0, colon);
  return s;
}

export async function resolveAllowed(host: string): Promise<string[]> {
  const hostname = hostnameOf(host);
  if (isBlockedHostname(hostname)) throw blocked(hostname);
  const literal = parseIpv4Literal(hostname);
  if (literal !== undefined) return [hostname];
  if (hostname.includes(":") && isBlockedIp(hostname)) throw blocked(hostname);

  let records: Array<{ address: string }>;
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    return [];
  }
  const addrs = records.map((r) => r.address);
  for (const addr of addrs) {
    if (isBlockedIp(addr) || isBlockedHostname(addr)) throw blocked(`${hostname} → ${addr}`);
  }
  return addrs;
}

export async function assertHostAllowed(host: string): Promise<void> {
  const hostname = hostnameOf(host);
  if (!hostname) {
    throw new AdapterError("E_UNSUPPORTED", "Empty host is not allowed", { details: { host } });
  }
  if (isBlockedHostname(hostname)) throw blocked(hostname);
  await resolveAllowed(hostname);
}

export async function assertUrlAllowed(url: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AdapterError("E_INVALID_ARGUMENT", `Invalid URL: ${url}`, { details: { url } });
  }
  if (parsed.username || parsed.password) {
    throw new AdapterError("E_UNSUPPORTED", "URLs with userinfo are not allowed", { details: { url } });
  }
  const protocol = parsed.protocol.toLowerCase();
  const okProto = [
    "http:",
    "https:",
    "mqtt:",
    "mqtts:",
    "redis:",
    "rediss:",
    "amqp:",
    "amqps:",
    "ws:",
    "wss:",
    "tcp:",
    "grpc:",
    "nats:",
    "coap:",
    "coaps:",
    "ldap:",
    "ldaps:",
    "opc.tcp:",
    "kafka:",
    "postgres:",
    "postgresql:",
    "mysql:",
    "mongodb:",
    "bolt:",
    "sqlserver:",
    "mssql:",
  ];
  if (!okProto.includes(protocol) && protocol !== "file:") {
    throw new AdapterError("E_UNSUPPORTED", `Refusing URL scheme ${protocol}`, { details: { url } });
  }
  if (protocol !== "file:") {
    await assertHostAllowed(parsed.hostname);
  }
  return parsed;
}

export async function fetchSafe(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
  hops = 0,
): Promise<Response> {
  await assertUrlAllowed(url);
  if (hops > 5) {
    throw new AdapterError("E_UNSUPPORTED", "Too many redirects", { details: { url } });
  }
  const timeoutMs = init.timeoutMs ?? 2500;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, redirect: "manual", signal: ac.signal });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      const next = new URL(loc, url).toString();
      await assertUrlAllowed(next);
      return fetchSafe(next, { ...init, timeoutMs }, hops + 1);
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function blocked(target: string): AdapterError {
  return new AdapterError(
    "E_UNSUPPORTED",
    `Refusing to contact blocked metadata/link-local address: ${target}`,
    { details: { target } },
  );
}
