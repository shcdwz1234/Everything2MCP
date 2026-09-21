import { loadJsonOrYaml } from "../../runtime/load.js";
import { AdapterError } from "../../runtime/errors.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { payloadToString, requiredString, stringArray, stringField, timeoutMs } from "../helpers.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";
import type { MqttBrokerClient, MqttConnectFn } from "../mqtt/index.js";
import { connectAsync } from "mqtt";
import { connectKafka, type KafkaConnectFn, type KafkaHandle } from "../kafka/index.js";
import WebSocket from "ws";

interface ChannelOp {
  channel: string;
  kind: "publish" | "subscribe";
  description?: string;
}

export type AsyncApiBind = "none" | "mqtt" | "websocket" | "kafka";

export interface WsBindClient {
  send(data: string): Promise<void>;
  receiveOnce(timeoutMs: number): Promise<{ payload: string }>;
  close(): Promise<void>;
}

export type WsBindConnectFn = (url: string) => Promise<WsBindClient>;

export interface AsyncApiBinds {
  mqtt?: MqttConnectFn;
  kafka?: KafkaConnectFn;
  websocket?: WsBindConnectFn;
}

/**
 * AsyncAPI 2.x/3.x: list channels; bind MQTT, WebSocket, or Kafka when brokerUrl is set.
 * Without a broker the publish tool is dry-run (inspect-only).
 */
export class AsyncApiAdapter implements ProtocolAdapter {
  readonly protocol = "asyncapi";
  private connected = false;
  private channels: ChannelOp[] = [];
  private title = "";
  private bind: AsyncApiBind = "none";
  private mqtt: MqttBrokerClient | undefined;
  private kafka: KafkaHandle | undefined;
  private ws: WsBindClient | undefined;
  private readonly mqttConnect: MqttConnectFn;
  private readonly extra: AsyncApiBinds;
  private allowWrite = false;

  constructor(
    readonly id: string,
    mqttOrBinds: MqttConnectFn | AsyncApiBinds = defaultMqtt,
    extra: AsyncApiBinds = {},
  ) {
    if (typeof mqttOrBinds === "function") {
      this.mqttConnect = mqttOrBinds;
      this.extra = extra;
    } else {
      this.mqttConnect = mqttOrBinds.mqtt ?? defaultMqtt;
      this.extra = mqttOrBinds;
    }
  }

