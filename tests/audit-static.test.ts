import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { knownProtocols, registerBuiltinAdapters } from "../src/adapters/index.js";
import { ADAPTER_PACKS } from "../src/adapters/packs.js";
import { canonicalProtocol } from "../src/catalog/validate.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

registerBuiltinAdapters();

/** Canonical protocol → dedicated test file (aliases share the canonical file). */
const DEDICATED_TEST: Record<string, string> = {
  openapi: "openapi-adapter.test.ts",
  mqtt: "mqtt-adapter.test.ts",
  soap: "soap-adapter.test.ts",
  grpc: "grpc-adapter.test.ts",
  websocket: "websocket-adapter.test.ts",
  graphql: "graphql-adapter.test.ts",
  amqp: "amqp-adapter.test.ts",
  kafka: "kafka-adapter.test.ts",
  opcua: "opcua-adapter.test.ts",
  modbus: "modbus-adapter.test.ts",
  coap: "coap-adapter.test.ts",
  nats: "nats-adapter.test.ts",
  xmlrpc: "xmlrpc-adapter.test.ts",
  jsonrpc: "jsonrpc-adapter.test.ts",
  fix: "fix-adapter.test.ts",
  redis: "redis-adapter.test.ts",
  smtp: "smtp-adapter.test.ts",
  ldap: "ldap-adapter.test.ts",
  asyncapi: "asyncapi-adapter.test.ts",
  sparkplug: "sparkplug-adapter.test.ts",
  bacnet: "bacnet-adapter.test.ts",
  ethernetip: "ethernetip-adapter.test.ts",
  s7: "s7-adapter.test.ts",
  mtconnect: "mtconnect-adapter.test.ts",
  sql: "p1-sql-facade.test.ts",
  sqlite: "p1-sqlite.test.ts",
  postgres: "p1-postgres.test.ts",
  mysql: "p1-mysql.test.ts",
  sqlserver: "p1-sqlserver.test.ts",
  duckdb: "p1-duckdb.test.ts",
  mongodb: "p1-mongodb.test.ts",
  elasticsearch: "p1-elasticsearch.test.ts",
  opensearch: "p1-elasticsearch.test.ts",
  clickhouse: "p1-clickhouse.test.ts",
  neo4j: "p1-neo4j.test.ts",
  qdrant: "p1-qdrant.test.ts",
  s3: "s3-adapter.test.ts",
  gcs: "gcs-adapter.test.ts",
  oss: "oss-adapter.test.ts",
  influx: "influx-adapter.test.ts",
  prometheus: "prometheus-adapter.test.ts",
  sqs: "sqs-adapter.test.ts",
  pulsar: "pulsar-adapter.test.ts",
  snmp: "snmp-adapter.test.ts",
  webdav: "webdav-adapter.test.ts",
  ftp: "ftp-adapter.test.ts",
  etcd: "etcd-adapter.test.ts",
  imap: "imap-adapter.test.ts",
  pop3: "pop3-adapter.test.ts",
  consul: "consul-adapter.test.ts",
  azureblob: "azureblob-adapter.test.ts",
  sftp: "sftp-adapter.test.ts",
  memcached: "memcached-adapter.test.ts",
  tftp: "tftp-adapter.test.ts",
  caldav: "caldav-adapter.test.ts",
  carddav: "carddav-adapter.test.ts",
  beanstalkd: "beanstalkd-adapter.test.ts",
  zookeeper: "zookeeper-adapter.test.ts",
  dns: "dns-adapter.test.ts",
  cassandra: "cassandra-adapter.test.ts",
  couchdb: "couchdb-adapter.test.ts",
  whois: "whois-adapter.test.ts",
  solr: "solr-adapter.test.ts",
  rabbitmq: "rabbitmq-adapter.test.ts",
  kubernetes: "kubernetes-adapter.test.ts",
  os_info: "platform-adapter.test.ts",
  platform_fs: "platform-adapter.test.ts",
  platform_process: "platform-adapter.test.ts",
  platform_service: "platform-adapter.test.ts",
  docker: "docker-adapter.test.ts",
  journal: "journal-adapter.test.ts",
  podman: "docker-adapter.test.ts",
  smb: "smb-adapter.test.ts",
  nfs: "nfs-adapter.test.ts",
  vault: "vault-adapter.test.ts",
  aws_iam: "aws-iam-adapter.test.ts",
  alertmanager: "alertmanager-adapter.test.ts",
  pubsub: "pubsub-adapter.test.ts",
  jira: "jira-adapter.test.ts",
  browser: "browser-adapter.test.ts",
  partner: "partner-lifecycle.test.ts",
  feishu: "feishu-adapter.test.ts",
  dingtalk: "dingtalk-adapter.test.ts",
  wecom: "wecom-adapter.test.ts",
  slack: "slack-adapter.test.ts",
  notion: "notion-adapter.test.ts",
  github: "github-adapter.test.ts",
  mcp_bridge: "mcp-bridge-adapter.test.ts",
};

