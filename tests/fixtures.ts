import { fileURLToPath } from "node:url";
import { canonicalProtocol } from "../src/catalog/validate.js";
import type { JsonObject } from "../src/runtime/types.js";

const specPath = fileURLToPath(new URL("../examples/petstore.openapi.json", import.meta.url));
const wsdlPath = fileURLToPath(new URL("../examples/calculator.wsdl", import.meta.url));
const asyncapiPath = fileURLToPath(new URL("../examples/streetlights.asyncapi.json", import.meta.url));
const protoPath = fileURLToPath(new URL("../examples/greeter.proto", import.meta.url));

/** Protocols whose empty config is accepted (simulator / optional keys). */
export const EMPTY_OK = new Set([
  "fix",
  "bacnet",
  "ethernetip",
  "enip",
  "s7",
  "sqlite",
  "postgres",
  "pg",
  "postgresql",
  "mysql",
  "mariadb",
  "sqlserver",
  "duckdb",
  "mongodb",
  "elasticsearch",
  "opensearch",
  "clickhouse",
  "neo4j",
  "qdrant",
  "snmp",
  "webdav",
  "ftp",
  "etcd",
  "imap",
  "pop3",
  "consul",
  "sftp",
  "memcached",
  "tftp",
  "caldav",
  "carddav",
  "beanstalkd",
  "zookeeper",
  "dns",
  "cassandra",
  "couchdb",
  "whois",
  "solr",
  "rabbitmq",
  "kubernetes",
  "kubernetes",
  "k8s",
  "os_info",
  "platform_fs",
  "platform_process",
  "platform_service",
  "docker",
  "journal",
  "podman",
  "smb",
  "cifs",
  "nfs",
  "vault",
  "openbao",
  "aws_iam",
  "alertmanager",
  "pubsub",
  "jira",
  "browser",
  "feishu",
  "dingtalk",
  "wecom",
  "slack",
  "notion",
  "github",
]);

export function validConfig(protocol: string): JsonObject {
  const p = canonicalProtocol(protocol);
  switch (p) {
    case "openapi":
      return { spec: specPath };
    case "mqtt":
      return { url: "mqtt://127.0.0.1:1883" };
    case "soap":
      return { wsdl: wsdlPath };
    case "grpc":
      return { proto: protoPath, target: "127.0.0.1:50051" };
    case "asyncapi":
      return { spec: asyncapiPath };
    case "sparkplug":
      return { url: "mqtt://127.0.0.1:1883" };
    case "websocket":
      return { url: "ws://127.0.0.1:9" };
    case "graphql":
    case "xmlrpc":
    case "jsonrpc":
      return { url: "http://127.0.0.1:9" };
    case "redis":
      return { url: "redis://127.0.0.1:6379" };
    case "ldap":
      return { url: "ldap://127.0.0.1:389" };
    case "amqp":
      return { url: "amqp://127.0.0.1" };
    case "kafka":
      return { brokers: ["127.0.0.1:9092"] };
    case "opcua":
      return { endpoint: "opc.tcp://127.0.0.1:4840", simulator: true };
    case "modbus":
    case "coap":
    case "smtp":
      return { host: "127.0.0.1" };
    case "nats":
      return { servers: ["nats://127.0.0.1:4222"] };
    case "sql":
      return { driver: "sqlite", filename: ":memory:" };
    case "sqlite":
      return { filename: ":memory:" };
    case "s3":
      return { bucket: "artifacts" };
    case "gcs":
    case "oss":
      return { bucket: "artifacts" };
    case "influx":
      return { bucket: "metrics" };
    case "prometheus":
      return { url: "http://127.0.0.1:9090" };
    case "sqs":
      return { queue: "orders" };
    case "pulsar":
      return { topic: "events" };
    case "snmp":
      return { simulator: true, community: "public" };
    case "webdav":
    case "ftp":
    case "etcd":
    case "imap":
    case "pop3":
    case "consul":
    case "sftp":
    case "memcached":
    case "tftp":
    case "caldav":
    case "carddav":
    case "beanstalkd":
    case "zookeeper":
      return { simulator: true };
    case "azureblob":
      return { container: "data", simulator: true };
    case "mtconnect":
      return { xml: MTCONNECT_PROBE_XML };
    case "partner":
      return {
        capability_id: "demo",
        display_name: "Demo",
        version: "1.0.0",
        operations: [{ name: "ping", description: "readonly ping", risk: "readonly", inputSchema: { type: "object" } }],
        invoke: { kind: "http", url: "http://127.0.0.1:9/invoke" },
        simulator: true,
      };
    case "mcp_bridge":
      return { mcpServers: { demo: { command: "node", args: ["-e", ""] } }, simulator: true };
    case "feishu":
    case "dingtalk":
    case "wecom":
    case "slack":
    case "notion":
    case "github":
      return { simulator: true };
    default:
      return { simulator: true };
  }
}

/** Tiny MTConnectDevices fixture for contract tests. */
export const MTCONNECT_PROBE_XML = `<?xml version="1.0"?>
<MTConnectDevices xmlns="urn:mtconnect.org:MTConnectDevices:1.7">
  <Header creationTime="2024-01-01T00:00:00Z" sender="e2mcp" instanceId="1" version="1.7"/>
  <Devices>
    <Device id="dev1" name="Mill" uuid="mill-1">
      <DataItems>
        <DataItem id="avail" type="AVAILABILITY" category="EVENT"/>
        <DataItem id="xact" type="POSITION" category="SAMPLE" units="MILLIMETER"/>
      </DataItems>
    </Device>
  </Devices>
</MTConnectDevices>
`;
