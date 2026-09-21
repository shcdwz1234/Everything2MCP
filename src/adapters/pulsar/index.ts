import { AdapterError } from "../../runtime/errors.js";
import { fetchSafe } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";
import { payloadToString, stringField, timeoutMs } from "../helpers.js";
import { connectBinaryPulsar, isPulsarBinaryUrl } from "./binary.js";
import { connectOfficialPulsar } from "./official.js";
import {
  parsePulsarChunkSize,
  parsePulsarTopic,
  PULSAR_DEFAULT_CHUNK_SIZE,
  PULSAR_MAX_CHUNKS,
  splitPulsarPayload,
  type PulsarHandle,
  type PulsarMessage,
} from "./topic.js";
export type {
  PulsarLookupResult,
  PulsarLookupKind,
  PulsarPartitionResult,
  PulsarPublishOpts,
  PulsarPublishResult,
} from "./topic.js";
export {
  PULSAR_LOOKUP_NOTE,
  PULSAR_PARTITION_NOTE,
  PULSAR_MAX_CHUNKS,
  PULSAR_DEFAULT_CHUNK_SIZE,
  PULSAR_MIN_CHUNK_SIZE,
  PULSAR_MAX_CHUNK_SIZE,
  hashPartition,
  parsePulsarChunkSize,
  splitPulsarPayload,
  isPulsarPartitionTopic,
  pulsarParentTopic,
  pulsarPartitionIndex,
  pulsarPartitionTopic,
} from "./topic.js";

export type { PulsarHandle, PulsarMessage };
export { parsePulsarTopic };
export { connectBinaryPulsar, listenFakePulsarBroker, encodePulsarFrame, tryDecodePulsarFrames } from "./binary.js";
export {
  connectOfficialPulsar,
  listenFakeOfficialPulsarBroker,
  encodeOfficialCommandFrame,
  encodeOfficialPayloadFrame,
  tryDecodeOfficialFrames,
  encodeBatchPayload,
  decodeBatchPayload,
  PULSAR_API_SOURCE,
  PULSAR_PAYLOAD_MAGIC,
} from "./official.js";
export { crc32c, CRC32C_CHECK } from "./crc32c.js";

export type PulsarConnectFn = (config: Record<string, unknown>) => Promise<PulsarHandle>;

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createMemoryPulsar(
  defaultTopic: string,
  tenant = "public",
  namespace = "default",
): PulsarHandle {
  const parsedDefault = parsePulsarTopic(defaultTopic, tenant, namespace);
  const topics = new Map<string, PulsarMessage[]>();
  const cursors = new Map<string, number>();
  const waiters = new Map<string, Array<(msg: PulsarMessage) => void>>();
  const namespaces = new Set<string>([`${parsedDefault.tenant}/${parsedDefault.namespace}`]);

  const ensure = (full: string, parts: ReturnType<typeof parsePulsarTopic>) => {
    if (!topics.has(full)) topics.set(full, []);
    namespaces.add(`${parts.tenant}/${parts.namespace}`);
  };
  ensure(parsedDefault.full, parsedDefault);

  return {
    async publish(topic, payload) {
      const parts = parsePulsarTopic(topic, tenant, namespace);
      ensure(parts.full, parts);
      const msg: PulsarMessage = {
        messageId: newId("msg"),
        payload,
        topic: parts.full,
        publishTime: Date.now(),
      };
      topics.get(parts.full)!.push(msg);
      const waiter = waiters.get(parts.full)?.shift();
      if (waiter) waiter(msg);
      return { messageId: msg.messageId, topic: parts.full };
    },
    consumeOnce(topic, subscription, ms) {
      const parts = parsePulsarTopic(topic, tenant, namespace);
      ensure(parts.full, parts);
      const key = `${parts.full}::${subscription}`;
      const log = topics.get(parts.full)!;
      const offset = cursors.get(key) ?? 0;
      if (offset < log.length) {
        const msg = log[offset]!;
        cursors.set(key, offset + 1);
        return Promise.resolve(msg);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new AdapterError("E_TIMEOUT", `Timed out waiting for Pulsar message on ${parts.full}`, {
                protocol: "pulsar",
              }),
            ),
          ms,
        );
        const list = waiters.get(parts.full) ?? [];
        list.push((msg) => {
          clearTimeout(timer);
          const next = cursors.get(key) ?? 0;
          cursors.set(key, next + 1);
          resolve(msg);
        });
        waiters.set(parts.full, list);
      });
    },
    async listTopics() {
      return [...topics.keys()].sort();
    },
    async listNamespaces() {
      return [...namespaces].sort();
    },
    async close() {
      topics.clear();
      cursors.clear();
      waiters.clear();
      namespaces.clear();
    },
  };
}

