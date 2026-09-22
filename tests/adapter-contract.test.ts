import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createAdapter, registerBuiltinAdapters } from "../src/adapters/index.js";
import { canonicalProtocol } from "../src/catalog/validate.js";
import { AdapterError } from "../src/runtime/errors.js";
import { knownProtocols } from "../src/runtime/bootstrap.js";
import { EMPTY_OK, validConfig, MTCONNECT_PROBE_XML } from "./fixtures.js";

registerBuiltinAdapters();

const specPath = fileURLToPath(new URL("../examples/petstore.openapi.json", import.meta.url));
const wsdlPath = fileURLToPath(new URL("../examples/calculator.wsdl", import.meta.url));
const asyncapiPath = fileURLToPath(new URL("../examples/streetlights.asyncapi.json", import.meta.url));

/** Adapters that can connect hermetically (no live broker). */
const HERMETIC: Array<{ protocol: string; config: Record<string, unknown> }> = [
  { protocol: "openapi", config: { spec: specPath, baseUrl: "http://127.0.0.1:9" } },
  { protocol: "soap", config: { wsdl: wsdlPath } },
  { protocol: "asyncapi", config: { spec: asyncapiPath } },
  { protocol: "opcua", config: { endpoint: "opc.tcp://127.0.0.1:4840", simulator: true } },
  { protocol: "fix", config: { sender: "BUY", target: "EXCH" } },
  { protocol: "bacnet", config: {} },
  { protocol: "sql", config: { driver: "sqlite", filename: ":memory:" } },
  { protocol: "sqlite", config: { filename: ":memory:" } },
  { protocol: "postgres", config: { simulator: true } },
  { protocol: "mysql", config: { simulator: true } },
  { protocol: "sqlserver", config: { simulator: true } },
  { protocol: "duckdb", config: { simulator: true } },
  { protocol: "mongodb", config: { simulator: true } },
  { protocol: "elasticsearch", config: { simulator: true } },
  { protocol: "opensearch", config: { simulator: true } },
  { protocol: "clickhouse", config: { simulator: true } },
  { protocol: "neo4j", config: { simulator: true } },
  { protocol: "qdrant", config: { simulator: true } },
  { protocol: "s3", config: { bucket: "artifacts" } },
  { protocol: "gcs", config: { bucket: "artifacts" } },
  { protocol: "oss", config: { bucket: "artifacts" } },
  { protocol: "influx", config: { bucket: "metrics" } },
  { protocol: "prometheus", config: { url: "http://127.0.0.1:9" } },
  { protocol: "sqs", config: { queue: "orders" } },
  { protocol: "pulsar", config: { topic: "events" } },
  { protocol: "ethernetip", config: {} },
  { protocol: "s7", config: {} },
  { protocol: "mtconnect", config: { xml: MTCONNECT_PROBE_XML } },
  {
    protocol: "grpc",
    config: {
      protoInline:
        'syntax = "proto3"; service Ping { rpc GetStatus (M) returns (M); rpc SetThing (M) returns (M); } message M { string t = 1; }',
      target: "127.0.0.1:9",
    },
  },
  { protocol: "modbus", config: { host: "127.0.0.1", simulator: true } },
  { protocol: "jsonrpc", config: { url: "http://127.0.0.1:9" } },
  { protocol: "xmlrpc", config: { url: "http://127.0.0.1:9", introspect: false } },
  { protocol: "graphql", config: { url: "http://127.0.0.1:9", introspect: false } },
  { protocol: "snmp", config: { simulator: true } },
  { protocol: "webdav", config: { simulator: true } },
  { protocol: "ftp", config: { simulator: true } },
  { protocol: "etcd", config: { simulator: true } },
  { protocol: "imap", config: { simulator: true } },
  { protocol: "pop3", config: { simulator: true } },
  { protocol: "consul", config: { simulator: true } },
  { protocol: "azureblob", config: { container: "data", simulator: true } },
  { protocol: "sftp", config: { simulator: true } },
  { protocol: "memcached", config: { simulator: true } },
  { protocol: "tftp", config: { simulator: true } },
  { protocol: "caldav", config: { simulator: true } },
  { protocol: "carddav", config: { simulator: true } },
  { protocol: "beanstalkd", config: { simulator: true } },
  { protocol: "zookeeper", config: { simulator: true } },
  { protocol: "nats", config: { simulator: true, servers: ["nats://127.0.0.1:4222"] } },
  { protocol: "amqp", config: { simulator: true, url: "amqp://127.0.0.1", queue: "jobs" } },
  { protocol: "dns", config: { simulator: true } },
  { protocol: "cassandra", config: { simulator: true } },
  { protocol: "couchdb", config: { simulator: true } },
  { protocol: "whois", config: { simulator: true } },
  { protocol: "solr", config: { simulator: true } },
  { protocol: "rabbitmq", config: { simulator: true } },
  { protocol: "kubernetes", config: { simulator: true } },
  { protocol: "os_info", config: {} },
  { protocol: "platform_fs", config: { roots: ["/etc"] } },
  { protocol: "platform_process", config: { listFn: () => [{ pid: 1, name: "init" }] } },
  { protocol: "platform_service", config: { listFn: () => [{ id: "ssh", state: "active" }] } },
  { protocol: "docker", config: { simulator: true } },
  { protocol: "journal", config: { simulator: true } },
  { protocol: "podman", config: { simulator: true } },
  { protocol: "smb", config: { simulator: true } },
  { protocol: "nfs", config: { simulator: true } },
  { protocol: "vault", config: { simulator: true } },
  { protocol: "aws_iam", config: { simulator: true } },
  { protocol: "alertmanager", config: { simulator: true } },
  { protocol: "pubsub", config: { simulator: true } },
  { protocol: "jira", config: { simulator: true } },
  { protocol: "browser", config: { allowDesktop: false } },
  {
    protocol: "partner",
    config: {
      capability_id: "demo",
      display_name: "Demo",
      version: "1.0.0",
      operations: [{ name: "ping", description: "ping", risk: "readonly", inputSchema: { type: "object" } }],
      simulator: true,
    },
  },
  { protocol: "feishu", config: { simulator: true } },
  { protocol: "dingtalk", config: { simulator: true } },
  { protocol: "wecom", config: { simulator: true } },
  { protocol: "slack", config: { simulator: true } },
  { protocol: "notion", config: { simulator: true } },
  { protocol: "github", config: { simulator: true } },
  { protocol: "mcp_bridge", config: { mcpServers: { demo: { command: "node" } }, simulator: true } },
];

