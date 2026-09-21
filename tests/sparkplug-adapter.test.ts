import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { AdapterError } from "../src/runtime/errors.js";
import {
  SparkplugAdapter,
  SPARKPLUG_NAMESPACE,
  SPARKPLUG_PROTO_SOURCE,
  decodeAnyPayload,
  decodeSparkplugPayload,
  encodeSparkplugPayload,
  formatSparkplugTopic,
  parseSparkplugTopic,
  formatHostStateTopic,
  decodeHostState,
} from "../src/adapters/sparkplug/index.js";
import type { MqttBrokerClient } from "../src/adapters/mqtt/index.js";

const fixturePath = fileURLToPath(new URL("../examples/sparkplug-nbirth.pb", import.meta.url));
const FIXTURE = readFileSync(fixturePath);

class FakeMqtt extends EventEmitter implements MqttBrokerClient {
  connected = true;
  published: Array<{ topic: string; payload: Buffer; retain?: boolean }> = [];
  async publishAsync(
    topic: string,
    payload: string | Buffer,
    opts?: { qos?: 0 | 1 | 2; retain?: boolean },
  ): Promise<unknown> {
    const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    this.published.push({ topic, payload: buf, retain: opts?.retain });
    this.emit("message", topic, buf, { retain: Boolean(opts?.retain) });
    return undefined;
  }
  async subscribeAsync(): Promise<unknown> {
    return [];
  }
  async unsubscribeAsync(): Promise<unknown> {
    return undefined;
  }
  async endAsync(): Promise<void> {
    this.connected = false;
  }
}