function join(endpoint: string, ...parts: string[]): string {
  const base = endpoint.replace(/\/+$/, "");
  const path = parts.map((p) => encodeURIComponent(p)).join("/");
  return path ? `${base}/${path}` : base;
}

/** Unsigned JSON HTTP mock (not the Pulsar binary protocol, not official admin REST). */
export function unsignedHttpPulsar(endpoint: string, timeoutMs = 8000): PulsarHandle {
  return {
    async publish(topic, payload) {
      const res = await fetchSafe(join(endpoint, "topics", topic, "messages"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload }),
        timeoutMs,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new AdapterError("E_PROTOCOL", `Pulsar publish HTTP ${res.status}: ${text.slice(0, 200)}`, {
          protocol: "pulsar",
        });
      }
      const json = JSON.parse(text) as { messageId?: string; topic?: string };
      return { messageId: json.messageId ?? "unknown", topic: json.topic ?? topic };
    },
    async consumeOnce(topic, subscription, ms) {
      const url = new URL(join(endpoint, "topics", topic, "messages"));
      url.searchParams.set("subscription", subscription);
      const res = await fetchSafe(url.toString(), { method: "GET", timeoutMs: ms });
      const text = await res.text();
      if (res.status === 404 || res.status === 204) {
        throw new AdapterError("E_TIMEOUT", `Timed out waiting for Pulsar message on ${topic}`, { protocol: "pulsar" });
      }
      if (!res.ok) {
        throw new AdapterError("E_PROTOCOL", `Pulsar consume HTTP ${res.status}: ${text.slice(0, 200)}`, {
          protocol: "pulsar",
        });
      }
      return JSON.parse(text) as PulsarMessage;
    },
    async listTopics() {
      const res = await fetchSafe(join(endpoint, "topics"), { method: "GET", timeoutMs });
      const text = await res.text();
      if (!res.ok) {
        throw new AdapterError("E_PROTOCOL", `Pulsar list topics HTTP ${res.status}: ${text.slice(0, 200)}`, {
          protocol: "pulsar",
        });
      }
      const json = JSON.parse(text) as { topics?: string[] };
      return json.topics ?? [];
    },
    async listNamespaces() {
      const res = await fetchSafe(join(endpoint, "namespaces"), { method: "GET", timeoutMs });
      const text = await res.text();
      if (!res.ok) {
        throw new AdapterError("E_PROTOCOL", `Pulsar list namespaces HTTP ${res.status}: ${text.slice(0, 200)}`, {
          protocol: "pulsar",
        });
      }
      const json = JSON.parse(text) as { namespaces?: string[] };
      return json.namespaces ?? [];
    },
    async close() {
      /* http client is stateless */
    },
  };
}

async function defaultConnect(config: Record<string, unknown>): Promise<PulsarHandle> {
  const topic = stringField(config, "topic") ?? stringField(config, "defaultTopic");
  if (!topic) throw new AdapterError("E_INVALID_CONFIG", "Pulsar adapter requires config.topic");
  const tenant = stringField(config, "tenant") ?? "public";
  const namespace = stringField(config, "namespace") ?? "default";
  const endpoint =
    stringField(config, "serviceUrl") ??
    stringField(config, "url") ??
    stringField(config, "adminUrl") ??
    stringField(config, "endpoint");
  const simulator =
    config.simulator !== false && (!endpoint || endpoint === "memory://" || endpoint.startsWith("memory:"));
  if (simulator) return createMemoryPulsar(topic, tenant, namespace);
  if ((config.unsigned === true || config.admin === true) && endpoint && /^https?:\/\//i.test(endpoint)) {
    const ms = typeof config.timeoutMs === "number" && config.timeoutMs > 0 ? config.timeoutMs : 8000;
    return unsignedHttpPulsar(endpoint, ms);
  }
  if (isPulsarBinaryUrl(endpoint)) {
    const dialect = (stringField(config, "dialect") ?? "").toLowerCase();
    if (dialect === "e2p1" || dialect === "e2mcp-pulsar") {
      return connectBinaryPulsar(config);
    }
    return connectOfficialPulsar(config);
  }
  throw new AdapterError(
    "E_UNSUPPORTED",
    "Pulsar needs memory://, unsigned JSON HTTP (config.unsigned=true + http endpoint), pulsar:// (official PulsarApi), or pulsar:// + dialect=e2p1.",
    { protocol: "pulsar" },
  );
}

