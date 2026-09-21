import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { registerBuiltinAdapters } from "../src/adapters/index.js";
import { ToolRegistry } from "../src/catalog/registry.js";
import { JsonStore } from "../src/catalog/store.js";

const specPath = fileURLToPath(new URL("../examples/petstore.openapi.json", import.meta.url));

describe("ToolRegistry", () => {
  let dataDir: string;
  let registry: ToolRegistry;

  before(async () => {
    registerBuiltinAdapters();
    dataDir = await mkdtemp(join(tmpdir(), "e2mcp-reg-"));
    registry = new ToolRegistry(new JsonStore(dataDir));
  });

  after(async () => {
    await registry.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("adds an OpenAPI fixture and lists namespaced tools", async () => {
    const inst = await registry.add("openapi", "widgets", {
      spec: specPath,
      baseUrl: "http://127.0.0.1:9",
    });
    assert.equal(inst.record.id, "openapi:widgets");
    const names = inst.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "openapi.widgets.createWidget",
      "openapi.widgets.deleteWidget",
      "openapi.widgets.getWidget",
      "openapi.widgets.listWidgets",
    ]);
    const listed = registry.list();
    assert.equal(listed.adapters.length, 1);
    assert.ok(listed.protocols.includes("openapi"));
    assert.ok(listed.protocols.includes("mqtt"));
    assert.ok(listed.protocols.includes("soap"));
    assert.ok(listed.protocols.includes("grpc"));
    assert.ok(listed.protocols.includes("websocket"));
    assert.ok(listed.protocols.includes("graphql"));
    assert.ok(listed.protocols.includes("amqp"));
    assert.ok(listed.protocols.includes("kafka"));
    assert.ok(listed.protocols.includes("opcua"));
    assert.ok(listed.protocols.includes("modbus"));
    assert.ok(listed.protocols.includes("coap"));
    assert.ok(listed.protocols.includes("nats"));
    assert.ok(listed.protocols.includes("xmlrpc"));
    assert.ok(listed.protocols.includes("jsonrpc"));
    assert.ok(listed.protocols.includes("fix"));
    assert.ok(listed.protocols.includes("redis"));
    assert.ok(listed.protocols.includes("smtp"));
    assert.ok(listed.protocols.includes("ldap"));
    assert.ok(listed.protocols.includes("bacnet"));
    assert.ok(listed.protocols.includes("sql"));
    assert.ok(listed.protocols.includes("sqlite"));
    assert.ok(listed.protocols.includes("postgres"));
    assert.ok(listed.protocols.includes("mongodb"));
    assert.ok(listed.protocols.includes("qdrant"));
    assert.ok(listed.protocols.includes("s3"));
    assert.ok(listed.protocols.includes("prometheus"));
    assert.ok(listed.protocols.includes("sqs"));
    assert.ok(listed.protocols.includes("pulsar"));
    assert.ok(listed.protocols.includes("gcs"));
    assert.ok(listed.protocols.includes("oss"));
    assert.ok(listed.protocols.includes("influx"));
  });

  it("filters with queryByProtocol", () => {
    const openapi = registry.queryByProtocol("openapi");
    assert.equal(openapi.adapters.length, 1);
    const mqtt = registry.queryByProtocol("mqtt");
    assert.equal(mqtt.adapters.length, 0);
    assert.equal(mqtt.tools.length, 0);
  });

  it("updates config and keeps the same id", async () => {
    const updated = await registry.update("openapi:widgets", {
      baseUrl: "http://127.0.0.1:99/v2",
    });
    assert.equal(updated.record.id, "openapi:widgets");
    assert.equal(updated.record.config.baseUrl, "http://127.0.0.1:99/v2");
    assert.equal(updated.tools.length, 4);
  });

  it("persists registrations and restores them", async () => {
    const store = new JsonStore(dataDir);
    const persisted = await store.load();
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]?.id, "openapi:widgets");

    const clone = new ToolRegistry(store);
    await clone.restore();
    const listed = clone.list();
    assert.equal(listed.adapters[0]?.status, "live");
    assert.equal(listed.tools.length, 4);
    await clone.shutdown();
  });

  it("removes adapters and unregisters tools", async () => {
    const removed = await registry.remove("openapi:widgets");
    assert.equal(removed, true);
    assert.equal(registry.list().adapters.length, 0);
    assert.equal(registry.adapterTools().length, 0);
    assert.equal(await registry.remove("openapi:widgets"), false);
  });
});