const ALIAS_TEST: Record<string, string> = {
  http: "openapi-adapter.test.ts",
  ws: "websocket-adapter.test.ts",
  mariadb: "p1-mysql.test.ts",
  pg: "p1-postgres.test.ts",
  postgresql: "p1-postgres.test.ts",
  enip: "ethernetip-adapter.test.ts",
  influxdb: "influx-adapter.test.ts",
  k8s: "kubernetes-adapter.test.ts",
  cifs: "smb-adapter.test.ts",
  openbao: "vault-adapter.test.ts",
  lark: "feishu-adapter.test.ts",
};

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkTs(p));
    else if (ent.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

function importsControlOrTransport(src: string): boolean {
  return /^\s*import\s.+from\s+["'][^"']*\/(control|transport)(?:\/[^"']*)?["']/m.test(src);
}

describe("audit: static architecture + registry coverage", () => {
  it("src/core and src/management shims stay gone", () => {
    assert.equal(existsSync(join(root, "src/core")), false);
    assert.equal(existsSync(join(root, "src/management")), false);
    for (const dir of ["transport", "control", "catalog", "discovery", "runtime", "adapters"]) {
      assert.equal(existsSync(join(root, "src", dir)), true, dir);
    }
  });

  it("adapters never import control or transport", () => {
    const files = walkTs(join(root, "src/adapters"));
    assert.ok(files.length > 10, "expected adapter sources");
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      if (importsControlOrTransport(src)) offenders.push(relative(root, file));
    }
    assert.deepEqual(offenders, []);
  });

  it("runtime leaf modules do not import adapters (bootstrap is the only edge)", () => {
    const runtimeDir = join(root, "src/runtime");
    const files = walkTs(runtimeDir).filter((f) => !f.endsWith("bootstrap.ts"));
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      if (/from\s+["'][^"']*adapters[^"']*["']/.test(src)) offenders.push(relative(root, file));
    }
    assert.deepEqual(offenders, []);
  });

  it("every registered protocol has a dedicated test file (aliases share canonical)", () => {
    for (const protocol of knownProtocols()) {
      const canonical = canonicalProtocol(protocol);
      const file = DEDICATED_TEST[canonical] ?? ALIAS_TEST[protocol];
      assert.ok(file, `no dedicated-test mapping for ${protocol} (canonical ${canonical})`);
      assert.equal(existsSync(join(root, "tests", file)), true, `${protocol} → tests/${file}`);
    }
  });

  it("every pack id is a registered protocol or documented alias", () => {
    const known = new Set(knownProtocols());
    for (const [pack, ids] of Object.entries(ADAPTER_PACKS)) {
      for (const id of ids) {
        assert.ok(known.has(id) || known.has(canonicalProtocol(id)), `pack ${pack} lists unknown ${id}`);
      }
    }
  });

  it("contract + validate + P5/P6 + discovery/SSRF suites remain present", () => {
    for (const file of [
      "validate.test.ts",
      "adapter-contract.test.ts",
      "discovery-scan.test.ts",
      "ssrf.test.ts",
      "p0-baseline.test.ts",
      "p5-golden-path.test.ts",
      "p6-http-transport.test.ts",
      "catalog-hot-reload.test.ts",
      "console-rest.test.ts",
      "console-w3.test.ts",
      "tls-material.test.ts",
      "sql-native.test.ts",
      "blacklist.test.ts",
      "security-plane.test.ts",
      "s2-hardening.test.ts",
    ]) {
      assert.equal(existsSync(join(root, "tests", file)), true, file);
    }
    for (const file of [
      "docs/RELEASE_NOTES.md",
      "docs/AUDIT.md",
      "docs/CONSOLE.md",
      "docs/ROADMAP.md",
      "docs/BLACKLIST.md",
      "docs/SECURITY_ARCHITECTURE.md",
      "docs/PARTNER.md",
      "docs/COMPAT.md",
    ]) {
      assert.equal(existsSync(join(root, file)), true, file);
    }
  });
});
