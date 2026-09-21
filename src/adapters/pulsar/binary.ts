import { createServer, type Server, Socket } from "node:net";
import { AdapterError } from "../../runtime/errors.js";
import { stringField } from "../helpers.js";
import { parsePulsarTopic, type PulsarHandle, type PulsarMessage } from "./topic.js";

/** ASCII "E2P1" — Everything2MCP Pulsar dialect v1 (not Apache PulsarApi). */
export const E2MCP_PULSAR_MAGIC = Buffer.from("E2P1", "ascii");
export const E2MCP_PULSAR_PROTOCOL = "e2mcp-pulsar";

export type PulsarBinaryFrame = Record<string, unknown> & { type: string };

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function encodePulsarFrame(obj: Record<string, unknown>): Buffer {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const buf = Buffer.alloc(8 + json.length);
  E2MCP_PULSAR_MAGIC.copy(buf, 0);
  buf.writeUInt32BE(json.length, 4);
  json.copy(buf, 8);
  return buf;
}

export function tryDecodePulsarFrames(buf: Buffer): { frames: PulsarBinaryFrame[]; rest: Buffer } {
  const frames: PulsarBinaryFrame[] = [];
  let offset = 0;
  while (buf.length - offset >= 8) {
    const magic = buf.subarray(offset, offset + 4);
    if (!magic.equals(E2MCP_PULSAR_MAGIC)) {
      throw new AdapterError(
        "E_PROTOCOL",
        "Pulsar e2p1 handshake failed: expected magic E2P1. Default pulsar:// is official PulsarApi; this path is dialect=e2p1.",
        { protocol: "pulsar" },
      );
    }
    const len = buf.readUInt32BE(offset + 4);
    if (buf.length - offset < 8 + len) break;
    const raw = buf.subarray(offset + 8, offset + 8 + len).toString("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AdapterError("E_PROTOCOL", "Pulsar binary frame is not JSON", { protocol: "pulsar" });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof (parsed as { type?: unknown }).type !== "string") {
      throw new AdapterError("E_PROTOCOL", "Pulsar binary frame missing type", { protocol: "pulsar" });
    }
    frames.push(parsed as PulsarBinaryFrame);
    offset += 8 + len;
  }
  return { frames, rest: Buffer.from(buf.subarray(offset)) };
}

class FrameSocket {
  private rest: Buffer = Buffer.alloc(0);
  private readonly waiters: Array<{
    resolve: (frame: PulsarBinaryFrame) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private fail: Error | undefined;

  constructor(private readonly socket: Socket) {
    socket.on("data", (chunk) => {
      try {
        const { frames, rest } = tryDecodePulsarFrames(Buffer.concat([this.rest, chunk]));
        this.rest = rest;
        for (const frame of frames) {
          const waiter = this.waiters.shift();
          if (waiter) {
            clearTimeout(waiter.timer);
            waiter.resolve(frame);
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
      if (!this.fail) this.fail = new AdapterError("E_PROTOCOL", "Pulsar binary socket closed", { protocol: "pulsar" });
      this.flushWaiters();
    });
  }

  write(obj: Record<string, unknown>): void {
    this.socket.write(encodePulsarFrame(obj));
  }

  read(ms: number): Promise<PulsarBinaryFrame> {
    if (this.fail) return Promise.reject(this.fail);
    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const idx = this.waiters.indexOf(entry);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(new Error(`Timed out waiting for Pulsar binary frame after ${ms}ms`));
        }, ms),
      };
      this.waiters.push(entry);
    });
  }

  async rpc(obj: Record<string, unknown>, ms: number): Promise<PulsarBinaryFrame> {
    this.write(obj);
    const reply = await this.read(ms);
    if (reply.type === "ERROR") {
      throw new AdapterError(
        "E_PROTOCOL",
        `Pulsar binary ERROR: ${typeof reply.message === "string" ? reply.message : "unknown"}`,
        { protocol: "pulsar" },
      );
    }
    return reply;
  }

  close(): void {
    this.socket.end();
    this.socket.destroy();
  }

  private flushWaiters(): void {
    const err = this.fail ?? new AdapterError("E_PROTOCOL", "Pulsar binary socket closed", { protocol: "pulsar" });
    while (this.waiters.length) {
      const waiter = this.waiters.shift();
      if (!waiter) break;
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
  }
}

