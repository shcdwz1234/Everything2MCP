import { connectAsync } from "mqtt";
import { parseAuth } from "../../runtime/auth.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";

export type MqttMessageHandler = (
  topic: string,
  payload: Buffer,
  packet: { retain?: boolean },
) => void;

/** Minimal MQTT client surface used by the adapter (real mqtt.js or a test fake). */
export interface MqttBrokerClient {
  connected: boolean;
  publishAsync(
    topic: string,
    payload: string | Buffer,
    opts?: { qos?: 0 | 1 | 2; retain?: boolean },
  ): Promise<unknown>;
  subscribeAsync(topic: string): Promise<unknown>;
  unsubscribeAsync(topic: string | string[]): Promise<unknown>;
  endAsync(): Promise<void>;
  on(event: "message", listener: MqttMessageHandler): this;
  off(event: "message", listener: MqttMessageHandler): this;
}

export type MqttConnectFn = (
  url: string,
  opts: Record<string, unknown>,
) => Promise<MqttBrokerClient>;

const defaultConnect: MqttConnectFn = (url, opts) =>
  connectAsync(url, opts) as unknown as Promise<MqttBrokerClient>;

export class MqttAdapter implements ProtocolAdapter {
  readonly protocol = "mqtt";
  private client: MqttBrokerClient | undefined;
  private topics: string[] = [];
  private connected = false;
  private allowWrite = false;

  constructor(
    readonly id: string,
    private readonly connectFn: MqttConnectFn = defaultConnect,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    const url =
      typeof config.url === "string"
        ? config.url
        : typeof config.brokerUrl === "string"
          ? config.brokerUrl
          : undefined;
    if (!url) throw new Error("MQTT adapter requires config.url (e.g. mqtt://127.0.0.1:1883)");
    const auth = parseAuth(config);
    this.topics = Array.isArray(config.topics)
      ? config.topics.filter((t): t is string => typeof t === "string")
      : [];
    this.allowWrite = allowWriteFrom(config);
    const username = typeof config.username === "string" ? config.username : auth?.username;
    const password =
      typeof config.password === "string" ? config.password : (auth?.password ?? auth?.token);
    this.client = await this.connectFn(url, {
      clientId: typeof config.clientId === "string" ? config.clientId : `everything2mcp-${this.id}`,
      username,
      password,
      connectTimeout: typeof config.connectTimeoutMs === "number" ? config.connectTimeoutMs : 8000,
      reconnectPeriod: 0,
    });
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.endAsync();
      this.client = undefined;
    }
    this.connected = false;
  }

  async listTools(): Promise<McpToolSchema[]> {
    this.assertConnected();
    return [
      {
        name: "publish",
        description: "Publish a message to an MQTT topic (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: {
            topic: { type: "string", description: "Topic to publish to" },
            payload: { description: "String or JSON-serializable payload" },
            qos: { type: "integer", enum: [0, 1, 2], default: 0 },
            retain: { type: "boolean", default: false },
          },
          required: ["topic", "payload"],
          additionalProperties: false,
        },
      },
      {
        name: "subscribe_once",
        description:
          "Subscribe to a topic and wait for a single message (MQTT 5 $share/{group}/{filter} matches the inner filter)",
        inputSchema: {
          type: "object",
          properties: {
            topic: { type: "string" },
            timeoutMs: { type: "integer", default: 5000 },
          },
          required: ["topic"],
          additionalProperties: false,
        },
      },
      {
        name: "list_topics",
        description: "List topics configured on this MQTT registration",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const client = this.client!;
    if (toolName === "list_topics") {
      return { topics: this.topics };
    }
    if (toolName === "publish") {
      assertCanWrite("mqtt", this.allowWrite);
      const topic = requiredString(args, "topic");
      const qos = args.qos === 1 || args.qos === 2 ? args.qos : 0;
      const retain = Boolean(args.retain);
      const payload =
        typeof args.payload === "string" ? args.payload : JSON.stringify(args.payload ?? "");
      await client.publishAsync(topic, payload, { qos, retain });
      return { ok: true, topic, bytes: Buffer.byteLength(payload) };
    }
    if (toolName === "subscribe_once") {
      const topic = requiredString(args, "topic");
      const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : 5000;
      await client.subscribeAsync(topic);
      try {
        const message = await waitForMessage(client, topic, timeoutMs);
        return message;
      } finally {
        await client.unsubscribeAsync(topic);
      }
    }
    throw new Error(`Unknown MQTT tool "${toolName}"`);
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected || !this.client) return { ok: false, detail: "not connected" };
    return {
      ok: this.client.connected,
      detail: this.client.connected
        ? `connected allowWrite=${this.allowWrite}`
        : `disconnected allowWrite=${this.allowWrite}`,
    };
  }

  private assertConnected(): void {
    if (!this.connected || !this.client) throw new Error("MQTT adapter is not connected");
  }
}

export function sharedSubscriptionFilter(filter: string): string {
  if (filter.startsWith("$share/")) {
    const rest = filter.slice("$share/".length);
    const slash = rest.indexOf("/");
    if (slash > 0 && slash < rest.length - 1) return rest.slice(slash + 1);
  }
  return filter;
}

export function topicMatches(filter: string, topic: string): boolean {
  const f = sharedSubscriptionFilter(filter).split("/");
  const t = topic.split("/");
  for (let i = 0; i < f.length; i += 1) {
    const part = f[i];
    if (part === "#") return true;
    if (part === "+") continue;
    if (part !== t[i]) return false;
  }
  return f.length === t.length;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v) throw new Error(`Missing required string "${key}"`);
  return v;
}

function waitForMessage(
  client: MqttBrokerClient,
  topic: string,
  timeoutMs: number,
): Promise<{ topic: string; payload: string; retained: boolean }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off("message", onMessage);
      reject(new Error(`Timed out waiting for MQTT message on ${topic}`));
    }, timeoutMs);
    const onMessage: MqttMessageHandler = (incoming, payload, packet) => {
      if (incoming !== topic && !topicMatches(topic, incoming)) return;
      clearTimeout(timer);
      client.off("message", onMessage);
      resolve({
        topic: incoming,
        payload: payload.toString("utf8"),
        retained: Boolean(packet.retain),
      });
    };
    client.on("message", onMessage);
  });
}

