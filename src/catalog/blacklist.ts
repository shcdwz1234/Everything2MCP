import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AdapterError } from "../runtime/errors.js";
import type { DiscoveryCandidate, JsonObject } from "../runtime/types.js";
import { canonicalProtocol } from "./validate.js";

export interface BlacklistTarget {
  protocol: string;
  host: string;
  port: number;
  url?: string;
}

export interface BlacklistEntry extends BlacklistTarget {
  id: string;
  reason?: string;
  createdAt: string;
}

export interface BlacklistFile {
  version: 1;
  entries: BlacklistEntry[];
}

/**
 * Matching rules (also docs/BLACKLIST.md):
 * - protocol is canonical (pg→postgres, enip→ethernetip, …)
 * - host is lowercased, IPv6 brackets stripped, trailing dot stripped
 * - port is numeric; taken from URL / config.port / first broker / protocol default
 * - fallback id is `protocol|url:<normalized url>` when there is no host:port
 * - a hit is exact id equality (protocol + host + port, or protocol + normalized url)
 */
export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

export function normalizeUrl(raw: string): string {
  const parsed = parseNetworkUrl(raw);
  if (parsed) {
    return `${parsed.protocolHint ?? "tcp"}://${parsed.host}${parsed.port ? `:${parsed.port}` : ""}`;
  }
  return raw.trim().replace(/\/+$/, "").toLowerCase();
}

export function blacklistId(target: Pick<BlacklistTarget, "protocol" | "host" | "port" | "url">): string {
  const protocol = canonicalProtocol(target.protocol);
  if (target.host && target.port > 0) return `${protocol}|${normalizeHost(target.host)}|${target.port}`;
  if (target.url && target.url.trim()) return `${protocol}|url:${normalizeUrl(target.url)}`;
  throw new AdapterError("E_INVALID_ARGUMENT", "Blacklist entry needs protocol plus host+port or a network url", {
    protocol,
  });
}

const DEFAULT_PORT: Record<string, number> = {
  openapi: 80,
  http: 80,
  https: 443,
  soap: 80,
  graphql: 80,
  grpc: 50051,
  mqtt: 1883,
  redis: 6379,
  nats: 4222,
  amqp: 5672,
  kafka: 9092,
  websocket: 80,
  jsonrpc: 80,
  xmlrpc: 80,
  postgres: 5432,
  mysql: 3306,
  sqlserver: 1433,
  mongodb: 27017,
  elasticsearch: 9200,
  clickhouse: 8123,
  neo4j: 7687,
  qdrant: 6333,
  s3: 9000,
  prometheus: 9090,
  pulsar: 6650,
  gcs: 443,
  oss: 80,
  influx: 8086,
  opcua: 4840,
  modbus: 502,
  coap: 5683,
  bacnet: 47808,
  ethernetip: 44818,
  enip: 44818,
  s7: 102,
  mtconnect: 80,
  smtp: 587,
  ldap: 389,
  ftp: 21,
  snmp: 161,
  etcd: 2379,
  webdav: 80,
  imap: 143,
  pop3: 110,
  consul: 8500,
  azureblob: 10000,
  sftp: 22,
  memcached: 11211,
  tftp: 69,
  caldav: 5232,
  carddav: 5232,
  beanstalkd: 11300,
  zookeeper: 2181,
  dns: 53,
  cassandra: 9042,
  couchdb: 5984,
  whois: 43,
  solr: 8983,
  rabbitmq: 15672,
  kubernetes: 6443,
  k8s: 6443,
  docker: 2375,
  podman: 2375,
  smb: 445,
  cifs: 445,
  nfs: 2049,
  vault: 8200,
  openbao: 8200,
  alertmanager: 9093,
  pubsub: 8085,
  jira: 8080,
  opensearch: 9200,
  fix: 9876,
};

function defaultPort(protocol: string): number {
  return DEFAULT_PORT[canonicalProtocol(protocol)] ?? 0;
}

