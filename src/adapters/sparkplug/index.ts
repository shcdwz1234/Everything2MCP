import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { AdapterError } from "../../runtime/errors.js";
import { requiredString, stringField } from "../helpers.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";
import {
  type MqttBrokerClient,
  type MqttConnectFn,
  topicMatches,
} from "../mqtt/index.js";
import { connectAsync } from "mqtt";
import {
  SPARKPLUG_MESSAGE_TYPES,
  SPARKPLUG_NAMESPACE,
  SPARKPLUG_PROTO_SOURCE,
  type SparkplugEncoding,
  type SparkplugMetric,
  type SparkplugPayloadView,
  decodeAnyPayload,
  decodeHostState,
  encodeHostState,
  encodeSparkplugPayload,
  formatHostStateTopic,
  formatRebirthTopic,
  formatSparkplugTopic,
  isSparkplugMessageType,
  parseSparkplugTopic,
} from "./codec.js";

export {
  SPARKPLUG_MESSAGE_TYPES,
  SPARKPLUG_NAMESPACE,
  SPARKPLUG_PROTO_SOURCE,
  decodeAnyPayload,
  decodeHostState,
  decodeSparkplugPayload,
  encodeHostState,
  encodeSparkplugPayload,
  formatHostStateTopic,
  formatRebirthTopic,
  formatSparkplugTopic,
  parseSparkplugTopic,
} from "./codec.js";

export const SPARKPLUG_PAYLOAD_ENCODING: SparkplugEncoding = "protobuf";

function bdSeqMetric(bdSeq: number, timestamp: number): SparkplugMetric {
  return { name: "bdSeq", timestamp, dataType: "UInt64", value: bdSeq };
}

function viewToJsonCompat(view: SparkplugPayloadView): Record<string, unknown> {
  return {
    timestamp: view.timestamp,
    seq: view.seq,
    ...(view.uuid ? { uuid: view.uuid } : {}),
    metrics: view.metrics,
    encoding: "json-compat",
  };
}

function serializePayload(view: SparkplugPayloadView, encoding: SparkplugEncoding): Buffer {
  if (encoding === "json-compat") {
    return Buffer.from(JSON.stringify(viewToJsonCompat(view)), "utf8");
  }
  return encodeSparkplugPayload(view);
}

function buildView(opts: {
  seq: number;
  metrics?: SparkplugMetric[];
  uuid?: string;
  timestamp?: number;
}): SparkplugPayloadView {
  const timestamp = opts.timestamp ?? Date.now();
  return {
    timestamp,
    seq: opts.seq,
    uuid: opts.uuid,
    metrics: (opts.metrics ?? []).map((m) => ({ ...m, timestamp: m.timestamp ?? timestamp })),
    encoding: "protobuf",
  };
}

/** Sparkplug B over MQTT. Default payload is official protobuf; json-compat is a fallback. */
export class SparkplugAdapter implements ProtocolAdapter {
  readonly protocol = "sparkplug";
  private client: MqttBrokerClient | undefined;
  private connected = false;
  private groupId = "default";
  private edgeNode = "node";
  private deviceId: string | undefined;
  private hostId = "";
  private online = false;
  private bdSeq = 0;
  private seq = 0;
  private lastBirthTopic: string | undefined;
  private encoding: SparkplugEncoding = "protobuf";
  private allowWrite = false;
  private hostPublished?: { hostId: string; online: boolean; timestamp: number; topic: string };

