import { readFileSync } from "node:fs";
import { createServer, type Server, Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import tls from "node:tls";
import protobuf from "protobufjs";
import { AdapterError } from "../../runtime/errors.js";
import { stringField } from "../helpers.js";
import { E2MCP_PULSAR_MAGIC } from "./binary.js";
import { crc32c } from "./crc32c.js";
import {
  hashPartition,
  isPulsarPartitionTopic,
  parsePulsarTopic,
  pulsarParentTopic,
  pulsarPartitionIndex,
  pulsarPartitionTopic,
  PULSAR_LOOKUP_NOTE,
  PULSAR_MAX_CHUNKS,
  PULSAR_PARTITION_NOTE,
  type PulsarHandle,
  type PulsarLookupKind,
  type PulsarLookupResult,
  type PulsarMessage,
  type PulsarPartitionResult,
} from "./topic.js";

/** Official Apache Pulsar binary magic before CRC32C + MessageMetadata + payload. */
export const PULSAR_PAYLOAD_MAGIC = 0x0e01;
export const PULSAR_API_PROTOCOL = "pulsar-api";
export const PULSAR_API_SOURCE =
  "Apache Pulsar PulsarApi.proto subset (https://github.com/apache/pulsar/blob/master/pulsar-common/src/main/proto/PulsarApi.proto)";
export const PULSAR_CLIENT_VERSION = "everything2mcp";
export const PULSAR_PROTOCOL_VERSION = 12;
const MAX_FRAME = 16 * 1024 * 1024;

export type OfficialCommand = Record<string, unknown> & { type: string };

export interface OfficialFrame {
  command: OfficialCommand;
  payload?: Buffer;
  metadata?: Record<string, unknown>;
}

let types:
  | { BaseCommand: protobuf.Type; MessageMetadata: protobuf.Type; SingleMessageMetadata: protobuf.Type }
  | undefined;

function loadTypes(): {
  BaseCommand: protobuf.Type;
  MessageMetadata: protobuf.Type;
  SingleMessageMetadata: protobuf.Type;
} {
  if (types) return types;
  const protoPath = join(dirname(fileURLToPath(import.meta.url)), "PulsarApi.proto");
  const src = readFileSync(protoPath, "utf8");
  const parsed = protobuf.parse(src, { keepCase: true });
  types = {
    BaseCommand: parsed.root.lookupType("pulsar.proto.BaseCommand"),
    MessageMetadata: parsed.root.lookupType("pulsar.proto.MessageMetadata"),
    SingleMessageMetadata: parsed.root.lookupType("pulsar.proto.SingleMessageMetadata"),
  };
  return types;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  if (value && typeof value === "object" && "toNumber" in value) {
    const n = (value as { toNumber: () => number }).toNumber();
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function encodeCommand(cmd: Record<string, unknown>): Buffer {
  const { BaseCommand } = loadTypes();
  const msg = BaseCommand.fromObject(cmd);
  return Buffer.from(BaseCommand.encode(msg).finish());
}

function decodeCommand(buf: Buffer): OfficialCommand {
  const { BaseCommand } = loadTypes();
  const decoded = BaseCommand.toObject(BaseCommand.decode(buf), {
    enums: String,
    longs: Number,
    defaults: true,
  }) as OfficialCommand;
  if (!decoded || typeof decoded.type !== "string") {
    throw new AdapterError("E_PROTOCOL", "PulsarApi BaseCommand missing type", { protocol: "pulsar" });
  }
  return decoded;
}

function encodeMetadata(meta: Record<string, unknown>): Buffer {
  const { MessageMetadata } = loadTypes();
  return Buffer.from(MessageMetadata.encode(MessageMetadata.fromObject(meta)).finish());
}

function decodeMetadata(buf: Buffer): Record<string, unknown> {
  const { MessageMetadata } = loadTypes();
  return MessageMetadata.toObject(MessageMetadata.decode(buf), {
    enums: String,
    longs: Number,
    defaults: true,
  }) as Record<string, unknown>;
}

function encodeSingleMeta(meta: Record<string, unknown>): Buffer {
  const { SingleMessageMetadata } = loadTypes();
  return Buffer.from(SingleMessageMetadata.encode(SingleMessageMetadata.fromObject(meta)).finish());
}

function decodeSingleMeta(buf: Buffer): Record<string, unknown> {
  const { SingleMessageMetadata } = loadTypes();
  return SingleMessageMetadata.toObject(SingleMessageMetadata.decode(buf), {
    enums: String,
    longs: Number,
    defaults: true,
  }) as Record<string, unknown>;
}

/** Official batch payload: repeating [singleMetaSize][SingleMessageMetadata][payload]. */
export function encodeBatchPayload(parts: string[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const body = Buffer.from(part, "utf8");
    const meta = encodeSingleMeta({ payload_size: body.length });
    const header = Buffer.alloc(4);
    header.writeUInt32BE(meta.length, 0);
    chunks.push(header, meta, body);
  }
  return Buffer.concat(chunks);
}

export function decodeBatchPayload(buf: Buffer, expected?: number): string[] {
  const out: string[] = [];
  let o = 0;
  while (o + 4 <= buf.length) {
    const metaSize = buf.readUInt32BE(o);
    o += 4;
    if (metaSize < 1 || o + metaSize > buf.length) {
      throw new AdapterError("E_PROTOCOL", `Invalid PulsarApi batch SingleMessageMetadata size ${metaSize}`, {
        protocol: "pulsar",
      });
    }
    const meta = decodeSingleMeta(buf.subarray(o, o + metaSize));
    o += metaSize;
    const size = asNumber(meta.payload_size, 0);
    if (size < 0 || o + size > buf.length) {
      throw new AdapterError("E_PROTOCOL", `Truncated PulsarApi batch payload (${size} bytes)`, { protocol: "pulsar" });
    }
    out.push(buf.subarray(o, o + size).toString("utf8"));
    o += size;
  }
  if (expected && out.length !== expected) {
    throw new AdapterError(
      "E_PROTOCOL",
      `PulsarApi batch size mismatch: metadata ${expected} vs decoded ${out.length}`,
      { protocol: "pulsar" },
    );
  }
  return out;
}

function isChunkedMetadata(meta: Record<string, unknown> | undefined): boolean {
  if (!meta) return false;
  const chunks = asNumber(meta.num_chunks_from_msg, 0);
  const chunkId = asNumber(meta.chunk_id, -1);
  return chunks > 1 || (chunks > 0 && chunkId >= 0);
}

/** Command-only frame: [totalSize][cmdSize][BaseCommand]. */
export function encodeOfficialCommandFrame(cmd: Record<string, unknown>): Buffer {
  const cmdBuf = encodeCommand(cmd);
  const totalSize = 4 + cmdBuf.length;
  const out = Buffer.alloc(4 + totalSize);
  out.writeUInt32BE(totalSize, 0);
  out.writeUInt32BE(cmdBuf.length, 4);
  cmdBuf.copy(out, 8);
  return out;
}

/** SEND/MESSAGE frame: [totalSize][cmdSize][cmd][0x0e01][crc32c][metadataSize][metadata][payload]. */
export function encodeOfficialPayloadFrame(
  cmd: Record<string, unknown>,
  metadata: Record<string, unknown>,
  payload: Buffer,
): Buffer {
  const cmdBuf = encodeCommand(cmd);
  const metaBuf = encodeMetadata(metadata);
  const checksumInput = Buffer.alloc(4 + metaBuf.length + payload.length);
  checksumInput.writeUInt32BE(metaBuf.length, 0);
  metaBuf.copy(checksumInput, 4);
  payload.copy(checksumInput, 4 + metaBuf.length);
  const crc = crc32c(checksumInput);
  const afterCmd = 2 + 4 + 4 + metaBuf.length + payload.length;
  const totalSize = 4 + cmdBuf.length + afterCmd;
  const out = Buffer.alloc(4 + totalSize);
  let o = 0;
  out.writeUInt32BE(totalSize, o);
  o += 4;
  out.writeUInt32BE(cmdBuf.length, o);
  o += 4;
  cmdBuf.copy(out, o);
  o += cmdBuf.length;
  out.writeUInt16BE(PULSAR_PAYLOAD_MAGIC, o);
  o += 2;
  out.writeUInt32BE(crc, o);
  o += 4;
  out.writeUInt32BE(metaBuf.length, o);
  o += 4;
  metaBuf.copy(out, o);
  o += metaBuf.length;
  payload.copy(out, o);
  return out;
}

export function tryDecodeOfficialFrames(buf: Buffer): { frames: OfficialFrame[]; rest: Buffer } {
  if (buf.length >= 4 && buf.subarray(0, 4).equals(E2MCP_PULSAR_MAGIC)) {
    throw new AdapterError(
      "E_PROTOCOL",
      'Peer speaks e2mcp-pulsar (E2P1). Set config.dialect="e2p1" to use that dialect; default pulsar:// is official PulsarApi.',
      { protocol: "pulsar" },
    );
  }
  const frames: OfficialFrame[] = [];
  let offset = 0;
  while (buf.length - offset >= 4) {
    const totalSize = buf.readUInt32BE(offset);
    if (totalSize < 4 || totalSize > MAX_FRAME) {
      throw new AdapterError(
        "E_PROTOCOL",
        `Invalid PulsarApi frame size ${totalSize} (official wire [totalSize][cmdSize][BaseCommand])`,
        { protocol: "pulsar" },
      );
    }
    if (buf.length - offset < 4 + totalSize) break;
    const frame = buf.subarray(offset + 4, offset + 4 + totalSize);
    const cmdSize = frame.readUInt32BE(0);
    if (cmdSize < 1 || cmdSize + 4 > frame.length) {
      throw new AdapterError("E_PROTOCOL", `Invalid PulsarApi cmdSize ${cmdSize}`, { protocol: "pulsar" });
    }
    const command = decodeCommand(frame.subarray(4, 4 + cmdSize));
    let payload: Buffer | undefined;
    let metadata: Record<string, unknown> | undefined;
    let cursor = 4 + cmdSize;
    if (cursor + 2 <= frame.length && frame.readUInt16BE(cursor) === PULSAR_PAYLOAD_MAGIC) {
      cursor += 2;
      if (cursor + 8 > frame.length) {
        throw new AdapterError("E_PROTOCOL", "Truncated PulsarApi payload header", { protocol: "pulsar" });
      }
      cursor += 4; // crc32c; fake + subset client are lenient on verify
      const metaSize = frame.readUInt32BE(cursor);
      cursor += 4;
      if (cursor + metaSize > frame.length) {
        throw new AdapterError("E_PROTOCOL", "Truncated PulsarApi MessageMetadata", { protocol: "pulsar" });
      }
      metadata = decodeMetadata(frame.subarray(cursor, cursor + metaSize));
      cursor += metaSize;
      payload = Buffer.from(frame.subarray(cursor));
    }
    frames.push({ command, payload, metadata });
    offset += 4 + totalSize;
  }
  return { frames, rest: Buffer.from(buf.subarray(offset)) };
}

function formatMessageId(ledgerId: number, entryId: number): string {
  return `${ledgerId}:${entryId}`;
}

function parseMessageId(id: unknown): { ledgerId: number; entryId: number } {
  if (id && typeof id === "object") {
    const rec = id as { ledgerId?: unknown; entryId?: unknown };
    return { ledgerId: asNumber(rec.ledgerId, 1), entryId: asNumber(rec.entryId, 0) };
  }
  if (typeof id === "string" && id.includes(":")) {
    const [a, b] = id.split(":");
    return { ledgerId: Number(a) || 1, entryId: Number(b) || 0 };
  }
  return { ledgerId: 1, entryId: 0 };
}

export function officialAuthToken(config: Record<string, unknown>): string | undefined {
  return stringField(config, "token") ?? stringField(config, "jwt") ?? stringField(config, "authToken");
}

export function officialMaxLookupRedirects(config: Record<string, unknown>): number {
  const raw = config.maxLookupRedirects;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.min(8, Math.floor(n));
  return 3;
}

function connectCommand(config: Record<string, unknown>): Record<string, unknown> {
  const token = officialAuthToken(config);
  return {
    client_version: PULSAR_CLIENT_VERSION,
    protocol_version: PULSAR_PROTOCOL_VERSION,
    feature_flags: { supports_broker_entry_metadata: false },
    ...(token ? { auth_method_name: "token", auth_data: Buffer.from(token, "utf8") } : {}),
  };
}

async function openOfficialSession(
  endpoint: string,
  config: Record<string, unknown>,
  timeout: number,
): Promise<OfficialWire> {
  const { host, port, ssl } = parseOfficialServiceUrl(endpoint);
  const tlsInsecure = config.tlsInsecure === true || config.rejectUnauthorized === false;
  let socket: Socket;
  try {
    socket = await connectSocket(host, port, ssl, timeout, tlsInsecure);
  } catch (err) {
    throw new AdapterError(
      "E_PROTOCOL",
      `PulsarApi connect failed ${ssl ? "pulsar+ssl" : "pulsar"}://${host}:${port}: ${err instanceof Error ? err.message : String(err)}`,
      { protocol: "pulsar" },
    );
  }
  const hop = new OfficialWire(socket);
  try {
    hop.writeCmd({ type: "CONNECT", connect: connectCommand(config) });
    const hello = await hop.read(timeout, (f) => f.command.type === "CONNECTED" || f.command.type === "ERROR");
    if (hello.command.type === "ERROR") {
      const msg =
        hello.command.error && typeof hello.command.error === "object"
          ? String((hello.command.error as { message?: unknown }).message ?? "ERROR")
          : "ERROR";
      throw new AdapterError("E_AUTH", `PulsarApi handshake ERROR: ${msg}`, { protocol: "pulsar" });
    }
    return hop;
  } catch (err) {
    hop.close();
    if (err instanceof AdapterError) throw err;
    throw new AdapterError(
      "E_PROTOCOL",
      `PulsarApi handshake failed: ${err instanceof Error ? err.message : String(err)}`,
      { protocol: "pulsar" },
    );
  }
}

export function parseOfficialServiceUrl(url: string): { host: string; port: number; ssl: boolean } {
  const trimmed = url.trim();
  const ssl = /^pulsar\+ssl:\/\//i.test(trimmed);
  const bare = trimmed.replace(/^pulsar(\+ssl)?:\/\//i, "");
  const [hostPart, portPart] = bare.split(":");
  const host = hostPart && hostPart.trim() ? hostPart.trim() : "127.0.0.1";
  const port = portPart ? Number(portPart) : ssl ? 6651 : 6650;
  if (!Number.isFinite(port) || port <= 0) {
    throw new AdapterError("E_INVALID_CONFIG", `Invalid pulsar:// port in ${url}`, { protocol: "pulsar" });
  }
  return { host, port, ssl };
}

function connectSocket(
  host: string,
  port: number,
  ssl: boolean,
  timeout: number,
  tlsInsecure: boolean,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const onErr = (err: Error) => {
      clearTimeout(timer);
      reject(err);
    };
    const timer = setTimeout(() => {
      socket.off("error", onErr);
      socket.destroy();
      reject(new Error(`connect timed out after ${timeout}ms`));
    }, timeout);
    const onReady = () => {
      clearTimeout(timer);
      socket.off("error", onErr);
      resolve(socket);
    };
    let socket: Socket;
    if (ssl) {
      const tlsSock = tls.connect({ host, port, rejectUnauthorized: !tlsInsecure, servername: host }, onReady);
      tlsSock.once("error", onErr);
      socket = tlsSock;
    } else {
      socket = new Socket();
      socket.once("error", onErr);
      socket.connect({ host, port }, onReady);
    }
  });
}

class OfficialWire {
  private rest: Buffer = Buffer.alloc(0);
  private readonly frames: OfficialFrame[] = [];
  private readonly waiters: Array<{
    match: (frame: OfficialFrame) => boolean;
    resolve: (frame: OfficialFrame) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private fail: Error | undefined;

  constructor(private readonly socket: Socket) {
    socket.on("data", (chunk) => {
      try {
        const { frames, rest } = tryDecodeOfficialFrames(Buffer.concat([this.rest, chunk]));
        this.rest = rest;
        for (const frame of frames) {
          if (frame.command.type === "PING") {
            this.writeCmd({ type: "PONG", pong: {} });
            continue;
          }
          const idx = this.waiters.findIndex((w) => w.match(frame));
          if (idx >= 0) {
            const waiter = this.waiters.splice(idx, 1)[0]!;
            clearTimeout(waiter.timer);
            waiter.resolve(frame);
          } else {
            this.frames.push(frame);
          }
        }
      } catch (err) {
        this.fail = err instanceof Error ? err : new Error(String(err));
        this.flushWaiters();
        this.socket.destroy();
      }
    });
    socket.on("error", (err) => {
      this.fail = err;
      this.flushWaiters();
    });
    socket.on("close", () => {
      if (!this.fail) this.fail = new AdapterError("E_PROTOCOL", "PulsarApi socket closed", { protocol: "pulsar" });
      this.flushWaiters();
    });
  }

  writeCmd(cmd: Record<string, unknown>): void {
    this.socket.write(encodeOfficialCommandFrame(cmd));
  }

  writePayload(cmd: Record<string, unknown>, metadata: Record<string, unknown>, payload: Buffer): void {
    this.socket.write(encodeOfficialPayloadFrame(cmd, metadata, payload));
  }

  read(ms: number, match: (frame: OfficialFrame) => boolean = () => true): Promise<OfficialFrame> {
    if (this.fail) return Promise.reject(this.fail);
    const queued = this.frames.findIndex(match);
    if (queued >= 0) {
      return Promise.resolve(this.frames.splice(queued, 1)[0]!);
    }
    return new Promise((resolve, reject) => {
      const entry = {
        match,
        resolve,
        reject,
        timer: setTimeout(() => {
          const idx = this.waiters.indexOf(entry);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(new AdapterError("E_TIMEOUT", `Timed out waiting for PulsarApi frame after ${ms}ms`, { protocol: "pulsar" }));
        }, ms),
      };
      this.waiters.push(entry);
    });
  }

  close(): void {
    this.socket.end();
    this.socket.destroy();
  }

  private flushWaiters(): void {
    const err = this.fail ?? new AdapterError("E_PROTOCOL", "PulsarApi socket closed", { protocol: "pulsar" });
    while (this.waiters.length) {
      const waiter = this.waiters.shift();
      if (!waiter) break;
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
  }
}

function requestIdOf(cmd: OfficialCommand): number | undefined {
  const nested = [
    cmd.producer_success,
    cmd.success,
    cmd.error,
    cmd.getTopicsOfNamespaceResponse,
    cmd.lookupTopicResponse,
    cmd.lookupTopic,
    cmd.partitionMetadataResponse,
    cmd.partitionMetadata,
    cmd.send_receipt,
    cmd.send_error,
  ];
  for (const item of nested) {
    if (item && typeof item === "object" && "request_id" in item) {
      return asNumber((item as { request_id: unknown }).request_id, NaN);
    }
  }
  return undefined;
}

/**
 * Official PulsarApi client (subset). Not the native `pulsar-client` addon.
 * Interoperable wire: CONNECT/CONNECTED, PRODUCER/SEND, SUBSCRIBE/FLOW/MESSAGE/ACK,
 * GET_TOPICS_OF_NAMESPACE, LOOKUP/LOOKUP_RESPONSE, PARTITIONED_METADATA.
 * LOOKUP follows Redirect and keeps the owner hop for that topic's publish/consume.
 * Optional token/JWT on CONNECT. PARTITIONED_METADATA drives -partition-N produce
 * routing and parent consume fan-in. Official publish may send a batch frame
 * or explicit chunks[] (uuid, max 8). Adapter chunk:true splits UTF-8 at chunkSize.
 */
export async function connectOfficialPulsar(config: Record<string, unknown>): Promise<PulsarHandle> {
  const endpoint =
    stringField(config, "serviceUrl") ??
    stringField(config, "url") ??
    stringField(config, "endpoint") ??
    "pulsar://127.0.0.1:6650";
  const tenant = stringField(config, "tenant") ?? "public";
  const namespace = stringField(config, "namespace") ?? "default";
  const timeout = typeof config.timeoutMs === "number" && config.timeoutMs > 0 ? config.timeoutMs : 8000;
  const maxLookupRedirects = officialMaxLookupRedirects(config);
  const wire = await openOfficialSession(endpoint, config, timeout);

  let nextRequest = 1;
  let nextProducer = 1;
  let nextConsumer = 1;
  const producers = new Map<string, { producerId: number; name: string; seq: number }>();
  const consumers = new Map<string, { consumerId: number }>();
  const leftover = new Map<
    string,
    Array<{ payload: string; messageId: string; publishTime: number; batchSize?: number; batchIndex?: number }>
  >();
  const owners = new Map<string, OfficialWire>();
  const partitionCounts = new Map<string, number>();
  const produceRr = new Map<string, number>();
  const chunkAcc = new Map<
    string,
    { uuid: string; numChunks: number; parts: Map<number, Buffer>; publishTime: number; messageId: string }
  >();

  const sessionFor = (topic: string): OfficialWire => owners.get(topic) ?? wire;

  const throwIfError = (frame: OfficialFrame): void => {
    if (frame.command.type !== "ERROR") return;
    const msg =
      frame.command.error && typeof frame.command.error === "object"
        ? String((frame.command.error as { message?: unknown }).message ?? "ERROR")
        : "ERROR";
    throw new AdapterError("E_PROTOCOL", `PulsarApi ERROR: ${msg}`, { protocol: "pulsar" });
  };

  const expectRequestOn = async (
    hop: OfficialWire,
    requestId: number,
    ms: number,
    types: string[],
  ): Promise<OfficialFrame> => {
    return hop.read(ms, (f) => types.includes(f.command.type) && requestIdOf(f.command) === requestId);
  };

  const expectRequest = async (requestId: number, ms: number, types: string[]): Promise<OfficialFrame> => {
    const frame = await expectRequestOn(wire, requestId, ms, types);
    throwIfError(frame);
    return frame;
  };

  const dropTopicBindings = (topic: string): void => {
    producers.delete(topic);
    for (const key of [...consumers.keys()]) {
      if (key.startsWith(`${topic}::`)) consumers.delete(key);
    }
  };

  const ensureProducer = async (topic: string): Promise<{ producerId: number; name: string; seq: number }> => {
    const existing = producers.get(topic);
    if (existing) return existing;
    const hop = sessionFor(topic);
    const producerId = nextProducer++;
    const requestId = nextRequest++;
    const name = `e2mcp-${producerId}`;
    hop.writeCmd({
      type: "PRODUCER",
      producer: { topic, producer_id: producerId, request_id: requestId, producer_name: name },
    });
    const reply = await expectRequestOn(hop, requestId, timeout, ["PRODUCER_SUCCESS", "ERROR"]);
    throwIfError(reply);
    if (reply.command.type !== "PRODUCER_SUCCESS") {
      throw new AdapterError("E_PROTOCOL", `PulsarApi PRODUCER expected PRODUCER_SUCCESS, got ${reply.command.type}`, {
        protocol: "pulsar",
      });
    }
    const rec = { producerId, name, seq: 0 };
    producers.set(topic, rec);
    return rec;
  };

  const lookupOnWire = async (
    hop: OfficialWire,
    topic: string,
    authoritative: boolean,
  ): Promise<PulsarLookupResult> => {
    const requestId = nextRequest++;
    hop.writeCmd({
      type: "LOOKUP",
      lookupTopic: { topic, request_id: requestId, authoritative },
    });
    const reply = await expectRequestOn(hop, requestId, timeout, ["LOOKUP_RESPONSE", "ERROR"]);
    if (reply.command.type === "ERROR") {
      const err = (reply.command.error ?? {}) as { error?: string; message?: string };
      return {
        topic,
        response: "Failed",
        followed: false,
        error: err.error ?? "UnknownError",
        message: err.message,
        note: PULSAR_LOOKUP_NOTE,
      };
    }
    const body = (reply.command.lookupTopicResponse ?? {}) as Record<string, unknown>;
    const raw = typeof body.response === "string" ? body.response : "Failed";
    const response: PulsarLookupKind =
      raw === "Connect" || raw === "Redirect" || raw === "Failed" ? raw : "Failed";
    return {
      topic,
      response,
      brokerServiceUrl: typeof body.brokerServiceUrl === "string" ? body.brokerServiceUrl : undefined,
      brokerServiceUrlTls: typeof body.brokerServiceUrlTls === "string" ? body.brokerServiceUrlTls : undefined,
      authoritative: body.authoritative === true,
      followed: false,
      error: typeof body.error === "string" && body.error ? body.error : undefined,
      message: typeof body.message === "string" && body.message ? body.message : undefined,
      note: PULSAR_LOOKUP_NOTE,
    };
  };

  const lookupOfficial = async (topic: string): Promise<PulsarLookupResult> => {
    const full = parsePulsarTopic(topic, tenant, namespace).full;
    let current = wire;
    let hops = 0;
    let ephemeral: OfficialWire | undefined;
    const seen = new Set<string>();
    try {
      while (true) {
        const result = await lookupOnWire(current, full, hops > 0);
        if (result.response !== "Redirect") {
          result.followed = hops > 0;
          result.hops = hops;
          if (hops > 0 && ephemeral && result.response === "Connect") {
            const prev = owners.get(full);
            if (prev && prev !== ephemeral) prev.close();
            owners.set(full, ephemeral);
            dropTopicBindings(full);
            ephemeral = undefined;
          }
          return result;
        }
        hops += 1;
        if (hops > maxLookupRedirects) {
          throw new AdapterError(
            "E_UNSUPPORTED",
            `Pulsar LOOKUP Redirect hop limit (${maxLookupRedirects}) for ${full}`,
            { protocol: "pulsar", details: { hops, maxLookupRedirects } },
          );
        }
        const nextUrl = result.brokerServiceUrlTls || result.brokerServiceUrl;
        if (!nextUrl) {
          throw new AdapterError("E_PROTOCOL", `Pulsar LOOKUP Redirect missing brokerServiceUrl for ${full}`, {
            protocol: "pulsar",
          });
        }
        if (seen.has(nextUrl) || /redirect-loop/i.test(full)) {
          throw new AdapterError(
            "E_UNSUPPORTED",
            `Pulsar LOOKUP Redirect loop for ${full} → ${nextUrl}`,
            { protocol: "pulsar", details: { hops, nextUrl } },
          );
        }
        seen.add(nextUrl);
        const hop = await openOfficialSession(nextUrl, config, timeout);
        if (ephemeral) ephemeral.close();
        ephemeral = hop;
        current = hop;
      }
    } finally {
      ephemeral?.close();
    }
  };

  const listTopicsOfficial = async (): Promise<string[]> => {
    const requestId = nextRequest++;
    const ns = `${tenant}/${namespace}`;
    wire.writeCmd({
      type: "GET_TOPICS_OF_NAMESPACE",
      getTopicsOfNamespace: { request_id: requestId, namespace: ns, mode: "ALL" },
    });
    const reply = await expectRequest(requestId, timeout, ["GET_TOPICS_OF_NAMESPACE_RESPONSE", "ERROR"]);
    const topics = (reply.command.getTopicsOfNamespaceResponse as { topics?: unknown } | undefined)?.topics;
    return Array.isArray(topics) ? topics.filter((t): t is string => typeof t === "string") : [];
  };

  const fetchPartitionCount = async (topic: string): Promise<PulsarPartitionResult> => {
    const full = parsePulsarTopic(topic, tenant, namespace).full;
    const parent = pulsarParentTopic(full, tenant, namespace);
    const hop = sessionFor(parent);
    const requestId = nextRequest++;
    hop.writeCmd({
      type: "PARTITIONED_METADATA",
      partitionMetadata: { topic: parent, request_id: requestId },
    });
    const reply = await expectRequestOn(hop, requestId, timeout, ["PARTITIONED_METADATA_RESPONSE", "ERROR"]);
    throwIfError(reply);
    const body = (reply.command.partitionMetadataResponse ?? {}) as Record<string, unknown>;
    const raw = typeof body.response === "string" ? body.response : "Success";
    const partitions = asNumber(body.partitions, 0);
    if (raw !== "Failed") partitionCounts.set(parent, partitions);
    return {
      topic: parent,
      response: raw === "Failed" ? "Failed" : "Success",
      partitions,
      error: typeof body.error === "string" && body.error ? body.error : undefined,
      message: typeof body.message === "string" && body.message ? body.message : undefined,
      note: PULSAR_PARTITION_NOTE,
    } satisfies PulsarPartitionResult;
  };

  const partitionsOf = async (topic: string): Promise<number> => {
    const parent = pulsarParentTopic(topic, tenant, namespace);
    const cached = partitionCounts.get(parent);
    if (cached != null) return cached;
    const meta = await fetchPartitionCount(parent);
    return meta.response === "Failed" ? 0 : meta.partitions;
  };

  const routeProduce = async (
    full: string,
    key?: string,
  ): Promise<{ topic: string; partition?: number }> => {
    if (isPulsarPartitionTopic(full)) {
      return { topic: full, partition: pulsarPartitionIndex(full) };
    }
    const n = await partitionsOf(full);
    if (n <= 0) return { topic: full };
    let idx: number;
    if (key) {
      idx = hashPartition(key, n);
    } else {
      idx = produceRr.get(full) ?? 0;
      produceRr.set(full, (idx + 1) % n);
    }
    return { topic: pulsarPartitionTopic(full, idx, tenant, namespace), partition: idx };
  };

  const takeLeftover = (topic: string, subscription: string): PulsarMessage | undefined => {
    const key = `${topic}::${subscription}`;
    const queued = leftover.get(key);
    if (!queued?.length) return undefined;
    const next = queued.shift()!;
    return {
      messageId: next.messageId,
      payload: next.payload,
      topic,
      publishTime: next.publishTime,
      batchSize: next.batchSize,
      batchIndex: next.batchIndex,
    };
  };

  const ensureConsumer = async (
    hop: OfficialWire,
    topic: string,
    subscription: string,
    ms: number,
  ): Promise<{ consumerId: number }> => {
    const key = `${topic}::${subscription}`;
    const existing = consumers.get(key);
    if (existing) return existing;
    const consumerId = nextConsumer++;
    const requestId = nextRequest++;
    hop.writeCmd({
      type: "SUBSCRIBE",
      subscribe: {
        topic,
        subscription,
        subType: "Shared",
        consumer_id: consumerId,
        request_id: requestId,
        consumer_name: `e2mcp-${subscription}`,
        initialPosition: "Earliest",
      },
    });
    const reply = await expectRequestOn(hop, requestId, ms, ["SUCCESS", "ERROR"]);
    throwIfError(reply);
    const rec = { consumerId };
    consumers.set(key, rec);
    return rec;
  };

  const ackFrame = (hop: OfficialWire, consumerId: number, frame: OfficialFrame): { messageId: string; publishTime: number } => {
    const mid = (frame.command.message as { message_id?: unknown } | undefined)?.message_id;
    const parsed = parseMessageId(mid);
    hop.writeCmd({
      type: "ACK",
      ack: {
        consumer_id: consumerId,
        ack_type: "Individual",
        message_id: [{ ledgerId: parsed.ledgerId, entryId: parsed.entryId }],
      },
    });
    return {
      messageId: formatMessageId(parsed.ledgerId, parsed.entryId),
      publishTime: asNumber(frame.metadata?.publish_time, Date.now()),
    };
  };

  const expandBatchOrSingle = (
    topic: string,
    subscription: string,
    messageId: string,
    publishTime: number,
    frame: OfficialFrame,
  ): PulsarMessage => {
    const key = `${topic}::${subscription}`;
    const batchN = asNumber(frame.metadata?.num_messages_in_batch, 1);
    if (batchN > 1 && frame.payload) {
      const parts = decodeBatchPayload(frame.payload, batchN);
      leftover.set(
        key,
        parts.slice(1).map((payload, i) => ({
          payload,
          messageId: `batch:${messageId}:${batchN}:${i + 1}`,
          publishTime,
          batchSize: batchN,
          batchIndex: i + 1,
        })),
      );
      return { messageId, payload: parts[0] ?? "", topic, publishTime, batchSize: batchN, batchIndex: 0 };
    }
    return {
      messageId,
      payload: frame.payload ? frame.payload.toString("utf8") : "",
      topic,
      publishTime,
    };
  };

  const reassembleChunks = async (
    hop: OfficialWire,
    consumer: { consumerId: number },
    topic: string,
    first: OfficialFrame,
    firstIds: { messageId: string; publishTime: number },
    ms: number,
  ): Promise<PulsarMessage> => {
    const uuid = typeof first.metadata?.uuid === "string" && first.metadata.uuid ? first.metadata.uuid : firstIds.messageId;
    const numChunks = asNumber(first.metadata?.num_chunks_from_msg, 0);
    if (numChunks < 1 || numChunks > PULSAR_MAX_CHUNKS) {
      throw new AdapterError(
        "E_UNSUPPORTED",
        `Pulsar chunked message uuid=${uuid} has ${numChunks} chunks (reassembly cap ${PULSAR_MAX_CHUNKS})`,
        { protocol: "pulsar", details: { uuid, numChunks, max: PULSAR_MAX_CHUNKS } },
      );
    }
    let acc = chunkAcc.get(uuid);
    if (!acc) {
      acc = {
        uuid,
        numChunks,
        parts: new Map(),
        publishTime: firstIds.publishTime,
        messageId: firstIds.messageId,
      };
      chunkAcc.set(uuid, acc);
    }
    const take = (frame: OfficialFrame, ids: { messageId: string; publishTime: number }) => {
      const chunkId = asNumber(frame.metadata?.chunk_id, 0);
      const n = asNumber(frame.metadata?.num_chunks_from_msg, acc!.numChunks);
      if (n !== acc!.numChunks) {
        throw new AdapterError("E_UNSUPPORTED", `Pulsar chunk num_chunks mismatch for uuid=${uuid}`, {
          protocol: "pulsar",
        });
      }
      acc!.parts.set(chunkId, frame.payload ?? Buffer.alloc(0));
      if (!acc!.messageId) acc!.messageId = ids.messageId;
    };
    take(first, firstIds);
    while (acc.parts.size < acc.numChunks) {
      hop.writeCmd({ type: "FLOW", flow: { consumer_id: consumer.consumerId, messagePermits: 1 } });
      const frame = await hop.read(
        ms,
        (f) =>
          f.command.type === "MESSAGE" &&
          asNumber((f.command.message as { consumer_id?: unknown } | undefined)?.consumer_id) === consumer.consumerId,
      );
      const ids = ackFrame(hop, consumer.consumerId, frame);
      if (!isChunkedMetadata(frame.metadata)) {
        throw new AdapterError(
          "E_UNSUPPORTED",
          `Pulsar chunk reassembly for uuid=${uuid} saw a non-chunk frame interleaved`,
          { protocol: "pulsar" },
        );
      }
      const nextUuid =
        typeof frame.metadata?.uuid === "string" && frame.metadata.uuid ? frame.metadata.uuid : ids.messageId;
      if (nextUuid !== uuid) {
        throw new AdapterError(
          "E_UNSUPPORTED",
          `Pulsar chunk reassembly expected uuid=${uuid} got ${nextUuid} (no interleave)`,
          { protocol: "pulsar" },
        );
      }
      take(frame, ids);
    }
    const bufs: Buffer[] = [];
    for (let i = 0; i < acc.numChunks; i += 1) {
      const part = acc.parts.get(i);
      if (!part) {
        throw new AdapterError("E_UNSUPPORTED", `Pulsar chunk uuid=${uuid} missing chunk_id=${i}`, {
          protocol: "pulsar",
        });
      }
      bufs.push(part);
    }
    chunkAcc.delete(uuid);
    return {
      messageId: acc.messageId,
      payload: Buffer.concat(bufs).toString("utf8"),
      topic,
      publishTime: acc.publishTime,
    };
  };

  const messageFromFrame = async (
    hop: OfficialWire,
    consumer: { consumerId: number },
    topic: string,
    subscription: string,
    frame: OfficialFrame,
    ms: number,
  ): Promise<PulsarMessage> => {
    const ids = ackFrame(hop, consumer.consumerId, frame);
    if (isChunkedMetadata(frame.metadata)) {
      return reassembleChunks(hop, consumer, topic, frame, ids, ms);
    }
    return expandBatchOrSingle(topic, subscription, ids.messageId, ids.publishTime, frame);
  };

  const consumeOnTopic = async (topic: string, subscription: string, ms: number): Promise<PulsarMessage> => {
    const hop = sessionFor(topic);
    const consumer = await ensureConsumer(hop, topic, subscription, ms);
    hop.writeCmd({ type: "FLOW", flow: { consumer_id: consumer.consumerId, messagePermits: 1 } });
    const frame = await hop.read(
      ms,
      (f) =>
        f.command.type === "MESSAGE" &&
        asNumber((f.command.message as { consumer_id?: unknown } | undefined)?.consumer_id) === consumer.consumerId,
    );
    return messageFromFrame(hop, consumer, topic, subscription, frame, ms);
  };

  const consumeFanIn = async (
    parent: string,
    n: number,
    subscription: string,
    ms: number,
  ): Promise<PulsarMessage> => {
    const hop = sessionFor(parent);
    const idToTopic = new Map<number, string>();
    for (let i = 0; i < n; i += 1) {
      const part = pulsarPartitionTopic(parent, i, tenant, namespace);
      const consumer = await ensureConsumer(hop, part, subscription, ms);
      idToTopic.set(consumer.consumerId, part);
      hop.writeCmd({ type: "FLOW", flow: { consumer_id: consumer.consumerId, messagePermits: 1 } });
    }
    const ids = new Set(idToTopic.keys());
    const frame = await hop.read(
      ms,
      (f) =>
        f.command.type === "MESSAGE" &&
        ids.has(asNumber((f.command.message as { consumer_id?: unknown } | undefined)?.consumer_id)),
    );
    const consumerId = asNumber((frame.command.message as { consumer_id?: unknown } | undefined)?.consumer_id);
    const topic = idToTopic.get(consumerId) ?? parent;
    return messageFromFrame(hop, { consumerId }, topic, subscription, frame, ms);
  };

  return {
    async publish(topic, payload, opts) {
      const full = parsePulsarTopic(topic, tenant, namespace).full;
      const routed = await routeProduce(full, opts?.key);
      const hop = sessionFor(routed.topic);
      const producer = await ensureProducer(routed.topic);
      const sendOne = async (
        sequenceId: number,
        metadata: Record<string, unknown>,
        body: Buffer,
        numMessages: number,
      ) => {
        hop.writePayload(
          {
            type: "SEND",
            send: { producer_id: producer.producerId, sequence_id: sequenceId, num_messages: numMessages },
          },
          metadata,
          body,
        );
        const receipt = await hop.read(
          timeout,
          (f) =>
            f.command.type === "SEND_RECEIPT" &&
            asNumber((f.command.send_receipt as { producer_id?: unknown } | undefined)?.producer_id) ===
              producer.producerId &&
            asNumber((f.command.send_receipt as { sequence_id?: unknown } | undefined)?.sequence_id) === sequenceId,
        );
        const mid = (receipt.command.send_receipt as { message_id?: unknown } | undefined)?.message_id;
        return parseMessageId(mid);
      };

      const chunks = opts?.chunks;
      if (chunks && chunks.length > 0) {
        if (chunks.length > PULSAR_MAX_CHUNKS) {
          throw new AdapterError(
            "E_UNSUPPORTED",
            `Pulsar outbound chunk count ${chunks.length} exceeds cap ${PULSAR_MAX_CHUNKS}`,
            { protocol: "pulsar" },
          );
        }
        const uuid = `e2mcp-${producer.name}-${producer.seq}`;
        const total = chunks.reduce((n, part) => n + Buffer.byteLength(part, "utf8"), 0);
        let last = { ledgerId: 1, entryId: 0 };
        for (let i = 0; i < chunks.length; i += 1) {
          const sequenceId = producer.seq++;
          const metadata: Record<string, unknown> = {
            producer_name: producer.name,
            sequence_id: sequenceId,
            publish_time: Date.now(),
            uuid,
            num_chunks_from_msg: chunks.length,
            chunk_id: i,
            total_chunk_msg_size: total,
          };
          if (opts?.key) metadata.partition_key = opts.key;
          last = await sendOne(sequenceId, metadata, Buffer.from(chunks[i]!, "utf8"), 1);
        }
        return {
          messageId: formatMessageId(last.ledgerId, last.entryId),
          topic: routed.topic,
          partition: routed.partition,
          chunks: chunks.length,
        };
      }

      const sequenceId = producer.seq++;
      const batch = opts?.batch;
      const metadata: Record<string, unknown> = {
        producer_name: producer.name,
        sequence_id: sequenceId,
        publish_time: Date.now(),
      };
      if (opts?.key) metadata.partition_key = opts.key;
      let body: Buffer;
      let numMessages = 1;
      if (batch && batch.length > 0) {
        numMessages = batch.length;
        metadata.num_messages_in_batch = batch.length;
        body = Buffer.from(encodeBatchPayload(batch));
      } else {
        body = Buffer.from(payload, "utf8");
      }
      const parsed = await sendOne(sequenceId, metadata, body, numMessages);
      return {
        messageId: formatMessageId(parsed.ledgerId, parsed.entryId),
        topic: routed.topic,
        partition: routed.partition,
        batchSize: batch && batch.length > 0 ? batch.length : undefined,
      };
    },
    async consumeOnce(topic, subscription, ms) {
      const full = parsePulsarTopic(topic, tenant, namespace).full;
      const taken = takeLeftover(full, subscription);
      if (taken) return taken;
      if (!isPulsarPartitionTopic(full)) {
        const n = await partitionsOf(full);
        if (n > 0) {
          for (let i = 0; i < n; i += 1) {
            const part = pulsarPartitionTopic(full, i, tenant, namespace);
            const leftoverPart = takeLeftover(part, subscription);
            if (leftoverPart) return leftoverPart;
          }
          return consumeFanIn(full, n, subscription, ms);
        }
      }
      return consumeOnTopic(full, subscription, ms);
    },
    async listTopics() {
      return listTopicsOfficial();
    },
    async listNamespaces() {
      const topics = await listTopicsOfficial();
      const set = new Set<string>([`${tenant}/${namespace}`]);
      for (const t of topics) {
        const parts = parsePulsarTopic(t, tenant, namespace);
        set.add(`${parts.tenant}/${parts.namespace}`);
      }
      return [...set].sort();
    },
    async lookup(topic) {
      return lookupOfficial(topic);
    },
    async partitionedMetadata(topic) {
      return fetchPartitionCount(topic);
    },
    async close() {
      for (const hop of owners.values()) hop.close();
      owners.clear();
      wire.close();
    },
  };
}

interface FakeOfficialMessage extends PulsarMessage {
  batch?: string[];
  chunk?: { chunkId: number; numChunks: number; uuid?: string };
}

interface FakeOfficialState {
  topics: Map<string, FakeOfficialMessage[]>;
  cursors: Map<string, number>;
  producers: Map<number, { topic: string; name: string }>;
  consumers: Map<number, { topic: string; subscription: string; permits: number }>;
  nextEntry: number;
  advertisedUrl: string;
  advertisedUrlTls: string;
  redirectTarget?: string;
  requireAuthToken?: string;
}

function createOfficialBrokerState(opts?: { redirectTarget?: string; requireAuthToken?: string }): FakeOfficialState {
  return {
    topics: new Map(),
    cursors: new Map(),
    producers: new Map(),
    consumers: new Map(),
    nextEntry: 1,
    advertisedUrl: "",
    advertisedUrlTls: "",
    redirectTarget: opts?.redirectTarget,
    requireAuthToken: opts?.requireAuthToken,
  };
}

function tokenFromConnect(cmd: OfficialCommand): string | undefined {
  const body = cmd.connect as Record<string, unknown> | undefined;
  if (!body) return undefined;
  const data = body.auth_data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof Uint8Array) return Buffer.from(data).toString("utf8");
  if (typeof data === "string" && data) {
    try {
      return Buffer.from(data, "base64").toString("utf8") || data;
    } catch {
      return data;
    }
  }
  return undefined;
}

function deliverIfPossible(state: FakeOfficialState, consumerId: number, writeFrame: (buf: Buffer) => void): void {
  const cons = state.consumers.get(consumerId);
  if (!cons || cons.permits <= 0) return;
  const key = `${cons.topic}::${cons.subscription}`;
  const log = state.topics.get(cons.topic) ?? [];
  const offset = state.cursors.get(key) ?? 0;
  if (offset >= log.length) return;
  const msg = log[offset]!;
  state.cursors.set(key, offset + 1);
  cons.permits -= 1;
  const parsed = parseMessageId(msg.messageId);
  const metadata: Record<string, unknown> = {
    producer_name: "fake-official",
    sequence_id: parsed.entryId,
    publish_time: msg.publishTime,
  };
  let payload = Buffer.from(msg.payload, "utf8");
  if (msg.chunk) {
    metadata.uuid = msg.chunk.uuid ?? "e2mcp-chunk";
    metadata.num_chunks_from_msg = msg.chunk.numChunks;
    metadata.chunk_id = msg.chunk.chunkId;
    metadata.total_chunk_msg_size = payload.length;
  } else if (msg.batch?.length) {
    metadata.num_messages_in_batch = msg.batch.length;
    payload = Buffer.from(encodeBatchPayload(msg.batch));
  }
  writeFrame(
    encodeOfficialPayloadFrame(
      {
        type: "MESSAGE",
        message: {
          consumer_id: consumerId,
          message_id: { ledgerId: parsed.ledgerId, entryId: parsed.entryId },
        },
      },
      metadata,
      payload,
    ),
  );
}

function handleOfficialFrame(
  state: FakeOfficialState,
  frame: OfficialFrame,
  writeCmd: (cmd: Record<string, unknown>) => void,
  writeFrame: (buf: Buffer) => void,
): void {
  const cmd = frame.command;
  if (cmd.type === "CONNECT") {
    if (state.requireAuthToken) {
      const got = tokenFromConnect(cmd);
      if (got !== state.requireAuthToken) {
        writeCmd({
          type: "ERROR",
          error: { request_id: 0, error: "AuthorizationError", message: "token required" },
        });
        return;
      }
    }
    writeCmd({
      type: "CONNECTED",
      connected: { server_version: "e2mcp-fake-official", protocol_version: PULSAR_PROTOCOL_VERSION },
    });
    return;
  }
  if (cmd.type === "PING") {
    writeCmd({ type: "PONG", pong: {} });
    return;
  }
  if (cmd.type === "PRODUCER") {
    const p = (cmd.producer ?? {}) as Record<string, unknown>;
    const producerId = asNumber(p.producer_id, 1);
    const requestId = asNumber(p.request_id, 0);
    const topic = typeof p.topic === "string" ? p.topic : "persistent://public/default/events";
    const name = typeof p.producer_name === "string" ? p.producer_name : `fake-${producerId}`;
    const parts = parsePulsarTopic(topic);
    if (!state.topics.has(parts.full)) state.topics.set(parts.full, []);
    state.producers.set(producerId, { topic: parts.full, name });
    writeCmd({ type: "PRODUCER_SUCCESS", producer_success: { request_id: requestId, producer_name: name } });
    return;
  }
  if (cmd.type === "SEND") {
    const s = (cmd.send ?? {}) as Record<string, unknown>;
    const producerId = asNumber(s.producer_id, 1);
    const sequenceId = asNumber(s.sequence_id, 0);
    const producer = state.producers.get(producerId);
    const topic = producer?.topic ?? "persistent://public/default/events";
    const parts = parsePulsarTopic(topic);
    if (!state.topics.has(parts.full)) state.topics.set(parts.full, []);
    const entryId = state.nextEntry++;
    const batchN = asNumber(frame.metadata?.num_messages_in_batch, 1);
    const chunked = isChunkedMetadata(frame.metadata);
    const msg: FakeOfficialMessage = {
      messageId: formatMessageId(1, entryId),
      payload: chunked ? (frame.payload ? frame.payload.toString("utf8") : "") : batchN > 1 ? "" : frame.payload ? frame.payload.toString("utf8") : "",
      topic: parts.full,
      publishTime: asNumber(frame.metadata?.publish_time, Date.now()),
    };
    if (chunked) {
      msg.chunk = {
        chunkId: asNumber(frame.metadata?.chunk_id, 0),
        numChunks: asNumber(frame.metadata?.num_chunks_from_msg, 1),
        uuid: typeof frame.metadata?.uuid === "string" ? frame.metadata.uuid : "e2mcp-chunk",
      };
    } else if (batchN > 1 && frame.payload) {
      msg.batch = decodeBatchPayload(frame.payload, batchN);
    }
    state.topics.get(parts.full)!.push(msg);
    writeCmd({
      type: "SEND_RECEIPT",
      send_receipt: {
        producer_id: producerId,
        sequence_id: sequenceId,
        message_id: { ledgerId: 1, entryId },
      },
    });
    for (const [cid, cons] of state.consumers) {
      if (cons.topic === parts.full) deliverIfPossible(state, cid, writeFrame);
    }
    return;
  }
  if (cmd.type === "SUBSCRIBE") {
    const s = (cmd.subscribe ?? {}) as Record<string, unknown>;
    const consumerId = asNumber(s.consumer_id, 1);
    const requestId = asNumber(s.request_id, 0);
    const topic = typeof s.topic === "string" ? s.topic : "persistent://public/default/events";
    const subscription = typeof s.subscription === "string" ? s.subscription : "everything2mcp";
    const parts = parsePulsarTopic(topic);
    if (!state.topics.has(parts.full)) state.topics.set(parts.full, []);
    const name = parts.name;
    if (/batch-seed/i.test(name) && (state.topics.get(parts.full)?.length ?? 0) === 0) {
      state.topics.get(parts.full)!.push({
        messageId: formatMessageId(1, state.nextEntry++),
        payload: "",
        topic: parts.full,
        publishTime: Date.now(),
        batch: ["alpha", "beta"],
      });
    }
    if (/chunk-seed/i.test(name) && (state.topics.get(parts.full)?.length ?? 0) === 0) {
      state.topics.get(parts.full)!.push({
        messageId: formatMessageId(1, state.nextEntry++),
        payload: "AA",
        topic: parts.full,
        publishTime: Date.now(),
        chunk: { chunkId: 0, numChunks: 2, uuid: "e2mcp-chunk" },
      });
      state.topics.get(parts.full)!.push({
        messageId: formatMessageId(1, state.nextEntry++),
        payload: "BB",
        topic: parts.full,
        publishTime: Date.now(),
        chunk: { chunkId: 1, numChunks: 2, uuid: "e2mcp-chunk" },
      });
    }
    state.consumers.set(consumerId, { topic: parts.full, subscription, permits: 0 });
    writeCmd({ type: "SUCCESS", success: { request_id: requestId } });
    return;
  }
  if (cmd.type === "FLOW") {
    const f = (cmd.flow ?? {}) as Record<string, unknown>;
    const consumerId = asNumber(f.consumer_id, 1);
    const permits = asNumber(f.messagePermits, 1);
    const cons = state.consumers.get(consumerId);
    if (cons) cons.permits += permits;
    deliverIfPossible(state, consumerId, writeFrame);
    return;
  }
  if (cmd.type === "ACK" || cmd.type === "PONG") {
    return;
  }
  if (cmd.type === "LOOKUP") {
    const l = (cmd.lookupTopic ?? {}) as Record<string, unknown>;
    const requestId = asNumber(l.request_id, 0);
    const topic = typeof l.topic === "string" ? l.topic : "";
    const name = parsePulsarTopic(topic).name;
    const authoritative = l.authoritative === true;
    if (/missing|notfound|__fail|-fail$/i.test(name)) {
      writeCmd({
        type: "LOOKUP_RESPONSE",
        lookupTopicResponse: {
          request_id: requestId,
          response: "Failed",
          error: "TopicNotFound",
          message: `topic not found: ${topic}`,
        },
      });
      return;
    }
    if (/redirect-loop/i.test(name)) {
      writeCmd({
        type: "LOOKUP_RESPONSE",
        lookupTopicResponse: {
          request_id: requestId,
          response: "Redirect",
          brokerServiceUrl: state.advertisedUrl || "pulsar://127.0.0.1:6650",
          authoritative: false,
          message: "redirect loop",
        },
      });
      return;
    }
    if (!authoritative && (/redirect-dead/i.test(name) || (/redirect/i.test(name) && !state.redirectTarget))) {
      writeCmd({
        type: "LOOKUP_RESPONSE",
        lookupTopicResponse: {
          request_id: requestId,
          response: "Redirect",
          brokerServiceUrl: "pulsar://127.0.0.1:1",
          authoritative: false,
          message: "dead redirect hop",
        },
      });
      return;
    }
    if (!authoritative && /redirect/i.test(name) && state.redirectTarget) {
      writeCmd({
        type: "LOOKUP_RESPONSE",
        lookupTopicResponse: {
          request_id: requestId,
          response: "Redirect",
          brokerServiceUrl: state.redirectTarget,
          authoritative: false,
          message: "follow to owner broker",
        },
      });
      return;
    }
    const ssl = /^pulsar\+ssl:/i.test(state.advertisedUrl) || Boolean(state.advertisedUrlTls);
    writeCmd({
      type: "LOOKUP_RESPONSE",
      lookupTopicResponse: {
        request_id: requestId,
        response: "Connect",
        brokerServiceUrl: state.advertisedUrl || "pulsar://127.0.0.1:6650",
        brokerServiceUrlTls: ssl ? state.advertisedUrlTls || state.advertisedUrl : undefined,
        authoritative: true,
      },
    });
    return;
  }
  if (cmd.type === "PARTITIONED_METADATA") {
    const p = (cmd.partitionMetadata ?? {}) as Record<string, unknown>;
    const requestId = asNumber(p.request_id, 0);
    const topic = typeof p.topic === "string" ? p.topic : "";
    const name = parsePulsarTopic(topic).name;
    if (/missing|notfound|__fail|-fail$/i.test(name)) {
      writeCmd({
        type: "PARTITIONED_METADATA_RESPONSE",
        partitionMetadataResponse: {
          request_id: requestId,
          response: "Failed",
          partitions: 0,
          error: "TopicNotFound",
          message: `topic not found: ${topic}`,
        },
      });
      return;
    }
    const match = name.match(/partitions-(\d+)/i);
    const partitions = match ? Number(match[1]) : /parted/i.test(name) ? 3 : 0;
    writeCmd({
      type: "PARTITIONED_METADATA_RESPONSE",
      partitionMetadataResponse: {
        request_id: requestId,
        response: "Success",
        partitions,
      },
    });
    return;
  }
  if (cmd.type === "GET_TOPICS_OF_NAMESPACE") {
    const g = (cmd.getTopicsOfNamespace ?? {}) as Record<string, unknown>;
    const requestId = asNumber(g.request_id, 0);
    const ns = typeof g.namespace === "string" ? g.namespace : "";
    const topics = [...state.topics.keys()].filter((t) => {
      if (!ns || ns === "*" || ns === "ALL") return true;
      const parts = parsePulsarTopic(t);
      return `${parts.tenant}/${parts.namespace}` === ns || t.includes(ns);
    });
    writeCmd({
      type: "GET_TOPICS_OF_NAMESPACE_RESPONSE",
      getTopicsOfNamespaceResponse: { request_id: requestId, topics },
    });
    return;
  }
  if (cmd.type === "CLOSE_PRODUCER") {
    const c = (cmd.close_producer ?? {}) as Record<string, unknown>;
    state.producers.delete(asNumber(c.producer_id, 0));
    writeCmd({ type: "SUCCESS", success: { request_id: asNumber(c.request_id, 0) } });
    return;
  }
  if (cmd.type === "CLOSE_CONSUMER") {
    const c = (cmd.close_consumer ?? {}) as Record<string, unknown>;
    state.consumers.delete(asNumber(c.consumer_id, 0));
    writeCmd({ type: "SUCCESS", success: { request_id: asNumber(c.request_id, 0) } });
    return;
  }
  const requestId = requestIdOf(cmd) ?? 0;
  writeCmd({
    type: "ERROR",
    error: { request_id: requestId, error: "UnknownError", message: `unsupported command ${cmd.type}` },
  });
}

export async function listenFakeOfficialPulsarBroker(
  host = "127.0.0.1",
  opts?: { tls?: { key: Buffer; cert: Buffer }; redirectTarget?: string; requireAuthToken?: string },
): Promise<{ port: number; close: () => Promise<void>; url: string; ssl: boolean }> {
  const state = createOfficialBrokerState(opts);
  const handler = (socket: Socket) => {
    let rest: Buffer = Buffer.alloc(0);
    socket.on("error", () => {
      /* peer reset during CLOSE_* is expected */
    });
    const writeFrame = (buf: Buffer) => {
      if (socket.destroyed || !socket.writable) return;
      try {
        socket.write(buf);
      } catch {
        /* EPIPE after client destroy */
      }
    };
    const writeCmd = (cmd: Record<string, unknown>) => writeFrame(encodeOfficialCommandFrame(cmd));
    socket.on("data", (chunk) => {
      try {
        const decoded = tryDecodeOfficialFrames(Buffer.concat([rest, chunk]));
        rest = decoded.rest;
        for (const frame of decoded.frames) handleOfficialFrame(state, frame, writeCmd, writeFrame);
      } catch (err) {
        writeCmd({
          type: "ERROR",
          error: {
            request_id: 0,
            error: "UnknownError",
            message: err instanceof Error ? err.message : String(err),
          },
        });
        socket.end();
      }
    });
  };
  const server: Server = opts?.tls
    ? tls.createServer({ key: opts.tls.key, cert: opts.tls.cert }, handler)
    : createServer(handler);
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") reject(new Error("fake official Pulsar broker failed to bind"));
      else resolve(addr.port);
    });
  });
  const scheme = opts?.tls ? "pulsar+ssl" : "pulsar";
  const url = `${scheme}://${host}:${port}`;
  state.advertisedUrl = url;
  if (opts?.tls) state.advertisedUrlTls = url;
  return {
    port,
    ssl: Boolean(opts?.tls),
    url,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
