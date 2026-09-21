import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { AsyncApiAdapter } from "../src/adapters/asyncapi/index.js";
import { EventEmitter } from "node:events";
import type { MqttBrokerClient } from "../src/adapters/mqtt/index.js";

const specPath = fileURLToPath(new URL("../examples/streetlights.asyncapi.json", import.meta.url));

class FakeMqtt extends EventEmitter implements MqttBrokerClient {
  connected = true;
  published: string[] = [];
  async publishAsync(topic: string, payload: string | Buffer): Promise<unknown> {
    this.published.push(topic);
    this.emit("message", topic, Buffer.from(typeof payload === "string" ? payload : payload.toString()));
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

describe("AsyncApiAdapter", () => {
  it("rejects missing spec", async () => {
    await assert.rejects(() => new AsyncApiAdapter("a").connect({}), /spec/);
  });

  it("lists channels and dry-runs publish without a broker", async () => {
    const adapter = new AsyncApiAdapter("lights");
    await adapter.connect({ spec: specPath });
    const tools = await adapter.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ["list_channels", "publish", "subscribe_once"],
    );
    const listed = (await adapter.invoke("list_channels", {})) as { channels: Array<{ channel: string }>; bind: string };
    assert.equal(listed.bind, "none");
    assert.ok(listed.channels.some((c) => c.channel.includes("smartlight")));
    const pub = (await adapter.invoke("publish", { channel: "smartlight/events/light/measured", payload: { lumens: 3 } })) as {
      dryRun: boolean;
    };
    assert.equal(pub.dryRun, true);
    await adapter.disconnect();
  });

  it("publishes over an injected MQTT bind", async () => {
    const fake = new FakeMqtt();
    const adapter = new AsyncApiAdapter("bound", async () => fake);
    await adapter.connect({ spec: specPath, brokerUrl: "mqtt://127.0.0.1:1883", allowWrite: true });
    const pub = (await adapter.invoke("publish", { channel: "smartlight/events/light/measured", payload: { lumens: 9 } })) as {
      transport: string;
    };
    assert.equal(pub.transport, "mqtt");
    assert.equal(fake.published[0], "smartlight/events/light/measured");
    await adapter.disconnect();
  });

  it("publishes over injected WebSocket and Kafka binds", async () => {
    const specPathLocal = specPath;
    const frames: string[] = [];
    const wsAdapter = new AsyncApiAdapter("ws", {
      websocket: async () => ({
        async send(data) {
          frames.push(data);
        },
        async receiveOnce() {
          return { payload: frames[0] ?? "" };
        },
        async close() {
          /* noop */
        },
      }),
    });
    await wsAdapter.connect({ spec: specPathLocal, brokerUrl: "ws://127.0.0.1:9001", allowWrite: true });
    const wsPub = (await wsAdapter.invoke("publish", { channel: "smartlight/events/light/measured", payload: { lumens: 1 } })) as {
      transport: string;
    };
    assert.equal(wsPub.transport, "websocket");
    const once = (await wsAdapter.invoke("subscribe_once", { channel: "smartlight/events/light/measured" })) as { payload: string };
    assert.match(once.payload, /lumens/);
    await wsAdapter.disconnect();

    const produced: Array<{ topic: string; value: string }> = [];
    const kafkaAdapter = new AsyncApiAdapter("k", {
      kafka: async () => ({
        async produce(topic, value) {
          produced.push({ topic, value });
        },
        async consumeOnce(topic) {
          const hit = produced.find((p) => p.topic === topic);
          return { topic, value: hit?.value ?? "" };
        },
        async listTopics() {
          return produced.map((p) => p.topic);
        },
        async close() {
          /* noop */
        },
      }),
    });
    await kafkaAdapter.connect({ spec: specPathLocal, brokerUrl: "kafka://127.0.0.1:9092", allowWrite: true });
    const kPub = (await kafkaAdapter.invoke("publish", { channel: "smartlight/events/light/measured", payload: { lumens: 4 } })) as {
      transport: string;
    };
    assert.equal(kPub.transport, "kafka");
    assert.equal(produced[0]?.topic, "smartlight/events/light/measured");
    await kafkaAdapter.disconnect();
  });

  it("dry-run publish stays allowed; live bind publish needs allowWrite", async () => {
    const dry = new AsyncApiAdapter("dry");
    await dry.connect({ spec: specPath });
    try {
      const pub = (await dry.invoke("publish", {
        channel: "smartlight/events/light/measured",
        payload: { lumens: 1 },
      })) as { dryRun: boolean };
      assert.equal(pub.dryRun, true);
    } finally {
      await dry.disconnect();
    }

    const fake = new FakeMqtt();
    const live = new AsyncApiAdapter("live", async () => fake);
    await live.connect({ spec: specPath, brokerUrl: "mqtt://127.0.0.1:1883" });
    try {
      await assert.rejects(
        () => live.invoke("publish", { channel: "smartlight/events/light/measured", payload: { lumens: 1 } }),
        /allowWrite/,
      );
      const listed = (await live.invoke("list_channels", {})) as { bind: string };
      assert.equal(listed.bind, "mqtt");
    } finally {
      await live.disconnect();
    }
  });

  it("rejects tools before connect and unknown tools", async () => {
    const adapter = new AsyncApiAdapter("lights");
    await assert.rejects(() => adapter.listTools(), /not connected/);
    await adapter.connect({ spec: specPath });
    try {
      await assert.rejects(() => adapter.invoke("nope", {}), /Unknown AsyncAPI tool/);
    } finally {
      await adapter.disconnect();
    }
  });
});