describe("Sparkplug B protobuf codec", () => {
  it("round-trips official Payload metrics", () => {
    const encoded = encodeSparkplugPayload({
      timestamp: 1700000000000,
      seq: 7,
      uuid: "round-trip",
      metrics: [
        { name: "rpm", dataType: "Int32", value: 12, timestamp: 1700000000000 },
        { name: "temp", dataType: "Double", value: 21.5, timestamp: 1700000000000 },
        { name: "ok", dataType: "Boolean", value: true, timestamp: 1700000000000 },
        { name: "bdSeq", dataType: "UInt64", value: 3, timestamp: 1700000000000 },
      ],
    });
    assert.ok(encoded.length > 8);
    const decoded = decodeSparkplugPayload(encoded);
    assert.equal(decoded.encoding, "protobuf");
    assert.equal(decoded.seq, 7);
    assert.equal(decoded.uuid, "round-trip");
    const byName = Object.fromEntries(decoded.metrics.map((m) => [m.name, m]));
    assert.equal(byName.rpm?.value, 12);
    assert.equal(byName.rpm?.dataType, "Int32");
    assert.equal(byName.ok?.value, true);
    assert.equal(byName.bdSeq?.value, 3);
    assert.equal(byName.temp?.dataType, "Double");
    assert.ok(Math.abs(Number(byName.temp?.value) - 21.5) < 1e-6);
  });

  it("decodes the committed DataSet/Template fixture", () => {
    const fixture = readFileSync(fileURLToPath(new URL("../examples/sparkplug-complex.pb", import.meta.url)));
    const view = decodeSparkplugPayload(fixture);
    assert.equal(view.uuid, "complex-fixture");
    const samples = view.metrics.find((m) => m.name === "samples")?.value as { rows?: unknown[][] };
    assert.deepEqual(samples.rows?.[1], [2, 14]);
    const motor = view.metrics.find((m) => m.name === "Motor")?.value as { templateRef?: string };
    assert.equal(motor.templateRef, "MotorDef");
  });

  it("decodes the committed binary fixture", () => {
    assert.match(SPARKPLUG_PROTO_SOURCE, /eclipse\/tahu/);
    const view = decodeSparkplugPayload(FIXTURE);
    assert.equal(view.uuid, "nbirth-fixture");
    assert.equal(view.seq, 0);
    assert.ok(view.metrics.some((m) => m.name === "bdSeq" && m.value === 1));
    assert.ok(view.metrics.some((m) => m.name === "rpm" && m.value === 12));
    assert.ok(view.metrics.some((m) => m.name === "online" && m.value === true));
    const again = encodeSparkplugPayload(view);
    assert.deepEqual(decodeSparkplugPayload(again).metrics.map((m) => [m.name, m.value]), [
      ["bdSeq", 1],
      ["rpm", 12],
      ["online", true],
    ]);
  });

  it("round-trips DataSet, Template, and PropertySet", () => {
    const encoded = encodeSparkplugPayload({
      timestamp: 1700000000000,
      seq: 1,
      uuid: "complex",
      metrics: [
        {
          name: "samples",
          dataType: "DataSet",
          timestamp: 1700000000000,
          value: {
            columns: ["ts", "rpm"],
            types: ["Int32", "Int32"],
            rows: [
              [1, 12],
              [2, 14],
            ],
          },
        },
        {
          name: "Motor",
          dataType: "Template",
          timestamp: 1700000000000,
          properties: { quality: { type: "Int32", value: 192 } },
          value: {
            version: "1.0",
            templateRef: "MotorDef",
            isDefinition: false,
            parameters: [{ name: "index", type: "Int32", value: 3 }],
            metrics: [{ name: "rpm", dataType: "Int32", value: 900, timestamp: 1700000000000 }],
          },
        },
      ],
    });
    const decoded = decodeSparkplugPayload(encoded);
    const byName = Object.fromEntries(decoded.metrics.map((m) => [m.name, m]));
    const ds = byName.samples?.value as { columns: string[]; rows: unknown[][] };
    assert.deepEqual(ds.columns, ["ts", "rpm"]);
    assert.deepEqual(ds.rows, [
      [1, 12],
      [2, 14],
    ]);
    const tpl = byName.Motor?.value as {
      templateRef?: string;
      parameters?: Array<{ name: string; value?: unknown }>;
      metrics?: Array<{ name: string; value?: unknown }>;
    };
    assert.equal(tpl.templateRef, "MotorDef");
    assert.equal(tpl.parameters?.[0]?.value, 3);
    assert.equal(tpl.metrics?.[0]?.value, 900);
    const quality = byName.Motor?.properties as { quality?: { value?: unknown } };
    assert.equal(quality.quality?.value, 192);
    const again = decodeSparkplugPayload(encodeSparkplugPayload(decoded));
    assert.equal((again.metrics.find((m) => m.name === "Motor")?.value as { templateRef?: string }).templateRef, "MotorDef");
  });

  it("parses spBv1.0 topics and falls back to json-compat", () => {
    const node = parseSparkplugTopic("spBv1.0/IIoT/NBIRTH/press-01");
    assert.equal(node?.kind, "node");
    assert.equal(node?.messageType, "NBIRTH");
    const device = parseSparkplugTopic("spBv1.0/IIoT/DDATA/press-01/motor");
    assert.equal(device?.kind, "device");
    assert.equal(device?.deviceId, "motor");
    assert.equal(
      formatSparkplugTopic({ groupId: "IIoT", messageType: "DBIRTH", edgeNode: "press-01", deviceId: "motor" }),
      "spBv1.0/IIoT/DBIRTH/press-01/motor",
    );
    const json = decodeAnyPayload(JSON.stringify({ timestamp: 1, seq: 2, metrics: [{ name: "x", value: 1 }] }));
    assert.equal(json.encoding, "json-compat");
    assert.equal(json.metrics[0]?.name, "x");
    const host = parseSparkplugTopic("spBv1.0/STATE/scada");
    assert.equal(host?.kind, "state");
    assert.equal(host?.hostId, "scada");
    assert.equal(host?.messageType, "STATE");
    assert.equal(formatHostStateTopic("scada"), "spBv1.0/STATE/scada");
    const state = decodeHostState(JSON.stringify({ online: true, timestamp: 42 }));
    assert.equal(state.online, true);
    assert.equal(state.timestamp, 42);
  });
});