  constructor(
    readonly id: string,
    private readonly connectFn: MqttConnectFn = (url, opts) =>
      connectAsync(url, opts) as unknown as Promise<MqttBrokerClient>,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    const url = stringField(config, "url") ?? stringField(config, "brokerUrl");
    if (!url) throw new Error("Sparkplug adapter requires config.url (mqtt://host:port)");
    this.groupId = stringField(config, "groupId") ?? "default";
    this.edgeNode = stringField(config, "edgeNode") ?? stringField(config, "node") ?? "node";
    this.deviceId = stringField(config, "deviceId");
    this.hostId = stringField(config, "hostId") ?? stringField(config, "sparkplugHostId") ?? "";
    this.encoding = config.encoding === "json-compat" ? "json-compat" : "protobuf";
    this.allowWrite = allowWriteFrom(config);
    this.online = false;
    this.bdSeq = typeof config.bdSeq === "number" ? config.bdSeq : 0;
    this.seq = 0;
    this.lastBirthTopic = undefined;
    this.hostPublished = undefined;
    const mqttOpts: Record<string, unknown> = {
      clientId: `e2mcp-sp-${this.id}`,
      reconnectPeriod: 0,
      connectTimeout: 8000,
    };
    if (this.allowWrite) {
      const death = buildView({ seq: 0, metrics: [bdSeqMetric(this.bdSeq, Date.now())] });
      mqttOpts.will = {
        topic: this.topic("NDEATH"),
        payload: serializePayload(death, this.encoding),
        qos: 1,
        retain: false,
      };
    }
    this.client = await this.connectFn(url, mqttOpts);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.endAsync();
      this.client = undefined;
    }
    this.connected = false;
    this.online = false;
  }

  async listTools(): Promise<McpToolSchema[]> {
    this.assertConnected();
    return [
      {
        name: "encode_topic",
        description: "Build a Sparkplug B topic spBv1.0/{group}/{type}/{edge}[/{device}]",
        inputSchema: {
          type: "object",
          properties: {
            messageType: { type: "string", enum: [...SPARKPLUG_MESSAGE_TYPES] },
            deviceId: { type: "string" },
          },
          required: ["messageType"],
          additionalProperties: false,
        },
      },
      {
        name: "encode_payload",
        description:
          "Encode metrics as official Sparkplug B protobuf Payload (scalars, DataSet, Template, PropertySet). json-compat if encoding=json-compat.",
        inputSchema: {
          type: "object",
          properties: {
            metrics: { type: "array" },
            seq: { type: "integer" },
            timestamp: { type: "integer" },
            uuid: { type: "string" },
            encoding: { type: "string", enum: ["protobuf", "json-compat"] },
          },
          additionalProperties: false,
        },
      },
      {
        name: "decode_payload",
        description: "Decode a Sparkplug B protobuf Payload (base64/hex/bytes) or json-compat JSON",
        inputSchema: {
          type: "object",
          properties: {
            payload: { description: "base64, hex, JSON string, or {metrics}" },
            encoding: { type: "string", enum: ["protobuf", "json-compat", "auto"] },
          },
          required: ["payload"],
          additionalProperties: false,
        },
      },
      {
        name: "parse_message",
        description: "Parse spBv1.0 topic + payload into messageType (NBIRTH/NDATA/…) and decoded metrics",
        inputSchema: {
          type: "object",
          properties: {
            topic: { type: "string" },
            payload: {},
          },
          required: ["topic", "payload"],
          additionalProperties: false,
        },
      },
      {
        name: "publish",
        description: "Publish protobuf (default) metrics on a Sparkplug topic (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: {
            messageType: { type: "string", enum: [...SPARKPLUG_MESSAGE_TYPES] },
            payload: {},
            deviceId: { type: "string" },
          },
          required: ["messageType"],
          additionalProperties: false,
        },
      },
      {
        name: "nbirth",
        description: "Publish NBIRTH protobuf with bdSeq (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: {
            metrics: { type: "array" },
            uuid: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "ndeath",
        description: "Publish NDEATH protobuf (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      {
        name: "session_status",
        description: "Online flag, bdSeq, encoding, and last NBIRTH topic",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "subscribe_once",
        description: "Subscribe to a Sparkplug topic and wait for one message (decoded)",
        inputSchema: {
          type: "object",
          properties: {
            messageType: { type: "string" },
            topic: { type: "string" },
            timeoutMs: { type: "integer", default: 5000 },
          },
          additionalProperties: false,
        },
      },
      {
        name: "list_topics",
        description: "Show configured Sparkplug identity and example topics",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "host_state",
        description:
          "Read Host STATE (spBv1.0/STATE/{hostId}). If this adapter published STATE, return that snapshot; otherwise one-shot subscribe (observer).",
        inputSchema: {
          type: "object",
          properties: {
            hostId: { type: "string" },
            timeoutMs: { type: "integer", default: 5000 },
          },
          additionalProperties: false,
        },
      },
      {
        name: "host_online",
        description: "Publish retained Host STATE {online:true} (requires allowWrite=true). Host Application MVP.",
        inputSchema: {
          type: "object",
          properties: { hostId: { type: "string" } },
          additionalProperties: false,
        },
      },
      {
        name: "host_offline",
        description: "Publish retained Host STATE {online:false} (requires allowWrite=true).",
        inputSchema: {
          type: "object",
          properties: { hostId: { type: "string" } },
          additionalProperties: false,
        },
      },
      {
        name: "rebirth",
        description:
          "Publish NCMD Node Control/Rebirth=true to spBv1.0/{group}/NCMD/{edge} (requires allowWrite=true). Not a full command set.",
        inputSchema: {
          type: "object",
          properties: {
            groupId: { type: "string" },
            edgeNode: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const client = this.client!;
    if (toolName === "list_topics") {
      return {
        namespace: SPARKPLUG_NAMESPACE,
        groupId: this.groupId,
        edgeNode: this.edgeNode,
        deviceId: this.deviceId,
        encoding: this.encoding,
        proto: SPARKPLUG_PROTO_SOURCE,
        hostId: this.hostId || undefined,
        hostStateTopic: this.hostId ? formatHostStateTopic(this.hostId) : `${SPARKPLUG_NAMESPACE}/STATE/{hostId}`,
        examples: SPARKPLUG_MESSAGE_TYPES.filter((t) => t !== "STATE").map((t) => this.topic(t)),
      };
    }
    if (toolName === "session_status") {
      return {
        online: this.online,
        bdSeq: this.bdSeq,
        seq: this.seq,
        groupId: this.groupId,
        edgeNode: this.edgeNode,
        lastBirthTopic: this.lastBirthTopic,
        encoding: this.encoding,
        proto: SPARKPLUG_PROTO_SOURCE,
      };
    }
    if (toolName === "encode_topic") {
      const messageType = requiredString(args, "messageType");
      const deviceId = typeof args.deviceId === "string" ? args.deviceId : this.deviceId;
      return { topic: this.topic(messageType, deviceId) };
    }
    if (toolName === "encode_payload") {
      const encoding: SparkplugEncoding = args.encoding === "json-compat" ? "json-compat" : this.encoding;
      const view = normalizeView(args, this.seq);
      const bytes = serializePayload(view, encoding);
      return {
        encoding,
        bytes: bytes.length,
        base64: bytes.toString("base64"),
        hex: bytes.toString("hex"),
        payload: encoding === "protobuf" ? decodeAnyPayload(bytes) : viewToJsonCompat(view),
      };
    }
    if (toolName === "decode_payload") {
      const view = decodeArg(args.payload);
      return view;
    }
    if (toolName === "parse_message") {
      const topic = requiredString(args, "topic");
      const parsed = parseSparkplugTopic(topic);
      if (parsed?.kind === "state" && parsed.hostId) {
        const raw =
          typeof args.payload === "string" || Buffer.isBuffer(args.payload)
            ? args.payload
            : args.payload && typeof args.payload === "object" && "raw" in (args.payload as object)
              ? String((args.payload as { raw?: unknown }).raw ?? "")
              : JSON.stringify(args.payload ?? {});
        return {
          topic,
          parsed,
          messageType: "STATE",
          kind: "state",
          hostState: decodeHostState(typeof raw === "string" || Buffer.isBuffer(raw) ? raw : JSON.stringify(raw)),
        };
      }
      const view = decodeArg(args.payload);
      return {
        topic,
        parsed,
        messageType: parsed?.messageType,
        kind: parsed?.kind,
        payload: view,
      };
    }
    if (toolName === "nbirth") {
      assertCanWrite("sparkplug", this.allowWrite);
      this.bdSeq += 1;
      this.seq = 0;
      this.online = true;
      const extra = Array.isArray(args.metrics) ? (args.metrics as SparkplugMetric[]) : [];
      const timestamp = Date.now();
      const view = buildView({
        seq: this.seq,
        uuid: typeof args.uuid === "string" ? args.uuid : undefined,
        timestamp,
        metrics: [bdSeqMetric(this.bdSeq, timestamp), ...extra],
      });
      const topic = this.topic("NBIRTH");
      this.lastBirthTopic = topic;
      const bytes = serializePayload(view, this.encoding);
      await client.publishAsync(topic, bytes);
      return {
        ok: true,
        topic,
        online: true,
        encoding: this.encoding,
        payload: this.encoding === "protobuf" ? decodeAnyPayload(bytes) : viewToJsonCompat(view),
        base64: bytes.toString("base64"),
      };
    }
    if (toolName === "ndeath") {
      assertCanWrite("sparkplug", this.allowWrite);
      const timestamp = Date.now();
      const view = buildView({ seq: 0, timestamp, metrics: [bdSeqMetric(this.bdSeq, timestamp)] });
      const topic = this.topic("NDEATH");
      const bytes = serializePayload(view, this.encoding);
      await client.publishAsync(topic, bytes);
      this.online = false;
      this.seq = 0;
      return {
        ok: true,
        topic,
        online: false,
        encoding: this.encoding,
        payload: this.encoding === "protobuf" ? decodeAnyPayload(bytes) : viewToJsonCompat(view),
      };
    }
    if (toolName === "publish") {
      assertCanWrite("sparkplug", this.allowWrite);
      const messageType = requiredString(args, "messageType");
      if (!isSparkplugMessageType(messageType) && messageType !== "STATE") {
        /* still allow custom type in topic */
      }
      const deviceId = typeof args.deviceId === "string" ? args.deviceId : this.deviceId;
      const topic = this.topic(messageType, deviceId);
      if (messageType === "NDATA" || messageType === "DDATA") this.seq += 1;
      const view = normalizeView(args.payload ?? args, this.seq);
      const bytes = serializePayload(view, this.encoding);
      await client.publishAsync(topic, bytes);
      return {
        ok: true,
        topic,
        messageType,
        bytes: bytes.length,
        encoding: this.encoding,
        payload: this.encoding === "protobuf" ? decodeAnyPayload(bytes) : viewToJsonCompat(view),
      };
    }
    if (toolName === "subscribe_once") {
      const topic =
        (typeof args.topic === "string" && args.topic) ||
        (typeof args.messageType === "string"
          ? this.topic(args.messageType)
          : `${SPARKPLUG_NAMESPACE}/${this.groupId}/#`);
      const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : 5000;
      await client.subscribeAsync(topic);
      try {
        const raw = await waitFor(client, topic, timeoutMs);
        const parsed = parseSparkplugTopic(raw.topic);
        let decoded: SparkplugPayloadView | { raw: string };
        try {
          decoded = decodeAnyPayload(raw.payload);
        } catch {
          decoded = { raw: raw.payload.toString("utf8") };
        }
        return {
          topic: raw.topic,
          parsed,
          messageType: parsed?.messageType,
          kind: parsed?.kind,
          payload: decoded,
        };
      } finally {
        await client.unsubscribeAsync(topic);
      }
    }
    if (toolName === "host_online" || toolName === "host_offline") {
      assertCanWrite("sparkplug", this.allowWrite);
      const hostId = (typeof args.hostId === "string" && args.hostId.trim()) || this.hostId;
      if (!hostId) {
        throw new AdapterError(
          "E_INVALID_ARGUMENT",
          `${toolName} needs config.hostId or args.hostId`,
          { protocol: "sparkplug" },
        );
      }
      const online = toolName === "host_online";
      const timestamp = Date.now();
      const topic = formatHostStateTopic(hostId);
      const payload = encodeHostState(online, timestamp);
      await client.publishAsync(topic, payload, { qos: 1, retain: true });
      this.hostId = hostId;
      this.hostPublished = { hostId, online, timestamp, topic };
      return {
        ok: true,
        role: "host",
        retained: true,
        topic,
        hostId,
        online,
        timestamp,
        note: "Host Application MVP: retained STATE only. rebirth is a separate NCMD tool.",
      };
    }
    if (toolName === "rebirth") {
      assertCanWrite("sparkplug", this.allowWrite);
      const groupId = (typeof args.groupId === "string" && args.groupId.trim()) || this.groupId;
      const edgeNode = (typeof args.edgeNode === "string" && args.edgeNode.trim()) || this.edgeNode;
      const topic = formatRebirthTopic(groupId, edgeNode);
      const timestamp = Date.now();
      const view = buildView({
        seq: 0,
        timestamp,
        metrics: [{ name: "Node Control/Rebirth", timestamp, dataType: "Boolean", value: true }],
      });
      const bytes = serializePayload(view, this.encoding);
      await client.publishAsync(topic, bytes, { qos: 1, retain: false });
      return {
        ok: true,
        topic,
        groupId,
        edgeNode,
        metric: "Node Control/Rebirth",
        encoding: this.encoding,
        note: "Host Application MVP rebirth NCMD. Not a full command catalogue.",
      };
    }
    if (toolName === "host_state") {
      const hostId =
        (typeof args.hostId === "string" && args.hostId.trim()) || this.hostId;
      if (!hostId) {
        throw new AdapterError(
          "E_INVALID_ARGUMENT",
          "host_state needs config.hostId or args.hostId (Sparkplug Host Application id)",
          { protocol: "sparkplug" },
        );
      }
      if (this.hostPublished && this.hostPublished.hostId === hostId) {
        return {
          topic: this.hostPublished.topic,
          hostId,
          online: this.hostPublished.online,
          timestamp: this.hostPublished.timestamp,
          role: "host",
          stub: false,
          retained: true,
        };
      }
      const topic = formatHostStateTopic(hostId);
      const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : 5000;
      await client.subscribeAsync(topic);
      try {
        const raw = await waitFor(client, topic, timeoutMs);
        const state = decodeHostState(raw.payload);
        return {
          topic: raw.topic,
          hostId,
          online: state.online,
          timestamp: state.timestamp,
          role: "observer",
          stub: true,
          note: "Observer one-shot subscribe. Use host_online/host_offline (allowWrite) to publish retained STATE.",
        };
      } finally {
        await client.unsubscribeAsync(topic);
      }
    }
    throw new Error(`Unknown Sparkplug tool "${toolName}"`);
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected || !this.client) return { ok: false, detail: "not connected" };
    return {
      ok: this.client.connected,
      detail: `group=${this.groupId} node=${this.edgeNode} hostId=${this.hostId || "-"} online=${this.online} encoding=${this.encoding} allowWrite=${this.allowWrite} host=${this.hostPublished ? (this.hostPublished.online ? "online" : "offline") : "observer"}`,
    };
  }

  topic(messageType: string, deviceId?: string): string {
    return formatSparkplugTopic({
      groupId: this.groupId,
      messageType,
      edgeNode: this.edgeNode,
      deviceId: deviceId ?? this.deviceId,
    });
  }

  private assertConnected(): void {
    if (!this.connected || !this.client) throw new Error("Sparkplug adapter is not connected");
  }
}

