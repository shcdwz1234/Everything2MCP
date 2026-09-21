import type { DiscoveryCandidate, JsonObject } from "../runtime/types.js";

export interface SuggestedRegistration {
  protocol: string;
  name: string;
  config: JsonObject;
  confidence: number;
  reason: string;
  source: DiscoveryCandidate;
}

export function suggestFromCandidates(candidates: DiscoveryCandidate[]): SuggestedRegistration[] {
  const used = new Set<string>();
  return candidates.map((c) => {
    const protocol = c.protocol;
    const name = uniqueName(sanitizeName(c.title ? `${protocol}-${c.title}` : defaultName(c)), used);
    used.add(name);
    const config = c.config ?? configFromCandidate(c);
    const confidence = typeof c.confidence === "number" ? c.confidence : 0.6;
    return {
      protocol,
      name,
      config,
      confidence,
      reason: c.hint || `${protocol} fingerprint at ${c.url}`,
      source: c,
    };
  });
}

export function sanitizeName(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return cleaned || "discovered";
}

function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}-${i}`)) i += 1;
  return `${base}-${i}`.slice(0, 64);
}

function defaultName(c: DiscoveryCandidate): string {
  try {
    const host = new URL(c.url).hostname.replace(/[^A-Za-z0-9_-]/g, "-") || "host";
    return `${c.protocol}-${host}`.replace(/-+/g, "-").slice(0, 64);
  } catch {
    const host = c.url.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40);
    return `${c.protocol}-${host}`.replace(/-+$/g, "") || c.protocol;
  }
}

function configFromCandidate(c: DiscoveryCandidate): JsonObject {
  if (c.protocol === "openapi" || c.protocol === "http") return { spec: c.url };
  if (c.protocol === "soap") return { wsdl: c.url };
  if (c.protocol === "grpc") return { target: c.url, reflection: true };
  if (
    c.protocol === "modbus" ||
    c.protocol === "coap" ||
    c.protocol === "smtp" ||
    c.protocol === "ftp" ||
    c.protocol === "snmp" ||
    c.protocol === "imap" ||
    c.protocol === "pop3" ||
    c.protocol === "sftp" ||
    c.protocol === "memcached" ||
    c.protocol === "tftp" ||
    c.protocol === "beanstalkd" ||
    c.protocol === "zookeeper" ||
    c.protocol === "cassandra" ||
    c.protocol === "whois"
  ) {
    try {
      const u = new URL(c.url);
      return { host: u.hostname, port: Number(u.port) || undefined };
    } catch {
      return { host: c.url };
    }
  }
  if (c.protocol === "bacnet") {
    try {
      const u = new URL(c.url);
      return {
        host: u.hostname,
        port: Number(u.port) || 47808,
        udp: true,
        allowWrite: false,
      };
    } catch {
      return { host: c.url, port: 47808, udp: true, allowWrite: false };
    }
  }
  if (c.protocol === "ethernetip" || c.protocol === "enip") {
    try {
      const u = new URL(c.url);
      return {
        host: u.hostname,
        port: Number(u.port) || 44818,
        tcp: true,
        allowWrite: false,
      };
    } catch {
      return { host: c.url, port: 44818, tcp: true, allowWrite: false };
    }
  }
  if (c.protocol === "s7") {
    try {
      const u = new URL(c.url);
      return {
        host: u.hostname,
        port: Number(u.port) || 102,
        rack: 0,
        slot: 1,
        tcp: true,
        allowWrite: false,
      };
    } catch {
      return { host: c.url, port: 102, rack: 0, slot: 1, tcp: true, allowWrite: false };
    }
  }
  if (c.protocol === "nats") return { url: c.url, servers: [c.url], allowWrite: false };
  if (c.protocol === "amqp") return { url: c.url, allowWrite: false };
  if (c.protocol === "dns") {
    try {
      const u = new URL(c.url);
      return { host: u.hostname, port: Number(u.port) || 53, allowWrite: false };
    } catch {
      return { host: c.url, port: 53, allowWrite: false };
    }
  }
  if (
    c.protocol === "postgres" ||
    c.protocol === "mysql" ||
    c.protocol === "sqlserver" ||
    c.protocol === "mongodb" ||
    c.protocol === "neo4j"
  ) {
    return { url: c.url, allowWrite: false };
  }
  if (c.protocol === "s3") {
    return { bucket: "data", endpoint: c.url.replace(/\/$/, ""), unsigned: true, allowWrite: false, simulator: false };
  }
  if (c.protocol === "gcs" || c.protocol === "oss") {
    return { bucket: "data", endpoint: c.url.replace(/\/+$/, ""), unsigned: true, allowWrite: false, simulator: false };
  }
  if (c.protocol === "influx") {
    return { url: c.url.replace(/\/+$/, ""), bucket: "metrics", org: "local", allowWrite: false };
  }
  if (c.protocol === "prometheus") {
    return { url: c.url.replace(/\/+$/, ""), timeoutMs: 2500, allowWrite: false };
  }
  if (c.protocol === "webdav" || c.protocol === "etcd" || c.protocol === "consul" || c.protocol === "caldav" || c.protocol === "carddav" || c.protocol === "couchdb" || c.protocol === "solr" || c.protocol === "rabbitmq") {
    return { url: c.url.replace(/\/+$/, ""), allowWrite: false };
  }
  if (c.protocol === "kubernetes" || c.protocol === "k8s") {
    return { url: c.url.replace(/\/+$/, ""), namespace: "default" };
  }
  if (c.protocol === "azureblob") {
    return { container: "data", endpoint: c.url.replace(/\/+$/, ""), unsigned: true, allowWrite: false };
  }
  if (c.protocol === "graphql") {
    return { url: c.url.replace(/\/+$/, ""), allowWrite: false };
  }
  if (c.protocol === "pulsar") {
    const origin = c.url.replace(/\/+$/, "");
    const serviceUrl = origin.startsWith("http") ? origin : origin.replace(/^pulsar:\/\//, "pulsar://");
    return { topic: "events", serviceUrl, allowWrite: false };
  }
  return { url: c.url };
}