function pulsarDialect(config: Record<string, unknown>): "e2p1" | "official" {
  const dialect = (stringField(config, "dialect") ?? "").toLowerCase();
  return dialect === "e2p1" || dialect === "e2mcp-pulsar" ? "e2p1" : "official";
}

/**
 * Apache Pulsar-like topics: in-memory (CI), unsigned JSON HTTP mock,
 * official PulsarApi on pulsar:// (and pulsar+ssl://), or e2mcp-pulsar (dialect=e2p1).
 * publish requires allowWrite=true.
 */
export class PulsarAdapter implements ProtocolAdapter {
  readonly protocol = "pulsar";
  private handle: PulsarHandle | undefined;
  private connected = false;
  private topic = "";
  private tenant = "public";
  private namespace = "default";
  private subscription = "everything2mcp";
  private allowWrite = false;
  private chunkSize = PULSAR_DEFAULT_CHUNK_SIZE;
  private mode: "memory" | "unsigned-http" | "binary" | "official" | "injected" = "memory";

  constructor(
    readonly id: string,
    private readonly connectFn: PulsarConnectFn = defaultConnect,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    const topic = stringField(config, "topic") ?? stringField(config, "defaultTopic");
    if (!topic) throw new AdapterError("E_INVALID_CONFIG", "Pulsar adapter requires config.topic");
    this.topic = parsePulsarTopic(
      topic,
      stringField(config, "tenant") ?? "public",
      stringField(config, "namespace") ?? "default",
    ).full;
    this.tenant = stringField(config, "tenant") ?? "public";
    this.namespace = stringField(config, "namespace") ?? "default";
    this.subscription = stringField(config, "subscription") ?? "everything2mcp";
    this.allowWrite = allowWriteFrom(config);
    this.chunkSize = parsePulsarChunkSize(config.chunkSize, PULSAR_DEFAULT_CHUNK_SIZE);
    const endpoint =
      stringField(config, "serviceUrl") ??
      stringField(config, "url") ??
      stringField(config, "adminUrl") ??
      stringField(config, "endpoint");
    this.mode =
      this.connectFn !== defaultConnect
        ? "injected"
        : (config.unsigned === true || config.admin === true) && endpoint && /^https?:\/\//i.test(endpoint)
          ? "unsigned-http"
          : isPulsarBinaryUrl(endpoint)
            ? pulsarDialect(config) === "e2p1"
              ? "binary"
              : "official"
            : "memory";
    this.handle = await this.connectFn(config);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.handle) await this.handle.close();
    this.handle = undefined;
    this.connected = false;
  }

  async listTools(): Promise<McpToolSchema[]> {
    this.assertConnected();
    return [
      {
        name: "publish",
        description:
          "Publish a message to a Pulsar topic (requires allowWrite=true). Official mode routes to -partition-N from PARTITIONED_METADATA (hash key, else round-robin) and may send a batch frame, explicit chunks[], or chunk:true (UTF-8 split at chunkSize, default 256; fits-in-one stays unchunked; >8 parts → E_UNSUPPORTED).",
        inputSchema: {
          type: "object",
          properties: {
            topic: { type: "string" },
            payload: { description: "String or JSON payload" },
            key: { type: "string", description: "Partition key; official mode hashes onto -partition-N" },
            batch: {
              type: "array",
              items: { type: "string" },
              description: "Official PulsarApi batch payload (2+ strings). Memory / HTTP / e2p1 → E_UNSUPPORTED.",
            },
            chunks: {
              type: "array",
              items: { type: "string" },
              description: "Official outbound chunk parts (2–8). Overrides chunk:true.",
            },
            chunk: {
              type: "boolean",
              description: "Official implicit split of payload at chunkSize (UTF-8, default 256).",
            },
            chunkSize: {
              type: "integer",
              description: `UTF-8 bytes per implicit chunk (${PULSAR_DEFAULT_CHUNK_SIZE} default).`,
            },
          },
          required: ["payload"],
          additionalProperties: false,
        },
      },
      {
        name: "consume_once",
        description: "Wait for a single message on a topic/subscription (cursor per subscription)",
        inputSchema: {
          type: "object",
          properties: {
            topic: { type: "string" },
            subscription: { type: "string" },
            timeoutMs: { type: "integer", default: 5000 },
          },
          additionalProperties: false,
        },
      },
      {
        name: "list_topics",
        description: "List known topics (memory, unsigned HTTP, e2p1 LIST_TOPICS, or official GetTopicsOfNamespace)",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "list_namespaces",
        description: "List tenant/namespace pairs derived from topics",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "lookup",
        description:
          "Official PulsarApi LOOKUP (read-only). Follows Redirect up to maxLookupRedirects and reuses the owner hop for that topic. Memory / unsigned HTTP / e2p1 → E_UNSUPPORTED.",
        inputSchema: {
          type: "object",
          properties: { topic: { type: "string" } },
          additionalProperties: false,
        },
      },
      {
        name: "partitioned_metadata",
        description:
          "Official PulsarApi PARTITIONED_METADATA (read-only). Reports partition count; official publish/consume_once use it to route or fan-in -partition-N. Memory / unsigned HTTP / e2p1 → E_UNSUPPORTED.",
        inputSchema: {
          type: "object",
          properties: { topic: { type: "string" } },
          additionalProperties: false,
        },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const handle = this.handle!;
    if (toolName === "list_topics") {
      return { topics: await handle.listTopics() };
    }
    if (toolName === "list_namespaces") {
      return { namespaces: await handle.listNamespaces() };
    }
    if (toolName === "publish") {
      const topic =
        typeof args.topic === "string" && args.topic.trim()
          ? parsePulsarTopic(args.topic.trim(), this.tenant, this.namespace).full
          : this.topic;
      const payload = payloadToString(args.payload);
      const key = typeof args.key === "string" && args.key.trim() ? args.key.trim() : undefined;
      let chunks: string[] | undefined;
      if (args.chunks != null) {
        if (this.mode !== "official") {
          throw new AdapterError(
            "E_UNSUPPORTED",
            "Pulsar publish chunks[] is official PulsarApi only (memory / unsigned HTTP / e2p1 do not emit chunk metadata)",
            { protocol: "pulsar" },
          );
        }
        if (
          !Array.isArray(args.chunks) ||
          args.chunks.length < 2 ||
          args.chunks.length > PULSAR_MAX_CHUNKS ||
          !args.chunks.every((item) => typeof item === "string")
        ) {
          throw new AdapterError(
            "E_INVALID_ARGUMENT",
            `Pulsar publish chunks must be a string array of length 2–${PULSAR_MAX_CHUNKS}`,
            { protocol: "pulsar" },
          );
        }
        chunks = args.chunks;
      } else if (args.chunk === true || (args.chunk != null && args.chunk !== false)) {
        if (this.mode !== "official") {
          throw new AdapterError(
            "E_UNSUPPORTED",
            "Pulsar publish chunk:true is official PulsarApi only (memory / unsigned HTTP / e2p1 do not emit chunk metadata)",
            { protocol: "pulsar" },
          );
        }
        const size = parsePulsarChunkSize(args.chunkSize, this.chunkSize);
        const parts = splitPulsarPayload(payload, size);
        if (parts.length > PULSAR_MAX_CHUNKS) {
          throw new AdapterError(
            "E_UNSUPPORTED",
            `Pulsar chunk:true needs ${parts.length} frames at chunkSize=${size} (cap ${PULSAR_MAX_CHUNKS}; raise chunkSize or shrink payload)`,
            { protocol: "pulsar", details: { parts: parts.length, chunkSize: size, max: PULSAR_MAX_CHUNKS } },
          );
        }
        if (parts.length >= 2) chunks = parts;
      }
      let batch: string[] | undefined;
      if (args.batch != null) {
        if (this.mode !== "official") {
          throw new AdapterError(
            "E_UNSUPPORTED",
            "Pulsar publish batch frames are official PulsarApi only (memory / unsigned HTTP / e2p1 do not encode SingleMessageMetadata)",
            { protocol: "pulsar" },
          );
        }
        if (
          !Array.isArray(args.batch) ||
          args.batch.length < 2 ||
          !args.batch.every((item) => typeof item === "string")
        ) {
          throw new AdapterError("E_INVALID_ARGUMENT", "Pulsar publish batch must be a string array of length >= 2", {
            protocol: "pulsar",
          });
        }
        batch = args.batch;
      }
      if (batch && chunks) {
        throw new AdapterError("E_INVALID_ARGUMENT", "Pulsar publish cannot send batch and chunks on the same SEND", {
          protocol: "pulsar",
        });
      }
      assertCanWrite("pulsar", this.allowWrite);
      return handle.publish(topic, payload, { key, batch, chunks });
    }
    if (toolName === "lookup") {
      const topic =
        typeof args.topic === "string" && args.topic.trim()
          ? parsePulsarTopic(args.topic.trim(), this.tenant, this.namespace).full
          : this.topic;
      if (!handle.lookup) {
        throw new AdapterError(
          "E_UNSUPPORTED",
          "Pulsar LOOKUP is official PulsarApi only (pulsar:// / pulsar+ssl://). This handle has no LOOKUP command path (memory / unsigned HTTP / e2p1).",
          { protocol: "pulsar" },
        );
      }
      const result = await handle.lookup(topic);
      if (result.response === "Failed") {
        const errName = result.error ?? "UnknownError";
        const code = errName === "TopicNotFound" || errName === "InvalidTopicName" ? "E_NOT_FOUND" : "E_PROTOCOL";
        throw new AdapterError(code, `Pulsar LOOKUP Failed (${errName}): ${result.message ?? topic}`, {
          protocol: "pulsar",
        });
      }
      return result;
    }
    if (toolName === "partitioned_metadata") {
      const topic =
        typeof args.topic === "string" && args.topic.trim()
          ? parsePulsarTopic(args.topic.trim(), this.tenant, this.namespace).full
          : this.topic;
      if (!handle.partitionedMetadata) {
        throw new AdapterError(
          "E_UNSUPPORTED",
          "Pulsar PARTITIONED_METADATA is official PulsarApi only (pulsar:// / pulsar+ssl://).",
          { protocol: "pulsar" },
        );
      }
      const result = await handle.partitionedMetadata(topic);
      if (result.response === "Failed") {
        const errName = result.error ?? "UnknownError";
        const code = errName === "TopicNotFound" || errName === "InvalidTopicName" ? "E_NOT_FOUND" : "E_PROTOCOL";
        throw new AdapterError(code, `Pulsar PARTITIONED_METADATA Failed (${errName}): ${result.message ?? topic}`, {
          protocol: "pulsar",
        });
      }
      return result;
    }
    if (toolName === "consume_once") {
      const topic =
        typeof args.topic === "string" && args.topic.trim()
          ? parsePulsarTopic(args.topic.trim(), this.tenant, this.namespace).full
          : this.topic;
      const subscription =
        typeof args.subscription === "string" && args.subscription.trim()
          ? args.subscription.trim()
          : this.subscription;
      return handle.consumeOnce(topic, subscription, timeoutMs(args));
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown Pulsar tool "${toolName}"`, { protocol: "pulsar" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return {
      ok: true,
      detail: `topic=${this.topic} mode=${this.mode} allowWrite=${this.allowWrite} lookup=${this.mode === "official" ? "wire" : "none"} (memory / unsigned JSON / official PulsarApi LOOKUP / e2p1 dialect)`,
    };
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_NOT_CONNECTED", "Pulsar adapter is not connected", { protocol: "pulsar" });
    }
  }
}