function parseHostPort(raw: string): { host: string; port: number } | undefined {
  const s = raw.trim();
  const ipv6 = /^\[([^\]]+)\]:(\d+)$/.exec(s);
  if (ipv6) {
    const port = Number(ipv6[2]);
    const host = normalizeHost(ipv6[1]!);
    if (host && Number.isFinite(port) && port > 0) return { host, port };
  }
  if (!s.includes("://")) {
    const lastColon = s.lastIndexOf(":");
    if (lastColon > 0) {
      const host = normalizeHost(s.slice(0, lastColon));
      const port = Number(s.slice(lastColon + 1));
      if (host && Number.isFinite(port) && port > 0) return { host, port };
    }
  }
  const host = normalizeHost(s);
  return host ? { host, port: 0 } : undefined;
}

function parseNetworkUrl(raw: string): { host: string; port: number; protocolHint?: string } | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith(".") ||
    trimmed.startsWith("file:") ||
    trimmed === ":memory:" ||
    trimmed.startsWith("memory:")
  ) {
    return undefined;
  }
  try {
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `tcp://${trimmed}`;
    const u = new URL(withScheme);
    const host = normalizeHost(u.hostname);
    if (!host) return undefined;
    let port = Number(u.port);
    if (!Number.isFinite(port) || port <= 0) {
      if (u.protocol === "https:" || u.protocol === "wss:") port = 443;
      else if (u.protocol === "http:" || u.protocol === "ws:") port = 80;
      else port = 0;
    }
    return { host, port, protocolHint: u.protocol.replace(/:$/, "") };
  } catch {
    return parseHostPort(trimmed);
  }
}

const URL_KEYS = ["url", "endpoint", "serviceUrl", "brokerUrl", "baseUrl", "adminUrl", "wsdl", "spec", "invokeUrl"];

export function targetFromConfig(protocol: string, config: JsonObject): BlacklistTarget | undefined {
  const canon = canonicalProtocol(protocol);
  for (const key of URL_KEYS) {
    const v = config[key];
    if (typeof v === "string" && v.trim()) {
      const parsed = parseNetworkUrl(v);
      if (parsed) {
        const port = parsed.port > 0 ? parsed.port : defaultPort(canon);
        if (parsed.host && port > 0) {
          return { protocol: canon, host: parsed.host, port, url: normalizeUrl(v) };
        }
      }
    }
  }
  const target = typeof config.target === "string" ? parseNetworkUrl(config.target) : undefined;
  if (target?.host) {
    const port = target.port > 0 ? target.port : defaultPort(canon);
    if (port > 0) return { protocol: canon, host: target.host, port, url: normalizeUrl(String(config.target)) };
  }
  const brokers = config.brokers;
  if (Array.isArray(brokers) && typeof brokers[0] === "string") {
    const first = parseNetworkUrl(brokers[0]);
    if (first?.host) {
      const port = first.port > 0 ? first.port : defaultPort(canon);
      if (port > 0) return { protocol: canon, host: first.host, port };
    }
  }
  const hostRaw = typeof config.host === "string" ? config.host : undefined;
  if (hostRaw) {
    const host = normalizeHost(hostRaw);
    const port =
      typeof config.port === "number" && config.port > 0 ? config.port : defaultPort(canon);
    if (host && port > 0) return { protocol: canon, host, port };
  }
  return undefined;
}

export function targetFromUrl(protocol: string, url: string): BlacklistTarget | undefined {
  return targetFromConfig(protocol, { url });
}

export function targetFromCandidate(candidate: DiscoveryCandidate): BlacklistTarget | undefined {
  if (candidate.config) {
    const fromConfig = targetFromConfig(candidate.protocol, candidate.config);
    if (fromConfig) return fromConfig;
  }
  return targetFromUrl(candidate.protocol, candidate.url);
}

