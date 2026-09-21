import { createConnection, createServer, type Socket } from "node:net";
import { AdapterError } from "../../runtime/errors.js";

export interface MongoDoc {
  [key: string]: unknown;
}

export interface MongoHandle {
  listCollections(): Promise<string[]>;
  describe(collection: string): Promise<{ collection: string; fields: string[]; count: number }>;
  find(collection: string, filter: Record<string, unknown>, limit: number): Promise<MongoDoc[]>;
  insertOne(collection: string, doc: MongoDoc): Promise<{ insertedId: string }>;
  close(): Promise<void>;
}

export const OP_MSG = 2013;

export function encodeCString(name: string): Buffer {
  return Buffer.concat([Buffer.from(name, "utf8"), Buffer.from([0])]);
}

export function encodeBson(doc: Record<string, unknown>): Buffer {
  const parts: Buffer[] = [];
  for (const [key, value] of Object.entries(doc)) {
    const enc = encodeValue(value);
    parts.push(Buffer.from([enc.type]), encodeCString(key), enc.buf);
  }
  const body = Buffer.concat([...parts, Buffer.from([0])]);
  const header = Buffer.alloc(4);
  header.writeInt32LE(body.length + 4, 0);
  return Buffer.concat([header, body]);
}

function encodeValue(value: unknown): { type: number; buf: Buffer } {
  if (value === null || value === undefined) return { type: 0x0a, buf: Buffer.alloc(0) };
  if (typeof value === "boolean") return { type: 0x08, buf: Buffer.from([value ? 1 : 0]) };
  if (typeof value === "string") {
    const raw = Buffer.from(value, "utf8");
    const head = Buffer.alloc(4);
    head.writeInt32LE(raw.length + 1, 0);
    return { type: 0x02, buf: Buffer.concat([head, raw, Buffer.from([0])]) };
  }
  if (typeof value === "number") {
    if (Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff) {
      const buf = Buffer.alloc(4);
      buf.writeInt32LE(value, 0);
      return { type: 0x10, buf };
    }
    const buf = Buffer.alloc(8);
    buf.writeDoubleLE(value, 0);
    return { type: 0x01, buf };
  }
  if (Array.isArray(value)) {
    const obj: Record<string, unknown> = {};
    value.forEach((item, i) => {
      obj[String(i)] = item;
    });
    return { type: 0x04, buf: encodeBson(obj) };
  }
  if (typeof value === "object") return { type: 0x03, buf: encodeBson(value as Record<string, unknown>) };
  return encodeValue(String(value));
}

export function decodeBson(buf: Buffer, offset = 0): { value: Record<string, unknown>; next: number } {
  if (buf.length < offset + 4) return { value: {}, next: offset };
  const size = buf.readInt32LE(offset);
  const end = offset + size;
  let o = offset + 4;
  const out: Record<string, unknown> = {};
  while (o < end - 1) {
    const type = buf[o]!;
    o += 1;
    if (type === 0) break;
    const nameEnd = buf.indexOf(0, o);
    const name = buf.subarray(o, nameEnd).toString("utf8");
    o = nameEnd + 1;
    if (type === 0x0a) out[name] = null;
    else if (type === 0x08) {
      out[name] = buf[o] === 1;
      o += 1;
    } else if (type === 0x10) {
      out[name] = buf.readInt32LE(o);
      o += 4;
    } else if (type === 0x01) {
      out[name] = buf.readDoubleLE(o);
      o += 8;
    } else if (type === 0x12) {
      out[name] = Number(buf.readBigInt64LE(o));
      o += 8;
    } else if (type === 0x02) {
      const n = buf.readInt32LE(o);
      o += 4;
      out[name] = buf.subarray(o, o + n - 1).toString("utf8");
      o += n;
    } else if (type === 0x03 || type === 0x04) {
      const nested = decodeBson(buf, o);
      out[name] = type === 0x04 ? bsonArray(nested.value) : nested.value;
      o = nested.next;
    } else {
      break;
    }
  }
  return { value: out, next: end };
}

function bsonArray(doc: Record<string, unknown>): unknown[] {
  const keys = Object.keys(doc).sort((a, b) => Number(a) - Number(b));
  return keys.map((k) => doc[k]);
}

export function encodeOpMsg(doc: Record<string, unknown>, requestId: number, responseTo = 0): Buffer {
  const section = Buffer.concat([Buffer.from([0]), encodeBson(doc)]);
  const flags = Buffer.alloc(4);
  const body = Buffer.concat([flags, section]);
  const header = Buffer.alloc(16);
  header.writeInt32LE(16 + body.length, 0);
  header.writeInt32LE(requestId, 4);
  header.writeInt32LE(responseTo, 8);
  header.writeInt32LE(OP_MSG, 12);
  return Buffer.concat([header, body]);
}

export function decodeOpMsg(buf: Buffer): { requestId: number; responseTo: number; doc: Record<string, unknown> } {
  if (buf.length < 21) return { requestId: 0, responseTo: 0, doc: {} };
  const requestId = buf.readInt32LE(4);
  const responseTo = buf.readInt32LE(8);
  const opcode = buf.readInt32LE(12);
  if (opcode !== OP_MSG) {
    throw new AdapterError("E_PROTOCOL", `mongodb opcode ${opcode} (want OP_MSG ${OP_MSG})`, { protocol: "mongodb" });
  }
  const kind = buf[20];
  if (kind !== 0) {
    throw new AdapterError("E_PROTOCOL", "mongodb OP_MSG only supports kind-0 body", { protocol: "mongodb" });
  }
  return { requestId, responseTo, doc: decodeBson(buf, 21).value };
}