describe("SparkplugAdapter", () => {
  it("rejects missing broker url", async () => {
    await assert.rejects(() => new SparkplugAdapter("e", async () => new FakeMqtt()).connect({}), /url/);
  });

  it("publishes protobuf NBIRTH/NDATA and decodes via tools", async () => {
    const fake = new FakeMqtt();
    const adapter = new SparkplugAdapter("edge", async () => fake);
    await adapter.connect({
      url: "mqtt://127.0.0.1:1883",
      groupId: "IIoT",
      edgeNode: "press-01",
      allowWrite: true,
    });
    try {
      const names = (await adapter.listTools()).map((t) => t.name);
      assert.ok(names.includes("encode_payload"));
      assert.ok(names.includes("decode_payload"));
      assert.ok(names.includes("parse_message"));
      const encoded = (await adapter.invoke("encode_topic", { messageType: "NBIRTH" })) as { topic: string };
      assert.equal(encoded.topic, `${SPARKPLUG_NAMESPACE}/IIoT/NBIRTH/press-01`);

      const birth = (await adapter.invoke("nbirth", {
        metrics: [{ name: "rpm", value: 0, dataType: "Int32" }],
      })) as {
        topic: string;
        online: boolean;
        encoding: string;
        payload: { encoding: string; metrics: Array<{ name: string }> };
        base64: string;
      };
      assert.match(birth.topic, /NBIRTH\/press-01$/);
      assert.equal(birth.encoding, "protobuf");
      assert.equal(birth.payload.encoding, "protobuf");
      assert.ok(birth.payload.metrics.some((m) => m.name === "bdSeq"));
      assert.ok(!looksLikeJson(fake.published[0]?.payload ?? Buffer.alloc(0)));

      const decoded = (await adapter.invoke("decode_payload", { payload: birth.base64 })) as {
        encoding: string;
        metrics: Array<{ name: string }>;
      };
      assert.equal(decoded.encoding, "protobuf");

      const parsed = (await adapter.invoke("parse_message", {
        topic: "spBv1.0/IIoT/DDATA/press-01/motor",
        payload: { hex: FIXTURE.toString("hex") },
      })) as { messageType: string; kind: string; payload: { uuid?: string } };
      assert.equal(parsed.messageType, "DDATA");
      assert.equal(parsed.kind, "device");
      assert.equal(parsed.payload.uuid, "nbirth-fixture");

      await adapter.invoke("publish", {
        messageType: "NDATA",
        payload: { metrics: [{ name: "rpm", value: 12, dataType: "Int32" }] },
      });
      const data = fake.published.find((p) => p.topic.includes("NDATA"));
      assert.ok(data);
      const dataView = decodeSparkplugPayload(data!.payload);
      assert.equal(dataView.metrics[0]?.name, "rpm");

      const complex = (await adapter.invoke("encode_payload", {
        metrics: [
          {
            name: "samples",
            dataType: "DataSet",
            value: { columns: ["n"], types: ["Int32"], rows: [[7]] },
          },
        ],
      })) as { payload: { metrics: Array<{ name: string; value?: { rows?: unknown[][] } }> } };
      assert.deepEqual(complex.payload.metrics[0]?.value?.rows, [[7]]);
      const parsedComplex = (await adapter.invoke("parse_message", {
        topic: "spBv1.0/IIoT/NDATA/press-01",
        payload: { hex: FIXTURE.toString("hex") },
      })) as { payload: { metrics: Array<{ name: string }> } };
      assert.ok(parsedComplex.payload.metrics.length > 0);

      const listed = (await adapter.invoke("list_topics", {})) as { encoding: string };
      assert.equal(listed.encoding, "protobuf");
      const status = (await adapter.invoke("session_status", {})) as { online: boolean; bdSeq: number };
      assert.equal(status.online, true);
      assert.equal(status.bdSeq, 1);
      const death = (await adapter.invoke("ndeath", {})) as { online: boolean };
      assert.equal(death.online, false);
    } finally {
      await adapter.disconnect();
    }
  });

  it("defaults allowWrite=false and blocks nbirth/publish; encode still works", async () => {
    const fake = new FakeMqtt();
    const adapter = new SparkplugAdapter("ro", async () => fake);
    await adapter.connect({ url: "mqtt://127.0.0.1:1883", groupId: "IIoT", edgeNode: "press-01" });
    try {
      const encoded = (await adapter.invoke("encode_topic", { messageType: "NBIRTH" })) as { topic: string };
      assert.match(encoded.topic, /NBIRTH/);
      await assert.rejects(
        () => adapter.invoke("nbirth", { metrics: [{ name: "rpm", value: 1, dataType: "Int32" }] }),
        /allowWrite/,
      );
      await assert.rejects(
        () => adapter.invoke("publish", { messageType: "NDATA", payload: { metrics: [] } }),
        /allowWrite/,
      );
      assert.equal(fake.published.length, 0);
    } finally {
      await adapter.disconnect();
    }
  });

  it("omits MQTT LWT NDEATH when allowWrite=false and sets it when true", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const adapterRo = new SparkplugAdapter("lwt-ro", async (_url, opts) => {
      seen.push(opts);
      return new FakeMqtt();
    });
    await adapterRo.connect({ url: "mqtt://127.0.0.1:1883", groupId: "IIoT", edgeNode: "n1" });
    await adapterRo.disconnect();
    assert.equal(seen[0]?.will, undefined);

    const adapterRw = new SparkplugAdapter("lwt-rw", async (_url, opts) => {
      seen.push(opts);
      return new FakeMqtt();
    });
    await adapterRw.connect({ url: "mqtt://127.0.0.1:1883", groupId: "IIoT", edgeNode: "n1", allowWrite: true });
    await adapterRw.disconnect();
    const will = seen[1]?.will as { topic?: string } | undefined;
    assert.match(will?.topic ?? "", /NDEATH/);
  });

  it("keeps json-compat as an explicit fallback", async () => {
    const fake = new FakeMqtt();
    const adapter = new SparkplugAdapter("json", async () => fake);
    await adapter.connect({
      url: "mqtt://127.0.0.1:1883",
      groupId: "IIoT",
      edgeNode: "press-01",
      encoding: "json-compat",
      allowWrite: true,
    });
    try {
      await adapter.invoke("nbirth", { metrics: [{ name: "rpm", value: 1, dataType: "Int32" }] });
      const text = fake.published[0]?.payload.toString("utf8") ?? "";
      assert.match(text, /json-compat/);
      const listed = (await adapter.invoke("list_topics", {})) as { encoding: string };
      assert.equal(listed.encoding, "json-compat");
    } finally {
      await adapter.disconnect();
    }
  });

  it("subscribes read-only Host STATE (stub) and does not require allowWrite", async () => {
    const fake = new FakeMqtt();
    const adapter = new SparkplugAdapter("host", async () => fake);
    await adapter.connect({ url: "mqtt://127.0.0.1:1883", groupId: "IIoT", edgeNode: "press-01" });
    try {
      const names = (await adapter.listTools()).map((t) => t.name);
      assert.ok(names.includes("host_state"));
      await assert.rejects(() => adapter.invoke("host_state", {}), /hostId/);
      const pending = adapter.invoke("host_state", { hostId: "scada", timeoutMs: 500 });
      await new Promise((r) => setImmediate(r));
      await fake.publishAsync("spBv1.0/STATE/scada", JSON.stringify({ online: true, timestamp: 99 }));
      const rec = (await pending) as {
        topic: string;
        hostId: string;
        online: boolean;
        timestamp?: number;
        stub: boolean;
      };
      assert.equal(rec.topic, "spBv1.0/STATE/scada");
      assert.equal(rec.hostId, "scada");
      assert.equal(rec.online, true);
      assert.equal(rec.timestamp, 99);
      assert.equal(rec.stub, true);
      const parsed = (await adapter.invoke("parse_message", {
        topic: "spBv1.0/STATE/scada",
        payload: { online: false, timestamp: 1 },
      })) as { kind: string; hostState?: { online: boolean } };
      assert.equal(parsed.kind, "state");
      assert.equal(parsed.hostState?.online, false);
    } finally {
      await adapter.disconnect();
    }
  });

  it("Host Application MVP publishes retained STATE and rebirth NCMD", async () => {
    const fake = new FakeMqtt();
    const adapter = new SparkplugAdapter("scada", async () => fake);
    await adapter.connect({
      url: "mqtt://127.0.0.1:1883",
      groupId: "IIoT",
      edgeNode: "press-01",
      hostId: "scada",
      allowWrite: true,
    });
    try {
      const names = (await adapter.listTools()).map((t) => t.name);
      assert.ok(names.includes("host_online"));
      assert.ok(names.includes("host_offline"));
      assert.ok(names.includes("rebirth"));
      const on = (await adapter.invoke("host_online", {})) as {
        retained: boolean;
        online: boolean;
        topic: string;
        role: string;
      };
      assert.equal(on.role, "host");
      assert.equal(on.retained, true);
      assert.equal(on.online, true);
      assert.equal(on.topic, "spBv1.0/STATE/scada");
      assert.equal(fake.published[0]?.retain, true);
      const snap = (await adapter.invoke("host_state", {})) as { stub: boolean; role: string; online: boolean };
      assert.equal(snap.stub, false);
      assert.equal(snap.role, "host");
      assert.equal(snap.online, true);
      const off = (await adapter.invoke("host_offline", {})) as { online: boolean };
      assert.equal(off.online, false);
      const rebirth = (await adapter.invoke("rebirth", {})) as { topic: string; metric: string };
      assert.equal(rebirth.topic, "spBv1.0/IIoT/NCMD/press-01");
      assert.equal(rebirth.metric, "Node Control/Rebirth");
      const ncmd = fake.published.find((p) => p.topic.includes("NCMD"));
      assert.ok(ncmd);
      const view = decodeSparkplugPayload(ncmd!.payload);
      assert.equal(view.metrics[0]?.name, "Node Control/Rebirth");
      assert.equal(view.metrics[0]?.value, true);
    } finally {
      await adapter.disconnect();
    }

    const ro = new SparkplugAdapter("scada-ro", async () => new FakeMqtt());
    await ro.connect({ url: "mqtt://127.0.0.1:1883", hostId: "scada" });
    try {
      await assert.rejects(
        () => ro.invoke("host_online", {}),
        (err: unknown) => err instanceof AdapterError && /allowWrite/.test(err.message),
      );
      await assert.rejects(() => ro.invoke("rebirth", {}), /allowWrite/);
    } finally {
      await ro.disconnect();
    }
  });
});

function looksLikeJson(buf: Buffer): boolean {
  return buf[0] === 0x7b;
}