function parseServiceUrl(url: string): { host: string; port: number; ssl: boolean } {
  const trimmed = url.trim();
  if (/^pulsar\+ssl:\/\//i.test(trimmed)) {
    throw new AdapterError(
      "E_UNSUPPORTED",
      "e2mcp-pulsar (dialect=e2p1) has no TLS. Use official pulsar+ssl:// (omit dialect), pulsar://, memory://, or unsigned HTTP.",
      { protocol: "pulsar" },
    );
  }
  const bare = trimmed.replace(/^pulsar:\/\//i, "");
  const [hostPart, portPart] = bare.split(":");
  const host = hostPart && hostPart.trim() ? hostPart.trim() : "127.0.0.1";
  const port = portPart ? Number(portPart) : 6650;
  if (!Number.isFinite(port) || port <= 0) {
    throw new AdapterError("E_INVALID_CONFIG", `Invalid pulsar:// port in ${url}`, { protocol: "pulsar" });
  }
  return { host, port, ssl: false };
}

export async function connectBinaryPulsar(config: Record<string, unknown>): Promise<PulsarHandle> {
  const endpoint =
    stringField(config, "serviceUrl") ??
    stringField(config, "url") ??
    stringField(config, "endpoint") ??
    "pulsar://127.0.0.1:6650";
  const { host, port } = parseServiceUrl(endpoint);
  const tenant = stringField(config, "tenant") ?? "public";
  const namespace = stringField(config, "namespace") ?? "default";
  const timeout = typeof config.timeoutMs === "number" && config.timeoutMs > 0 ? config.timeoutMs : 8000;
  const socket = new Socket();
  try {
    await new Promise<void>((resolve, reject) => {
      const onErr = (err: Error) => {
        clearTimeout(timer);
        reject(err);
      };
      const timer = setTimeout(() => {
        socket.off("error", onErr);
        socket.destroy();
        reject(new Error(`connect timed out after ${timeout}ms`));
      }, timeout);
      socket.once("error", onErr);
      socket.connect({ host, port }, () => {
        clearTimeout(timer);
        socket.off("error", onErr);
        resolve();
      });
    });
  } catch (err) {
    socket.destroy();
    throw new AdapterError(
      "E_PROTOCOL",
      `Pulsar binary connect failed ${host}:${port}: ${err instanceof Error ? err.message : String(err)}`,
      { protocol: "pulsar" },
    );
  }
  const wire = new FrameSocket(socket);
  try {
    const hello = await wire.rpc({ type: "CONNECT", protocol: E2MCP_PULSAR_PROTOCOL, version: 1 }, timeout);
    if (hello.type !== "CONNECTED") {
      throw new AdapterError(
        "E_PROTOCOL",
        `Pulsar binary handshake expected CONNECTED, got ${hello.type}`,
        { protocol: "pulsar" },
      );
    }
  } catch (err) {
    wire.close();
    if (err instanceof AdapterError) throw err;
    throw new AdapterError(
      "E_PROTOCOL",
      `Pulsar binary handshake failed: ${err instanceof Error ? err.message : String(err)}`,
      { protocol: "pulsar" },
    );
  }

  return {
    async publish(topic, payload) {
      const full = parsePulsarTopic(topic, tenant, namespace).full;
      const reply = await wire.rpc({ type: "SEND", topic: full, payload }, timeout);
      if (reply.type !== "SEND_RECEIPT") {
        throw new AdapterError("E_PROTOCOL", `Pulsar binary SEND expected SEND_RECEIPT, got ${reply.type}`, {
          protocol: "pulsar",
        });
      }
      return {
        messageId: typeof reply.messageId === "string" ? reply.messageId : "unknown",
        topic: typeof reply.topic === "string" ? reply.topic : full,
      };
    },
    async consumeOnce(topic, subscription, ms) {
      const full = parsePulsarTopic(topic, tenant, namespace).full;
      const reply = await wire.rpc({ type: "SUBSCRIBE", topic: full, subscription }, ms);
      if (reply.type !== "MESSAGE") {
        throw new AdapterError("E_PROTOCOL", `Pulsar binary SUBSCRIBE expected MESSAGE, got ${reply.type}`, {
          protocol: "pulsar",
        });
      }
      if (typeof reply.messageId === "string") {
        wire.write({ type: "ACK", messageId: reply.messageId, subscription });
      }
      return {
        messageId: typeof reply.messageId === "string" ? reply.messageId : "unknown",
        payload: typeof reply.payload === "string" ? reply.payload : JSON.stringify(reply.payload ?? ""),
        topic: typeof reply.topic === "string" ? reply.topic : full,
        publishTime: typeof reply.publishTime === "number" ? reply.publishTime : Date.now(),
      };
    },
    async listTopics() {
      const reply = await wire.rpc({ type: "LIST_TOPICS" }, timeout);
      return Array.isArray(reply.topics) ? reply.topics.filter((t): t is string => typeof t === "string") : [];
    },
    async listNamespaces() {
      const reply = await wire.rpc({ type: "LIST_NAMESPACES" }, timeout);
      return Array.isArray(reply.namespaces)
        ? reply.namespaces.filter((t): t is string => typeof t === "string")
        : [];
    },
    async close() {
      try {
        wire.write({ type: "CLOSE" });
      } catch {
        /* ignore */
      }
      wire.close();
    },
  };
}

interface FakeBrokerState {
  topics: Map<string, PulsarMessage[]>;
  cursors: Map<string, number>;
  waiters: Map<string, Array<(msg: PulsarMessage) => void>>;
  namespaces: Set<string>;
}

function createBrokerState(): FakeBrokerState {
  return {
    topics: new Map(),
    cursors: new Map(),
    waiters: new Map(),
    namespaces: new Set(["public/default"]),
  };
}

function handleFakeFrame(state: FakeBrokerState, frame: PulsarBinaryFrame, write: (obj: Record<string, unknown>) => void): void {
  if (frame.type === "CONNECT") {
    write({ type: "CONNECTED", protocol: E2MCP_PULSAR_PROTOCOL, version: 1 });
    return;
  }
  if (frame.type === "SEND") {
    const topic = typeof frame.topic === "string" ? frame.topic : "persistent://public/default/events";
    const payload = typeof frame.payload === "string" ? frame.payload : JSON.stringify(frame.payload ?? "");
    const parts = parsePulsarTopic(topic);
    if (!state.topics.has(parts.full)) state.topics.set(parts.full, []);
    state.namespaces.add(`${parts.tenant}/${parts.namespace}`);
    const msg: PulsarMessage = {
      messageId: newId("msg"),
      payload,
      topic: parts.full,
      publishTime: Date.now(),
    };
    state.topics.get(parts.full)!.push(msg);
    const waiter = state.waiters.get(parts.full)?.shift();
    if (waiter) waiter(msg);
    write({ type: "SEND_RECEIPT", messageId: msg.messageId, topic: parts.full });
    return;
  }
  if (frame.type === "SUBSCRIBE") {
    const topic = typeof frame.topic === "string" ? frame.topic : "persistent://public/default/events";
    const subscription = typeof frame.subscription === "string" ? frame.subscription : "everything2mcp";
    const parts = parsePulsarTopic(topic);
    if (!state.topics.has(parts.full)) state.topics.set(parts.full, []);
    const key = `${parts.full}::${subscription}`;
    const log = state.topics.get(parts.full)!;
    const offset = state.cursors.get(key) ?? 0;
    const deliver = (msg: PulsarMessage) => {
      write({
        type: "MESSAGE",
        messageId: msg.messageId,
        payload: msg.payload,
        topic: msg.topic,
        publishTime: msg.publishTime,
        subscription,
      });
    };
    if (offset < log.length) {
      const msg = log[offset]!;
      state.cursors.set(key, offset + 1);
      deliver(msg);
      return;
    }
    const list = state.waiters.get(parts.full) ?? [];
    list.push((msg) => {
      state.cursors.set(key, (state.cursors.get(key) ?? 0) + 1);
      deliver(msg);
    });
    state.waiters.set(parts.full, list);
    return;
  }
  if (frame.type === "LIST_TOPICS") {
    write({ type: "TOPICS", topics: [...state.topics.keys()].sort() });
    return;
  }
  if (frame.type === "LIST_NAMESPACES") {
    write({ type: "NAMESPACES", namespaces: [...state.namespaces].sort() });
    return;
  }
  if (frame.type === "ACK" || frame.type === "CLOSE" || frame.type === "PING") {
    if (frame.type === "PING") write({ type: "PONG" });
    return;
  }
  write({ type: "ERROR", code: "E_UNKNOWN", message: `unknown frame type ${frame.type}` });
}

export async function listenFakePulsarBroker(
  host = "127.0.0.1",
): Promise<{ port: number; close: () => Promise<void>; url: string }> {
  const state = createBrokerState();
  const server: Server = createServer((socket) => {
    let rest: Buffer = Buffer.alloc(0);
    const write = (obj: Record<string, unknown>) => {
      if (!socket.destroyed) socket.write(encodePulsarFrame(obj));
    };
    socket.on("data", (chunk) => {
      try {
        const decoded = tryDecodePulsarFrames(Buffer.concat([rest, chunk]));
        rest = decoded.rest;
        for (const frame of decoded.frames) handleFakeFrame(state, frame, write);
      } catch (err) {
        write({
          type: "ERROR",
          code: "E_PROTOCOL",
          message: err instanceof Error ? err.message : String(err),
        });
        socket.end();
      }
    });
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") reject(new Error("fake Pulsar broker failed to bind"));
      else resolve(addr.port);
    });
  });
  return {
    port,
    url: `pulsar://${host}:${port}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function isPulsarBinaryUrl(url: string | undefined): boolean {
  if (!url) return false;
  return /^pulsar(\+ssl)?:\/\//i.test(url.trim());
}