class MsgReader {
  private leftover = Buffer.alloc(0);
  constructor(private readonly socket: Socket) {}
  async readMessage(timeoutMs: number): Promise<Buffer> {
    const first = await this.readExact(4, timeoutMs);
    const len = first.readInt32LE(0);
    if (len < 16 || len > 16 * 1024 * 1024) {
      throw new AdapterError("E_PROTOCOL", `mongodb bad message length ${len}`, { protocol: "mongodb" });
    }
    const rest = await this.readExact(len - 4, timeoutMs);
    return Buffer.concat([first, rest]);
  }
  private readExact(n: number, timeoutMs: number): Promise<Buffer> {
    if (this.leftover.length >= n) {
      const out = this.leftover.subarray(0, n);
      this.leftover = this.leftover.subarray(n);
      return Promise.resolve(out);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new AdapterError("E_TIMEOUT", "mongodb read timeout", { protocol: "mongodb" })), timeoutMs);
      const onData = (chunk: Buffer) => {
        this.leftover = Buffer.concat([this.leftover, chunk]);
        if (this.leftover.length >= n) {
          this.socket.off("data", onData);
          clearTimeout(timer);
          const out = this.leftover.subarray(0, n);
          this.leftover = this.leftover.subarray(n);
          resolve(out);
        }
      };
      this.socket.on("data", onData);
      this.socket.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
}

export async function liveMongoWire(config: Record<string, unknown>): Promise<MongoHandle> {
  const raw = String(config.url ?? "");
  const u = raw.replace(/^mongodb:\/\//i, "");
  const [hp, dbPart] = u.split("/");
  const [host, portRaw] = (hp ?? "127.0.0.1").split(":");
  const port = Number(portRaw ?? 27017);
  const db = (dbPart ?? "test").split("?")[0] || "test";
  const timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 4000;
  const socket = await new Promise<Socket>((resolve, reject) => {
    const s = createConnection({ host: host || "127.0.0.1", port, timeout: timeoutMs }, () => resolve(s));
    s.once("error", reject);
  });
  const reader = new MsgReader(socket);
  let nextId = 1;
  const command = async (doc: Record<string, unknown>) => {
    const id = nextId++;
    socket.write(encodeOpMsg({ ...doc, $db: db }, id));
    const buf = await reader.readMessage(timeoutMs);
    const decoded = decodeOpMsg(buf);
    if (decoded.doc.ok !== 1 && decoded.doc.ok !== true) {
      throw new AdapterError("E_PROTOCOL", `mongodb command failed: ${JSON.stringify(decoded.doc).slice(0, 180)}`, {
        protocol: "mongodb",
      });
    }
    return decoded.doc;
  };
  await command({ hello: 1 });
  return {
    async listCollections() {
      const reply = await command({ listCollections: 1 });
      const cursor = (reply.cursor as { firstBatch?: Array<{ name?: string }> } | undefined) ?? {};
      return (cursor.firstBatch ?? []).map((row) => String(row.name ?? "")).filter(Boolean);
    },
    async describe(collection) {
      const reply = await command({ find: collection, filter: {}, limit: 20 });
      const cursor = (reply.cursor as { firstBatch?: MongoDoc[] } | undefined) ?? {};
      const docs = cursor.firstBatch ?? [];
      const fields = new Set<string>();
      for (const d of docs) Object.keys(d).forEach((k) => fields.add(k));
      return { collection, fields: [...fields].sort(), count: docs.length };
    },
    async find(collection, filter, limit) {
      const reply = await command({ find: collection, filter, limit });
      const cursor = (reply.cursor as { firstBatch?: MongoDoc[] } | undefined) ?? {};
      return (cursor.firstBatch ?? []).map((d) => ({ ...d }));
    },
    async insertOne(collection, doc) {
      const reply = await command({ insert: collection, documents: [doc] });
      const id = typeof doc._id === "string" ? doc._id : String(reply.n ?? "1");
      return { insertedId: id };
    },
    async close() {
      socket.destroy();
    },
  };
}

/** In-process OP_MSG server backed by the memory handle. */
export async function listenMongoOpMsg(mem: MongoHandle): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((socket) => {
    const reader = new MsgReader(socket);
    const feed = async () => {
      try {
        for (;;) {
          const buf = await reader.readMessage(8000);
          const msg = decodeOpMsg(buf);
          const cmd = msg.doc;
          let reply: Record<string, unknown> = { ok: 1 };
          if (cmd.hello === 1 || cmd.ismaster === 1 || cmd.isMaster === 1) {
            reply = { ok: 1, isWritablePrimary: true, maxWireVersion: 21, minWireVersion: 0 };
          } else if (typeof cmd.find === "string") {
            const filter =
              cmd.filter && typeof cmd.filter === "object" && !Array.isArray(cmd.filter)
                ? (cmd.filter as Record<string, unknown>)
                : {};
            const limit = typeof cmd.limit === "number" ? cmd.limit : 50;
            const docs = await mem.find(cmd.find, filter, limit);
            reply = { ok: 1, cursor: { firstBatch: docs, id: 0, ns: `test.${cmd.find}` } };
          } else if (typeof cmd.insert === "string") {
            const docs = Array.isArray(cmd.documents) ? (cmd.documents as MongoDoc[]) : [];
            let last = "0";
            for (const d of docs) last = (await mem.insertOne(cmd.insert, d)).insertedId;
            reply = { ok: 1, n: docs.length, insertedId: last };
          } else if (cmd.listCollections === 1) {
            const names = await mem.listCollections();
            reply = { ok: 1, cursor: { firstBatch: names.map((name) => ({ name, type: "collection" })), id: 0 } };
          }
          socket.write(encodeOpMsg(reply, msg.requestId + 1000, msg.requestId));
        }
      } catch {
        socket.destroy();
      }
    };
    void feed();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { port, close: () => new Promise((r) => server.close(() => r())) };
}
