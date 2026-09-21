export interface PulsarMessage {
  messageId: string;
  payload: string;
  topic: string;
  publishTime: number;
  batchSize?: number;
  batchIndex?: number;
}

export interface PulsarPartitionResult {
  topic: string;
  response: "Success" | "Failed";
  partitions: number;
  error?: string;
  message?: string;
  note: string;
}

export type PulsarLookupKind = "Connect" | "Redirect" | "Failed";

/** Official LOOKUP_RESPONSE surface. Redirect is followed; owner hop is reused for that topic. */
export interface PulsarLookupResult {
  topic: string;
  response: PulsarLookupKind;
  brokerServiceUrl?: string;
  brokerServiceUrlTls?: string;
  authoritative?: boolean;
  followed: boolean;
  hops?: number;
  error?: string;
  message?: string;
  note: string;
}

import { AdapterError } from "../../runtime/errors.js";

export interface PulsarPublishOpts {
  key?: string;
  batch?: string[];
  /** Official outbound chunk parts (2–8). Implicit chunk:true uses splitPulsarPayload. */
  chunks?: string[];
}

export interface PulsarPublishResult {
  messageId: string;
  topic: string;
  partition?: number;
  batchSize?: number;
  chunks?: number;
}

export interface PulsarHandle {
  publish(topic: string, payload: string, opts?: PulsarPublishOpts): Promise<PulsarPublishResult>;
  consumeOnce(topic: string, subscription: string, timeoutMs: number): Promise<PulsarMessage>;
  listTopics(): Promise<string[]>;
  listNamespaces(): Promise<string[]>;
  lookup?(topic: string): Promise<PulsarLookupResult>;
  partitionedMetadata?(topic: string): Promise<PulsarPartitionResult>;
  close(): Promise<void>;
}

export const PULSAR_LOOKUP_NOTE =
  "LOOKUP follows Redirect up to maxLookupRedirects (default 3). After a followed Connect, publish/consume for that topic use the owner hop. Other topics stay on the original session. token/JWT is sent on CONNECT when configured.";

export const PULSAR_PARTITION_NOTE =
  "PARTITIONED_METADATA (type 37/38) reports partition count. Official produce routes to persistent://t/ns/name-partition-i (hash key, else round-robin) when count>0. Topics already named *-partition-N are not re-routed. consume_once on a parent fans in those partitions (FLOW each; first MESSAGE wins). Inbound batch expands one record at a time; inbound/outbound chunk uses uuid (max 8). Official publish may send a batch frame, chunks[], or chunk:true (UTF-8 split at chunkSize, default 256). A payload that fits in one part is sent unchunked. >8 parts or a codepoint larger than chunkSize fails. Memory / unsigned HTTP / e2p1 do not route, batch, or chunk.";

export const PULSAR_MAX_CHUNKS = 8;
export const PULSAR_DEFAULT_CHUNK_SIZE = 256;
export const PULSAR_MIN_CHUNK_SIZE = 1;
export const PULSAR_MAX_CHUNK_SIZE = 1024 * 1024;

export function parsePulsarChunkSize(value: unknown, fallback = PULSAR_DEFAULT_CHUNK_SIZE): number {
  if (value == null || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new AdapterError(
      "E_INVALID_ARGUMENT",
      `Pulsar chunkSize must be a number (${PULSAR_MIN_CHUNK_SIZE}–${PULSAR_MAX_CHUNK_SIZE})`,
      { protocol: "pulsar" },
    );
  }
  const size = Math.floor(n);
  if (size < PULSAR_MIN_CHUNK_SIZE || size > PULSAR_MAX_CHUNK_SIZE) {
    throw new AdapterError(
      "E_INVALID_ARGUMENT",
      `Pulsar chunkSize ${size} is out of range ${PULSAR_MIN_CHUNK_SIZE}–${PULSAR_MAX_CHUNK_SIZE}`,
      { protocol: "pulsar" },
    );
  }
  return size;
}

/**
 * Split a payload into UTF-8 pieces of at most `chunkSize` bytes, never tearing a
 * codepoint. Empty → `[""]`. Fits in one part → `[payload]` (caller sends unchunked).
 */
export function splitPulsarPayload(payload: string, chunkSize = PULSAR_DEFAULT_CHUNK_SIZE): string[] {
  const size = parsePulsarChunkSize(chunkSize);
  const buf = Buffer.from(payload, "utf8");
  if (buf.length === 0) return [""];
  if (buf.length <= size) return [payload];
  const parts: string[] = [];
  let o = 0;
  while (o < buf.length) {
    let end = Math.min(o + size, buf.length);
    if (end < buf.length) {
      while (end > o && (buf[end]! & 0xc0) === 0x80) end -= 1;
      if (end === o) {
        throw new AdapterError(
          "E_INVALID_ARGUMENT",
          `Pulsar chunkSize ${size} is smaller than one UTF-8 codepoint at offset ${o}`,
          { protocol: "pulsar" },
        );
      }
    }
    parts.push(buf.subarray(o, end).toString("utf8"));
    o = end;
  }
  return parts;
}

/** Apache partitioned-topic leaf: name-partition-{i}. */
export function isPulsarPartitionTopic(topic: string): boolean {
  return /-partition-\d+$/.test(parsePulsarTopic(topic).name);
}

/** Strip a trailing -partition-N so metadata/routing key off the parent. */
export function pulsarParentTopic(topic: string, tenant = "public", namespace = "default"): string {
  const parts = parsePulsarTopic(topic, tenant, namespace);
  const name = parts.name.replace(/-partition-\d+$/, "");
  return `persistent://${parts.tenant}/${parts.namespace}/${name}`;
}

export function pulsarPartitionTopic(topic: string, index: number, tenant = "public", namespace = "default"): string {
  const parent = parsePulsarTopic(pulsarParentTopic(topic, tenant, namespace));
  return `persistent://${parent.tenant}/${parent.namespace}/${parent.name}-partition-${index}`;
}

export function pulsarPartitionIndex(topic: string): number | undefined {
  const m = parsePulsarTopic(topic).name.match(/-partition-(\d+)$/);
  if (!m) return undefined;
  return Number(m[1]);
}

/** Stable FNV-1a (32-bit) so the same key always lands on the same partition. */
export function hashPartition(key: string, n: number): number {
  if (n <= 0) return 0;
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % n;
}

export function parsePulsarTopic(
  topic: string,
  tenant = "public",
  namespace = "default",
): { tenant: string; namespace: string; name: string; full: string } {
  const m = topic.match(/^(persistent|non-persistent):\/\/([^/]+)\/([^/]+)\/(.+)$/i);
  if (m) {
    return { tenant: m[2]!, namespace: m[3]!, name: m[4]!, full: topic };
  }
  const name = topic.replace(/^\/+/, "") || "events";
  return { tenant, namespace, name, full: `persistent://${tenant}/${namespace}/${name}` };
}
