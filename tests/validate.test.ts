import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerBuiltinAdapters } from "../src/adapters/index.js";
import { AdapterError } from "../src/runtime/errors.js";
import { PROTOCOL_CONFIG_HELP, validateRegistration } from "../src/catalog/validate.js";
import { knownProtocols } from "../src/runtime/bootstrap.js";
import { canonicalProtocol } from "../src/catalog/validate.js";
import { EMPTY_OK, validConfig } from "./fixtures.js";

registerBuiltinAdapters();

describe("config validation", () => {
  it("rejects unknown protocols with the known list", () => {
    try {
      validateRegistration("not-a-protocol", "x", { url: "http://x" });
      assert.fail("expected throw");
    } catch (err) {
      assert.ok(err instanceof AdapterError);
      assert.equal(err.code, "E_UNKNOWN_PROTOCOL");
      assert.match(err.message, /opcua/);
      assert.match(err.message, /sqlite/);
    }
  });

  it("rejects unsafe names", () => {
    assert.throws(() => validateRegistration("fix", "bad name", {}), /name must match/);
  });

  it("every registered protocol has PROTOCOL_CONFIG_HELP (canonical id)", () => {
    const canonical = new Set(knownProtocols().map((p) => canonicalProtocol(p)));
    for (const p of canonical) {
      assert.ok(PROTOCOL_CONFIG_HELP[p], `missing PROTOCOL_CONFIG_HELP for ${p}`);
    }
  });

  it("accepts a valid config for every known protocol and alias", () => {
    for (const protocol of knownProtocols()) {
      validateRegistration(protocol, "ok", validConfig(protocol));
    }
    validateRegistration("http", "widgets", validConfig("http"));
    validateRegistration("ws", "echo", validConfig("ws"));
    validateRegistration("pg", "db", { simulator: true });
    validateRegistration("postgresql", "db", { simulator: true });
    validateRegistration("mariadb", "db", { simulator: true });
  });

  it("rejects empty config when keys are required", () => {
    for (const protocol of knownProtocols()) {
      if (EMPTY_OK.has(protocol) || EMPTY_OK.has(canonicalProtocol(protocol))) continue;
      assert.throws(
        () => validateRegistration(protocol, "x", {}),
        (err: unknown) => err instanceof AdapterError && err.code === "E_INVALID_CONFIG",
        protocol,
      );
    }
  });

  it("requires protocol-specific keys and accepts aliases", () => {
    assert.throws(() => validateRegistration("opcua", "plant", {}), /endpoint/);
    assert.throws(() => validateRegistration("nats", "core", {}), /servers/);
    assert.throws(() => validateRegistration("s3", "x", {}), /bucket/);
    assert.throws(() => validateRegistration("prometheus", "x", {}), /url/);
    assert.throws(() => validateRegistration("asyncapi", "x", {}), /spec/);
    assert.throws(() => validateRegistration("sparkplug", "x", {}), /url/);
    assert.throws(() => validateRegistration("grpc", "x", { target: "127.0.0.1:1" }), /proto/);
    assert.throws(() => validateRegistration("kafka", "x", { brokers: [] }), /brokers/);
    validateRegistration("fix", "desk", {});
    validateRegistration("sql", "local", { driver: "sqlite", filename: ":memory:" });
    validateRegistration("sqlite", "mem", { filename: ":memory:" });
    validateRegistration("postgres", "db", { simulator: true });
    validateRegistration("mongodb", "docs", { simulator: true });
    validateRegistration("qdrant", "v", { simulator: true });
    validateRegistration("s3", "bucket", { bucket: "artifacts" });
    validateRegistration("prometheus", "prom", { url: "http://127.0.0.1:9090" });
    validateRegistration("prometheus", "mem", { simulator: true });
    validateRegistration("nats", "js", { simulator: true });
    validateRegistration("amqp", "bus", { simulator: true });
    validateRegistration("graphql", "gql", { simulator: true });
    validateRegistration("dns", "resolver", {});
    validateRegistration("cassandra", "cql", {});
    validateRegistration("couchdb", "docs", {});
    validateRegistration("whois", "lookup", {});
    validateRegistration("solr", "idx", {});
    validateRegistration("rabbitmq", "mgmt", {});
    validateRegistration("kubernetes", "cluster", {});
    validateRegistration("k8s", "cluster", {});
    validateRegistration("bacnet", "plant", {});
    validateRegistration("sqs", "orders", { queue: "orders" });
    assert.throws(() => validateRegistration("sqs", "x", {}), /queue/);
    validateRegistration("pulsar", "events", { topic: "orders" });
    assert.throws(() => validateRegistration("pulsar", "x", {}), /topic/);
    validateRegistration("gcs", "bucket", { bucket: "artifacts" });
    assert.throws(() => validateRegistration("gcs", "x", {}), /bucket/);
    validateRegistration("oss", "bucket", { bucket: "artifacts" });
    assert.throws(() => validateRegistration("oss", "x", {}), /bucket/);
    validateRegistration("influx", "metrics", { bucket: "metrics" });
    validateRegistration("influxdb", "metrics", { bucket: "metrics" });
    assert.throws(() => validateRegistration("influx", "x", {}), /bucket/);
    validateRegistration("enip", "line", {});
    validateRegistration("http", "api", validConfig("http"));
    validateRegistration("ws", "echo", validConfig("ws"));
    assert.throws(() => validateRegistration("websocket", "x", {}), /url/);
    assert.throws(() => validateRegistration("graphql", "x", {}), /url/);
    assert.throws(() => validateRegistration("smtp", "x", {}), /host/);
    validateRegistration("azureblob", "blob", { container: "data" });
    assert.throws(() => validateRegistration("azureblob", "x", {}), /container/);
    validateRegistration("imap", "mail", { simulator: true });
    validateRegistration("consul", "kv", { simulator: true });
  });
});