function normalizeView(raw: unknown, seq: number): SparkplugPayloadView {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const rec = raw as Record<string, unknown>;
    if (Array.isArray(rec.metrics)) {
      return buildView({
        seq: typeof rec.seq === "number" ? rec.seq : seq,
        metrics: rec.metrics as SparkplugMetric[],
        uuid: typeof rec.uuid === "string" ? rec.uuid : undefined,
        timestamp: typeof rec.timestamp === "number" ? rec.timestamp : undefined,
      });
    }
  }
  return buildView({
    seq,
    metrics: [{ name: "payload", value: raw ?? null, dataType: "String" }],
  });
}

function decodeArg(raw: unknown): SparkplugPayloadView {
  if (Buffer.isBuffer(raw)) return decodeAnyPayload(raw);
  if (typeof raw === "string") return decodeAnyPayload(raw);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const rec = raw as Record<string, unknown>;
    if (typeof rec.base64 === "string") return decodeAnyPayload(Buffer.from(rec.base64, "base64"));
    if (typeof rec.hex === "string") return decodeAnyPayload(Buffer.from(rec.hex, "hex"));
    if (Array.isArray(rec.metrics) || rec.encoding === "json-compat") {
      return decodeAnyPayload(JSON.stringify(rec));
    }
  }
  throw new Error("decode_payload requires payload as base64, hex, JSON, or {metrics}");
}

function waitFor(
  client: MqttBrokerClient,
  topic: string,
  timeoutMs: number,
): Promise<{ topic: string; payload: Buffer }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off("message", onMessage);
      reject(new Error(`Timed out waiting for Sparkplug message on ${topic}`));
    }, timeoutMs);
    const onMessage = (incoming: string, payload: Buffer) => {
      if (incoming !== topic && !topicMatches(topic, incoming)) return;
      clearTimeout(timer);
      client.off("message", onMessage);
      resolve({ topic: incoming, payload });
    };
    client.on("message", onMessage);
  });
}
