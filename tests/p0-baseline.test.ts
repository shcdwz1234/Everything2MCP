import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { registerBuiltinAdapters } from "../src/adapters/index.js";
import { knownProtocols } from "../src/runtime/bootstrap.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

registerBuiltinAdapters();

describe("P0 baseline (provable)", () => {
  it("src/core and src/management shims are gone", () => {
    assert.equal(existsSync(join(root, "src/core")), false);
    assert.equal(existsSync(join(root, "src/management")), false);
    for (const dir of ["transport", "control", "catalog", "discovery", "runtime", "adapters"]) {
      assert.equal(existsSync(join(root, "src", dir)), true, dir);
    }
  });

  it("every canonical protocol has a dedicated or p1 test file", () => {
    const protocols = knownProtocols();
    const mapping: Record<string, string> = {
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
    const seen = new Set<string>();
    for (const p of protocols) {
      const canonical = p === "http" ? "openapi" : p === "ws" ? "websocket" : p === "mariadb" ? "mysql" : p === "pg" || p === "postgresql" ? "postgres" : p === "enip" ? "ethernetip" : p === "influxdb" ? "influx" : p === "k8s" ? "kubernetes" : p === "cifs" ? "smb" : p === "openbao" ? "vault" : p === "lark" ? "feishu" : p;
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      const file = mapping[canonical];
      assert.ok(file, `no test mapping for ${canonical}`);
      assert.equal(existsSync(join(root, "tests", file)), true, `${canonical} → ${file}`);
    }
  });

  it("thickened P0 protocols are registered and have dedicated tests", () => {
    const protocols = knownProtocols();
    for (const p of ["opcua", "fix", "coap", "nats", "ldap", "asyncapi", "sparkplug"]) {
      assert.ok(protocols.includes(p), `missing protocol ${p}`);
      assert.equal(existsSync(join(root, "tests", `${p}-adapter.test.ts`)), true, p);
    }
    for (const file of [
      "validate.test.ts",
      "adapter-contract.test.ts",
      "discovery-scan.test.ts",
      "ssrf.test.ts",
      "catalog-hot-reload.test.ts",
    ]) {
      assert.equal(existsSync(join(root, "tests", file)), true, file);
    }
  });
});