const REQUIRE_KEYS_ON_CONNECT = [
  "openapi",
  "mqtt",
  "soap",
  "grpc",
  "asyncapi",
  "sparkplug",
  "websocket",
  "graphql",
  "amqp",
  "kafka",
  "opcua",
  "modbus",
  "coap",
  "nats",
  "xmlrpc",
  "jsonrpc",
  "redis",
  "smtp",
  "ldap",
  "s3",
  "gcs",
  "oss",
  "influx",
  "prometheus",
  "sqs",
  "pulsar",
  "mtconnect",
  "azureblob",
];

describe("adapter contract", () => {
  it("every known protocol has a validConfig fixture", () => {
    for (const protocol of knownProtocols()) {
      const cfg = validConfig(protocol);
      assert.equal(typeof cfg, "object", protocol);
    }
  });

  it("connect rejects missing required keys (no network)", async () => {
    for (const protocol of REQUIRE_KEYS_ON_CONNECT) {
      const adapter = createAdapter(protocol, `contract-${protocol}`);
      await assert.rejects(
        () => adapter.connect({}),
        (err: unknown) => err instanceof Error,
        protocol,
      );
    }
  });

  it("hermetic adapters: listTools success + unknown tool failure", async () => {
    for (const { protocol, config } of HERMETIC) {
      const adapter = createAdapter(protocol, `live-${protocol}`);
      await adapter.connect(config);
      try {
        const tools = await adapter.listTools();
        assert.ok(tools.length > 0, `${protocol} should list tools`);
        await assert.rejects(
          () => adapter.invoke("__not_a_real_tool__", {}),
          (err: unknown) => err instanceof Error,
          protocol,
        );
      } finally {
        await adapter.disconnect();
      }
    }
  });

  it("aliases resolve to canonical factories", () => {
    assert.equal(createAdapter("http", "a").protocol, "openapi");
    assert.equal(createAdapter("ws", "a").protocol, "websocket");
    assert.equal(createAdapter("mariadb", "a").protocol, "mysql");
    assert.equal(createAdapter("pg", "a").protocol, "postgres");
    assert.equal(createAdapter("postgresql", "a").protocol, "postgres");
    assert.equal(createAdapter("opensearch", "a").protocol, "opensearch");
    assert.equal(createAdapter("influxdb", "a").protocol, "influx");
    assert.equal(createAdapter("enip", "a").protocol, "ethernetip");
    assert.equal(createAdapter("k8s", "a").protocol, "kubernetes");
    assert.equal(createAdapter("cifs", "a").protocol, "smb");
    assert.equal(createAdapter("openbao", "a").protocol, "vault");
    assert.equal(createAdapter("podman", "a").protocol, "podman");
    assert.equal(createAdapter("lark", "a").protocol, "feishu");
    assert.equal(canonicalProtocol("pg"), "postgres");
    assert.equal(canonicalProtocol("influxdb"), "influx");
    assert.equal(canonicalProtocol("enip"), "ethernetip");
    assert.equal(canonicalProtocol("http"), "openapi");
    assert.equal(canonicalProtocol("ws"), "websocket");
  });

  it("every known protocol is HERMETIC, REQUIRE_KEYS, or EMPTY_OK", () => {
    const hermetic = new Set(HERMETIC.map((h) => h.protocol));
    const requireKeys = new Set(REQUIRE_KEYS_ON_CONNECT);
    for (const protocol of knownProtocols()) {
      const canonical = canonicalProtocol(protocol);
      const covered =
        hermetic.has(protocol) ||
        hermetic.has(canonical) ||
        requireKeys.has(protocol) ||
        requireKeys.has(canonical) ||
        EMPTY_OK.has(protocol) ||
        EMPTY_OK.has(canonical);
      assert.ok(covered, `${protocol} missing from HERMETIC / REQUIRE_KEYS / EMPTY_OK`);
    }
  });

  it("write-gated hermetic adapters default allowWrite=false", async () => {
    const cases: Array<{ protocol: string; config: Record<string, unknown>; tool: string; args: Record<string, unknown> }> =
      [
        { protocol: "s3", config: { bucket: "artifacts" }, tool: "put", args: { key: "k", body: "v" } },
        { protocol: "gcs", config: { bucket: "artifacts" }, tool: "put", args: { key: "k", body: "v" } },
        { protocol: "oss", config: { bucket: "artifacts" }, tool: "put", args: { key: "k", body: "v" } },
        { protocol: "influx", config: { bucket: "metrics" }, tool: "write_points", args: { lines: "cpu usage=1" } },
        {
          protocol: "influx",
          config: { bucket: "metrics" },
          tool: "delete_points",
          args: { start: "0", stop: "9", predicate: '_measurement="cpu"' },
        },
        {
          protocol: "prometheus",
          config: { url: "http://127.0.0.1:9" },
          tool: "remote_write",
          args: { timeseries: [{ labels: { __name__: "up" }, samples: [{ value: 1 }] }] },
        },
        { protocol: "sqs", config: { queue: "orders" }, tool: "send", args: { body: "hi" } },
        { protocol: "pulsar", config: { topic: "events" }, tool: "publish", args: { payload: "hi" } },
        { protocol: "ethernetip", config: {}, tool: "write_tag", args: { name: "Heartbeat", value: 1 } },
        { protocol: "s7", config: {}, tool: "write", args: { address: "MW10", value: 1 } },
        { protocol: "sqlite", config: { filename: ":memory:" }, tool: "execute", args: { sql: "CREATE TABLE t (id INT)" } },
        { protocol: "mongodb", config: { simulator: true }, tool: "insert_one", args: { collection: "docs", document: { a: 1 } } },
        { protocol: "fix", config: { sender: "BUY", target: "EXCH" }, tool: "logon", args: { heartBtInt: 10 } },
        { protocol: "opcua", config: { endpoint: "opc.tcp://127.0.0.1:4840", simulator: true }, tool: "write", args: { nodeId: "i=84", value: 1 } },
        { protocol: "soap", config: { wsdl: wsdlPath }, tool: "Add", args: { intA: 1, intB: 2 } },
        {
          protocol: "grpc",
          config: {
            protoInline:
              'syntax = "proto3"; service Ping { rpc SetThing (M) returns (M); } message M { string t = 1; }',
            target: "127.0.0.1:9",
          },
          tool: "Ping_SetThing",
          args: { body: { t: "x" } },
        },
        { protocol: "modbus", config: { host: "127.0.0.1", simulator: true }, tool: "write_register", args: { address: 0, value: 1 } },
        { protocol: "jsonrpc", config: { url: "http://127.0.0.1:9" }, tool: "notify", args: { method: "ping" } },
        { protocol: "xmlrpc", config: { url: "http://127.0.0.1:9", introspect: false }, tool: "call", args: { method: "add", params: [1] } },
        {
          protocol: "graphql",
          config: { url: "http://127.0.0.1:9", introspect: false },
          tool: "mutate",
          args: { mutation: "mutation { x }" },
        },
        { protocol: "imap", config: { simulator: true }, tool: "append", args: { raw: "x" } },
        { protocol: "pop3", config: { simulator: true }, tool: "dele", args: { id: 1 } },
        { protocol: "consul", config: { simulator: true }, tool: "kv_put", args: { key: "k", value: "v" } },
        { protocol: "azureblob", config: { container: "data", simulator: true }, tool: "put", args: { key: "k", body: "v" } },
        { protocol: "sftp", config: { simulator: true }, tool: "put", args: { path: "a.txt", body: "x" } },
        { protocol: "memcached", config: { simulator: true }, tool: "set", args: { key: "k", value: "v" } },
        { protocol: "tftp", config: { simulator: true }, tool: "put", args: { filename: "a.txt", body: "x" } },
        { protocol: "caldav", config: { simulator: true }, tool: "put", args: { path: "/c/x.ics", body: "BEGIN:VCALENDAR\nEND:VCALENDAR" } },
        { protocol: "carddav", config: { simulator: true }, tool: "put", args: { path: "/a/x.vcf", body: "BEGIN:VCARD\nEND:VCARD" } },
        { protocol: "beanstalkd", config: { simulator: true }, tool: "put", args: { body: "job" } },
        { protocol: "zookeeper", config: { simulator: true }, tool: "create", args: { path: "/n", data: "x" } },
        { protocol: "nats", config: { simulator: true, servers: ["nats://127.0.0.1:9"] }, tool: "js_publish", args: { subject: "x", payload: "1" } },
        { protocol: "amqp", config: { simulator: true, url: "amqp://127.0.0.1", queue: "jobs" }, tool: "publish", args: { payload: "x", routingKey: "jobs" } },
        { protocol: "graphql", config: { url: "http://127.0.0.1:9", introspect: false }, tool: "publish_event", args: { field: "tick", data: 1 } },
        { protocol: "cassandra", config: { simulator: true }, tool: "cql", args: { statement: "CREATE KEYSPACE app" } },
        { protocol: "couchdb", config: { simulator: true }, tool: "put", args: { db: "docs", id: "1", document: { n: 1 } } },
        { protocol: "elasticsearch", config: { simulator: true }, tool: "index_doc", args: { index: "logs", document: { n: 1 } } },
        { protocol: "neo4j", config: { simulator: true }, tool: "cypher", args: { statement: "CREATE (n:Person {name: 'Ada'})" } },
        { protocol: "solr", config: { simulator: true }, tool: "update", args: { core: "docs", documents: [{ id: "1" }] } },
        { protocol: "rabbitmq", config: { simulator: true }, tool: "publish", args: { routingKey: "jobs", payload: "x" } },
        { protocol: "kubernetes", config: { simulator: true }, tool: "apply", args: { manifest: { kind: "Pod" } } },
        { protocol: "docker", config: { simulator: true }, tool: "run", args: { image: "nginx" } },
        { protocol: "platform_process", config: {}, tool: "shell_exec", args: { command: "true" } },
        { protocol: "alertmanager", config: { simulator: true }, tool: "create_silence", args: { comment: "x" } },
        { protocol: "pubsub", config: { simulator: true }, tool: "publish", args: { data: "hi" } },
        { protocol: "vault", config: { simulator: true }, tool: "read_secret", args: { path: "secret/data/app/db" } },
        { protocol: "browser", config: {}, tool: "navigate", args: { url: "https://example.test" } },
        { protocol: "feishu", config: { simulator: true }, tool: "send_message", args: { chat_id: "oc_demo", text: "hi" } },
        { protocol: "dingtalk", config: { simulator: true }, tool: "send_robot", args: { text: "hi" } },
        { protocol: "wecom", config: { simulator: true }, tool: "send_app_message", args: { touser: "zhangsan", content: "hi" } },
        { protocol: "slack", config: { simulator: true }, tool: "post_message", args: { channel: "C1", text: "hi" } },
        { protocol: "notion", config: { simulator: true }, tool: "create_page", args: { title: "n" } },
        { protocol: "github", config: { simulator: true }, tool: "create_issue", args: { title: "n" } },
        {
          protocol: "partner",
          config: {
            capability_id: "demo",
            display_name: "Demo",
            version: "1.0.0",
            operations: [{ name: "send_message", description: "send", risk: "write", inputSchema: { type: "object" } }],
            simulator: true,
          },
          tool: "send_message",
          args: { chat_id: "c", text: "hi" },
        },
      ];
    for (const { protocol, config, tool, args } of cases) {
      const adapter = createAdapter(protocol, `ro-${protocol}`);
      await adapter.connect(config);
      try {
        await assert.rejects(
          () => adapter.invoke(tool, args),
          (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
          protocol,
        );
      } finally {
        await adapter.disconnect();
      }
    }
  });
});