export function targetFromInput(args: Record<string, unknown>): BlacklistTarget {
  const protocol = typeof args.protocol === "string" ? args.protocol.trim() : "";
  if (!protocol) throw new AdapterError("E_INVALID_ARGUMENT", "blacklist add requires protocol");
  const url = typeof args.url === "string" ? args.url.trim() : "";
  const host = typeof args.host === "string" ? args.host.trim() : "";
  const port = typeof args.port === "number" ? args.port : Number(args.port);
  if (host && Number.isFinite(port) && port > 0) {
    return { protocol: canonicalProtocol(protocol), host: normalizeHost(host), port, url: url || undefined };
  }
  if (url) {
    const fromUrl = targetFromUrl(protocol, url);
    if (fromUrl) return fromUrl;
  }
  if (host) {
    const fallback = defaultPort(protocol);
    if (fallback > 0) {
      return { protocol: canonicalProtocol(protocol), host: normalizeHost(host), port: fallback, url: url || undefined };
    }
  }
  throw new AdapterError(
    "E_INVALID_ARGUMENT",
    "blacklist add needs protocol + host+port, or protocol + a network url (not a file path)",
    { protocol },
  );
}

export class BlacklistStore {
  readonly filePath: string;
  private cache: BlacklistEntry[] | undefined;
  /** Called after a successful disk write (security integrity seal). */
  onPersist?: () => Promise<void>;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "blacklist.json");
  }

  async list(): Promise<BlacklistEntry[]> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as BlacklistFile;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
        this.cache = [];
        return this.cache;
      }
      this.cache = parsed.entries;
      return this.cache;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.cache = [];
        return this.cache;
      }
      throw err;
    }
  }

  async save(entries: BlacklistEntry[]): Promise<void> {
    this.cache = entries;
    await mkdir(dirname(this.filePath), { recursive: true });
    const body: BlacklistFile = { version: 1, entries };
    await writeFile(this.filePath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    if (this.onPersist) await this.onPersist();
  }

  async add(input: Record<string, unknown>): Promise<BlacklistEntry> {
    const target = targetFromInput(input);
    const id = blacklistId(target);
    const all = await this.list();
    const existing = all.find((e) => e.id === id);
    if (existing) {
      if (typeof input.reason === "string" && input.reason.trim()) {
        existing.reason = input.reason.trim();
        await this.save([...all]);
      }
      return existing;
    }
    const entry: BlacklistEntry = {
      id,
      protocol: target.protocol,
      host: target.host,
      port: target.port,
      url: target.url,
      reason: typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : undefined,
      createdAt: new Date().toISOString(),
    };
    await this.save([...all, entry]);
    return entry;
  }

  async remove(id: string): Promise<boolean> {
    const all = await this.list();
    const next = all.filter((e) => e.id !== id);
    if (next.length === all.length) return false;
    await this.save(next);
    return true;
  }

  async find(id: string): Promise<BlacklistEntry | undefined> {
    const all = await this.list();
    return all.find((e) => e.id === id);
  }

  async matchTarget(target: BlacklistTarget | undefined): Promise<BlacklistEntry | undefined> {
    if (!target) return undefined;
    const id = blacklistId(target);
    return this.find(id);
  }

  async matchConfig(protocol: string, config: JsonObject): Promise<BlacklistEntry | undefined> {
    return this.matchTarget(targetFromConfig(protocol, config));
  }

  async matchCandidate(candidate: DiscoveryCandidate): Promise<BlacklistEntry | undefined> {
    return this.matchTarget(targetFromCandidate(candidate));
  }
}

export function blacklistedError(hit: BlacklistEntry): AdapterError {
  return new AdapterError(
    "E_BLACKLISTED",
    `Target is blacklisted (${hit.protocol} ${hit.host}:${hit.port}). Remove it from the blacklist to register or invoke.`,
    {
      protocol: hit.protocol,
      details: { blacklistId: hit.id, host: hit.host, port: hit.port, reason: hit.reason },
    },
  );
}

export async function assertNotBlacklisted(
  store: BlacklistStore | undefined,
  protocol: string,
  config: JsonObject,
): Promise<void> {
  if (!store) return;
  const hit = await store.matchConfig(protocol, config);
  if (hit) throw blacklistedError(hit);
}