  async connect(config: Record<string, unknown>): Promise<void> {
    const spec = stringField(config, "spec") ?? stringField(config, "asyncapi");
    if (!spec) throw new Error("AsyncAPI adapter requires config.spec");
    const { value } = await loadJsonOrYaml(spec);
    const doc = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    this.title = String((doc.info as { title?: string } | undefined)?.title ?? doc.id ?? "asyncapi");
    this.channels = collectChannels(doc);
    const broker = stringField(config, "brokerUrl") ?? stringField(config, "url");
    this.allowWrite = allowWriteFrom(config);
    this.bind = resolveBind(broker, config);
    if (this.bind === "mqtt" && broker) {
      this.mqtt = await this.mqttConnect(broker, { reconnectPeriod: 0, connectTimeout: 8000 });
    } else if (this.bind === "websocket" && broker) {
      const connectWs = this.extra.websocket ?? defaultWsBind;
      this.ws = await connectWs(broker);
    } else if (this.bind === "kafka") {
      const brokers = kafkaBrokers(broker, config);
      if (!brokers.length) {
        throw new AdapterError("E_INVALID_CONFIG", "AsyncAPI Kafka bind requires kafka:// brokerUrl or config.brokers", {
          protocol: "asyncapi",
        });
      }
      const fn = this.extra.kafka ?? connectKafka;
      this.kafka = await fn({ ...config, brokers });
    }
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.mqtt) {
      await this.mqtt.endAsync();
      this.mqtt = undefined;
    }
    if (this.kafka) {
      await this.kafka.close();
      this.kafka = undefined;
    }
    if (this.ws) {
      await this.ws.close();
      this.ws = undefined;
    }
    this.connected = false;
    this.channels = [];
    this.bind = "none";
  }

  async listTools(): Promise<McpToolSchema[]> {
    this.assertConnected();
    return [
      {
        name: "list_channels",
        description: `List channels from AsyncAPI spec (${this.title})`,
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "publish",
        description: "Publish to a bound broker (requires allowWrite=true). Unbound publish stays dry-run.",
        inputSchema: {
          type: "object",
          properties: {
            channel: { type: "string" },
            payload: {},
          },
          required: ["channel"],
          additionalProperties: false,
        },
      },
      {
        name: "subscribe_once",
        description: "Wait for one message on a channel (requires MQTT, WebSocket, or Kafka bind)",
        inputSchema: {
          type: "object",
          properties: {
            channel: { type: "string" },
            timeoutMs: { type: "integer", default: 5000 },
          },
          required: ["channel"],
          additionalProperties: false,
        },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    if (toolName === "list_channels") {
      return { title: this.title, bind: this.bind, channels: this.channels };
    }
    if (toolName === "publish") {
      const channel = requiredString(args, "channel");
      const payload = payloadToString(args.payload ?? {});
      if (this.mqtt || this.kafka || this.ws) assertCanWrite("asyncapi", this.allowWrite);
      if (this.mqtt) {
        await this.mqtt.publishAsync(channel, payload);
        return { ok: true, channel, bytes: Buffer.byteLength(payload), transport: "mqtt" };
      }
      if (this.kafka) {
        await this.kafka.produce(channel, payload);
        return { ok: true, channel, bytes: Buffer.byteLength(payload), transport: "kafka" };
      }
      if (this.ws) {
        await this.ws.send(JSON.stringify({ channel, payload: args.payload ?? {} }));
        return { ok: true, channel, bytes: Buffer.byteLength(payload), transport: "websocket" };
      }
      return { ok: true, dryRun: true, channel, payload, title: this.title, bind: "none" };
    }
    if (toolName === "subscribe_once") {
      const channel = requiredString(args, "channel");
      const ms = timeoutMs(args);
      if (this.mqtt) {
        await this.mqtt.subscribeAsync(channel);
        return waitMqtt(this.mqtt, ms);
      }
      if (this.kafka) {
        return this.kafka.consumeOnce(channel, ms);
      }
      if (this.ws) {
        return this.ws.receiveOnce(ms);
      }
      throw new Error("subscribe_once requires config.brokerUrl bound to MQTT, WebSocket, or Kafka");
    }
    throw new Error(`Unknown AsyncAPI tool "${toolName}"`);
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return {
      ok: true,
      detail: `channels=${this.channels.length} bind=${this.bind} title=${this.title} allowWrite=${this.allowWrite} dryRun=${!(this.mqtt || this.kafka || this.ws)}`,
    };
  }

  private assertConnected(): void {
    if (!this.connected) throw new Error("AsyncAPI adapter is not connected");
  }
}

const defaultMqtt: MqttConnectFn = (url, opts) =>
  connectAsync(url, opts) as unknown as Promise<MqttBrokerClient>;

function resolveBind(broker: string | undefined, config: Record<string, unknown>): AsyncApiBind {
  const explicit = stringField(config, "bind")?.toLowerCase();
  if (explicit === "mqtt" || explicit === "websocket" || explicit === "ws" || explicit === "kafka") {
    if (!broker && explicit !== "kafka") return "none";
    if (explicit === "ws") return "websocket";
    return explicit as AsyncApiBind;
  }
  if (!broker) return "none";
  if (/^mqtts?:\/\//i.test(broker)) return "mqtt";
  if (/^wss?:\/\//i.test(broker)) return "websocket";
  if (/^kafka:\/\//i.test(broker)) return "kafka";
  return "none";
}

function kafkaBrokers(broker: string | undefined, config: Record<string, unknown>): string[] {
  const fromArr = stringArray(config.brokers);
  if (fromArr.length) return fromArr;
  if (broker) return [broker.replace(/^kafka:\/\//i, "")];
  return [];
}

function collectChannels(doc: Record<string, unknown>): ChannelOp[] {
  const out: ChannelOp[] = [];
  const channels = doc.channels;
  if (channels && typeof channels === "object") {
    for (const [name, raw] of Object.entries(channels as Record<string, unknown>)) {
      const ch = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      if (ch.publish) out.push({ channel: name, kind: "publish", description: str(ch.description) });
      if (ch.subscribe) out.push({ channel: name, kind: "subscribe", description: str(ch.description) });
      if (!ch.publish && !ch.subscribe) out.push({ channel: name, kind: "publish", description: str(ch.description) });
    }
  }
  const ops = doc.operations;
  if (ops && typeof ops === "object") {
    for (const [opName, raw] of Object.entries(ops as Record<string, unknown>)) {
      const op = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const action = String(op.action ?? "send");
      const ref = String((op.channel as { $ref?: string } | undefined)?.$ref ?? opName);
      const channel = ref.split("/").pop() ?? opName;
      out.push({
        channel,
        kind: action === "receive" ? "subscribe" : "publish",
        description: str(op.summary) ?? opName,
      });
    }
  }
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function waitMqtt(
  client: MqttBrokerClient,
  timeoutMsValue: number,
): Promise<{ topic: string; payload: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off("message", onMessage);
      reject(new Error(`Timed out waiting for AsyncAPI message`));
    }, timeoutMsValue);
    const onMessage = (topic: string, payload: Buffer) => {
      clearTimeout(timer);
      client.off("message", onMessage);
      resolve({ topic, payload: payload.toString("utf8") });
    };
    client.on("message", onMessage);
  });
}

async function defaultWsBind(url: string): Promise<WsBindClient> {
  const inbox: string[] = [];
  const waiters: Array<(data: string) => void> = [];
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url);
    const onError = (err: Error) => {
      socket.off("open", onOpen);
      reject(err);
    };
    const onOpen = () => {
      socket.off("error", onError);
      resolve(socket);
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.on("message", (data) => {
      const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      const waiter = waiters.shift();
      if (waiter) waiter(text);
      else inbox.push(text);
    });
  });
  return {
    async send(data) {
      ws.send(data);
    },
    receiveOnce(ms) {
      const buffered = inbox.shift();
      if (buffered !== undefined) return Promise.resolve({ payload: buffered });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for AsyncAPI WebSocket message")), ms);
        waiters.push((payload) => {
          clearTimeout(timer);
          resolve({ payload });
        });
      });
    },
    async close() {
      await new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        ws.once("close", () => resolve());
        ws.close();
      });
    },
  };
}
