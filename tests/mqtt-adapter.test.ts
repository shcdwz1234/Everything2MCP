import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import {
  MqttAdapter,
  sharedSubscriptionFilter,
  topicMatches,
  type MqttBrokerClient,
  type MqttConnectFn,
} from "../src/adapters/mqtt/index.js";

class FakeMqttClient extends EventEmitter implements MqttBrokerClient {
  connected = true;
  published: Array<{ topic: string; payload: string; qos: number; retain: boolean }> = [];
  subscriptions = new Set<string>();

  async publishAsync(
    topic: string,
    payload: string | Buffer,
    opts?: { qos?: 0 | 1 | 2; retain?: boolean },
  ): Promise<unknown> {
    const text = typeof payload === "string" ? payload : payload.toString("utf8");
    const retain = Boolean(opts?.retain);
    const qos = opts?.qos ?? 0;
    this.published.push({ topic, payload: text, qos, retain });
    this.emit("message", topic, Buffer.from(text), { retain });
    return undefined;
  }

  async subscribeAsync(topic: string): Promise<unknown> {
    this.subscriptions.add(topic);
    return [];
  }

  async unsubscribeAsync(topic: string | string[]): Promise<unknown> {
    const topics = Array.isArray(topic) ? topic : [topic];
    for (const t of topics) this.subscriptions.delete(t);
    return undefined;
  }

  async endAsync(): Promise<void> {
    this.connected = false;
  }
}

function fakeMqttConnect(client: FakeMqttClient = new FakeMqttClient()): {
  client: FakeMqttClient;
  connect: MqttConnectFn;
} {
  return { client, connect: async () => client };
}

describe("MqttAdapter", () => {
  it("rejects missing broker url", async () => {
    const adapter = new MqttAdapter("bad");
    await assert.rejects(() => adapter.connect({ topics: ["a"] }), /config\.url/);
  });

  it("lists publish, subscribe_once, and list_topics after connect", async () => {
    const { connect } = fakeMqttConnect();
    const adapter = new MqttAdapter("local", connect);
    await adapter.connect({
      url: "mqtt://127.0.0.1:1883",
      topics: ["sensors/#", "commands/device1"],
    });
    const tools = await adapter.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ["list_topics", "publish", "subscribe_once"],
    );
    const listed = await adapter.invoke("list_topics", {});
    assert.deepEqual(listed, { topics: ["sensors/#", "commands/device1"] });
    const health = await adapter.health();
    assert.equal(health.ok, true);
    await adapter.disconnect();
  });

  it("publishes and receive via subscribe_once on a fake broker", async () => {
    const fake = new FakeMqttClient();
    const adapter = new MqttAdapter("bus", async () => fake);
    await adapter.connect({ url: "mqtt://fake", topics: ["t"], allowWrite: true });

    const pending = adapter.invoke("subscribe_once", { topic: "sensors/temp", timeoutMs: 500 });
    await new Promise((r) => setImmediate(r));
    assert.equal(fake.subscriptions.has("sensors/temp"), true);
    const pub = (await adapter.invoke("publish", {
      topic: "sensors/temp",
      payload: { c: 21 },
      qos: 1,
    })) as { ok: boolean; topic: string };
    assert.equal(pub.ok, true);
    assert.equal(fake.published[0]?.topic, "sensors/temp");

    const msg = (await pending) as { topic: string; payload: string };
    assert.equal(msg.topic, "sensors/temp");
    assert.equal(msg.payload, JSON.stringify({ c: 21 }));
    await adapter.disconnect();
    assert.equal(fake.connected, false);
  });

  it("matches wildcard filters used by subscribe_once", async () => {
    const fake = new FakeMqttClient();
    const adapter = new MqttAdapter("wild", async () => fake);
    await adapter.connect({ url: "mqtt://fake", allowWrite: true });
    const pending = adapter.invoke("subscribe_once", { topic: "sensors/+", timeoutMs: 500 });
    await new Promise((r) => setImmediate(r));
    await adapter.invoke("publish", { topic: "sensors/x", payload: "ok" });
    const msg = (await pending) as { topic: string; payload: string };
    assert.equal(msg.topic, "sensors/x");
    assert.equal(msg.payload, "ok");
    await adapter.disconnect();
  });

  it("subscribe_once accepts a $share filter and matches the inner topic", async () => {
    const fake = new FakeMqttClient();
    const adapter = new MqttAdapter("share", async () => fake);
    await adapter.connect({ url: "mqtt://fake", allowWrite: true });
    const pending = adapter.invoke("subscribe_once", {
      topic: "$share/workers/sensors/+",
      timeoutMs: 500,
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(fake.subscriptions.has("$share/workers/sensors/+"), true);
    await adapter.invoke("publish", { topic: "sensors/x", payload: "ok" });
    const msg = (await pending) as { topic: string; payload: string };
    assert.equal(msg.topic, "sensors/x");
    assert.equal(msg.payload, "ok");
    await adapter.disconnect();
  });

  it("times out subscribe_once and rejects unknown tools", async () => {
    const adapter = new MqttAdapter("t", async () => new FakeMqttClient());
    await adapter.connect({ url: "mqtt://fake" });
    await assert.rejects(
      () => adapter.invoke("subscribe_once", { topic: "none", timeoutMs: 25 }),
      /Timed out/,
    );
    await assert.rejects(() => adapter.invoke("nope", {}), /Unknown MQTT tool/);
    await adapter.disconnect();
  });

  it("defaults allowWrite=false and blocks publish; subscribe still works", async () => {
    const fake = new FakeMqttClient();
    const adapter = new MqttAdapter("ro", async () => fake);
    await adapter.connect({ url: "mqtt://fake" });
    try {
      await assert.rejects(() => adapter.invoke("publish", { topic: "t", payload: "x" }), /allowWrite/);
      const listed = (await adapter.invoke("list_topics", {})) as { topics: string[] };
      assert.ok(Array.isArray(listed.topics));
    } finally {
      await adapter.disconnect();
    }
  });

  it("requires connect before listTools", async () => {
    const adapter = new MqttAdapter("n");
    await assert.rejects(() => adapter.listTools(), /not connected/);
  });
});

describe("topicMatches", () => {
  it("supports + and #", () => {
    assert.equal(topicMatches("a/+/c", "a/b/c"), true);
    assert.equal(topicMatches("a/#", "a/b/c"), true);
    assert.equal(topicMatches("a/b", "a/c"), false);
  });

  it("strips MQTT 5 $share/{group}/ before matching", () => {
    assert.equal(sharedSubscriptionFilter("$share/workers/sensors/+"), "sensors/+");
    assert.equal(topicMatches("$share/workers/sensors/+", "sensors/x"), true);
    assert.equal(topicMatches("$share/workers/sensors/+", "other/x"), false);
    assert.equal(topicMatches("$share/g1/#", "a/b"), true);
  });
});
