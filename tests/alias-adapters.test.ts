import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createAdapter, registerBuiltinAdapters } from "../src/adapters/index.js";
import { canonicalProtocol } from "../src/catalog/validate.js";
import { AdapterError } from "../src/runtime/errors.js";
import { MTCONNECT_PROBE_XML } from "./fixtures.js";

registerBuiltinAdapters();

const specPath = fileURLToPath(new URL("../examples/petstore.openapi.json", import.meta.url));

describe("registered protocol aliases", () => {
  it("http is openapi and lists petstore tools", async () => {
    assert.equal(canonicalProtocol("http"), "openapi");
    const adapter = createAdapter("http", "widgets");
    assert.equal(adapter.protocol, "openapi");
    await adapter.connect({ spec: specPath, baseUrl: "http://127.0.0.1:9" });
    try {
      const names = (await adapter.listTools()).map((t) => t.name);
      assert.ok(names.includes("listWidgets"));
      await assert.rejects(() => adapter.invoke("__nope__", {}), /Unknown|not a real|E_UNKNOWN/i);
    } finally {
      await adapter.disconnect();
    }
  });

  it("ws alias constructs a WebSocket adapter", () => {
    assert.equal(canonicalProtocol("ws"), "websocket");
    const adapter = createAdapter("ws", "echo");
    assert.equal(adapter.protocol, "websocket");
  });

  it("enip is ethernetip and defaults allowWrite=false", async () => {
    assert.equal(canonicalProtocol("enip"), "ethernetip");
    const adapter = createAdapter("enip", "line");
    assert.equal(adapter.protocol, "ethernetip");
    await adapter.connect({});
    try {
      const names = (await adapter.listTools()).map((t) => t.name);
      assert.ok(names.includes("read_tag"));
      await assert.rejects(
        () => adapter.invoke("write_tag", { name: "Heartbeat", value: 1 }),
        /allowWrite/,
      );
    } finally {
      await adapter.disconnect();
    }
  });

  it("influxdb is influx and defaults allowWrite=false", async () => {
    assert.equal(canonicalProtocol("influxdb"), "influx");
    const adapter = createAdapter("influxdb", "metrics");
    assert.equal(adapter.protocol, "influx");
    await adapter.connect({ bucket: "metrics" });
    try {
      await assert.rejects(
        () => adapter.invoke("write_points", { lines: "cpu usage=1" }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
      );
      const q = (await adapter.invoke("query", { flux: 'from(bucket: "metrics")' })) as { dialect?: string };
      assert.ok(q);
    } finally {
      await adapter.disconnect();
    }
  });

  it("pg / postgresql / mariadb construct the engine adapters", async () => {
    assert.equal(createAdapter("pg", "a").protocol, "postgres");
    assert.equal(createAdapter("postgresql", "b").protocol, "postgres");
    assert.equal(createAdapter("mariadb", "c").protocol, "mysql");
    const pg = createAdapter("pg", "sim");
    await pg.connect({ simulator: true });
    try {
      const names = (await pg.listTools()).map((t) => t.name);
      assert.ok(names.includes("query"));
    } finally {
      await pg.disconnect();
    }
  });

  it("mtconnect fixture still works through the factory (not an alias)", async () => {
    const adapter = createAdapter("mtconnect", "mill");
    await adapter.connect({ xml: MTCONNECT_PROBE_XML });
    try {
      const names = (await adapter.listTools()).map((t) => t.name);
      assert.ok(names.includes("probe") || names.includes("current"));
    } finally {
      await adapter.disconnect();
    }
  });
});
