import { createConnection, createServer, type Socket } from "node:net";
import { AdapterError } from "../../runtime/errors.js";
import { assertHostAllowed } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";
import { requiredString, stringField } from "../helpers.js";

export const OP_CREATE = 1;
export const OP_DELETE = 2;
export const OP_EXISTS = 3;
export const OP_GETDATA = 4;
export const OP_SETDATA = 5;
export const OP_GETCHILDREN = 8;
export const OP_MULTI = 14;
export const OP_CLOSE = -11;
export const WATCH_XID = -1;
export const EVENT_NODE_CREATED = 1;
export const EVENT_NODE_DELETED = 2;
export const EVENT_NODE_DATA = 3;
export const ZK_OK = 0;
export const ZK_NONODE = -101;
export const ZK_NODEEXISTS = -110;

export function i32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
}
export function i64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64BE(BigInt(n));
  return b;
}
export function ustr(s: string): Buffer {
  const raw = Buffer.from(s, "utf8");
  return Buffer.concat([i32(raw.length), raw]);
}
export function bytes(buf: Buffer): Buffer {
  return Buffer.concat([i32(buf.length), buf]);
}
export function frame(body: Buffer): Buffer {
  return Buffer.concat([i32(body.length), body]);
}

export function encodeConnectRequest(timeoutMs = 10000): Buffer {
  const passwd = Buffer.alloc(16);
  return frame(Buffer.concat([i32(0), i64(0), i32(timeoutMs), i64(0), bytes(passwd)]));
}

export function encodeConnectResponse(sessionId: number, timeoutMs = 10000): Buffer {
  const passwd = Buffer.alloc(16);
  return frame(Buffer.concat([i32(0), i32(timeoutMs), i64(sessionId), bytes(passwd)]));
}

export function encodeRequest(xid: number, type: number, body: Buffer): Buffer {
  return frame(Buffer.concat([i32(xid), i32(type), body]));
}

export function encodeReply(xid: number, err: number, body: Buffer): Buffer {
  return frame(Buffer.concat([i32(xid), i64(0), i32(err), body]));
}

export function dummyStat(): Buffer {
  return Buffer.concat([i64(0), i64(0), i64(0), i64(0), i32(0), i32(0), i32(0), i64(0), i32(0), i32(0), i64(0)]);
}

function multiHeader(type: number, done: boolean, err: number): Buffer {
  return Buffer.concat([i32(type), Buffer.from([done ? 1 : 0]), i32(err)]);
}

function readMultiHeader(r: Reader): { type: number; done: boolean; err: number } {
  const type = r.i32();
  const done = r.buf[r.o++] === 1;
  const err = r.i32();
  return { type, done, err };
}

function skipCreateAclAndFlags(r: Reader): void {
  const aclCount = r.i32();
  for (let i = 0; i < aclCount; i++) {
    r.i32();
    r.str();
    r.str();
  }
  r.i32();
}

class Reader {
  constructor(
    readonly buf: Buffer,
    public o = 0,
  ) {}
  i32(): number {
    const v = this.buf.readInt32BE(this.o);
    this.o += 4;
    return v;
  }
  i64(): number {
    const v = Number(this.buf.readBigInt64BE(this.o));
    this.o += 8;
    return v;
  }
  str(): string {
    const n = this.i32();
    if (n < 0) return "";
    const s = this.buf.subarray(this.o, this.o + n).toString("utf8");
    this.o += n;
    return s;
  }
  bytes(): Buffer {
    const n = this.i32();
    if (n < 0) return Buffer.alloc(0);
    const b = this.buf.subarray(this.o, this.o + n);
    this.o += n;
    return b;
  }
}

export function decodeFrame(buf: Buffer): { body: Buffer; rest: Buffer } | undefined {
  if (buf.length < 4) return undefined;
  const n = buf.readInt32BE(0);
  if (n < 0 || n > 1_000_000) return undefined;
  if (buf.length < 4 + n) return undefined;
  return { body: Buffer.from(buf.subarray(4, 4 + n)), rest: Buffer.from(buf.subarray(4 + n)) };
}

export interface ZkWatchEvent {
  type: number;
  path: string;
  state: string;
}

export interface ZkMultiOp {
  op: "create" | "set" | "delete";
  path: string;
  data?: string;
}

export interface ZkHandle {
  ruok(): Promise<string>;
  exists(path: string): Promise<{ exists: boolean }>;
  get(path: string): Promise<{ path: string; data: string }>;
  getChildren(path: string): Promise<{ path: string; children: string[] }>;
  create(path: string, data: string): Promise<{ path: string }>;
  set(path: string, data: string): Promise<{ path: string }>;
  delete(path: string): Promise<{ path: string; deleted: true }>;
  watchOnce?(path: string, timeoutMs: number): Promise<ZkWatchEvent>;
  multi?(ops: ZkMultiOp[]): Promise<{ results: Array<{ op: string; path: string; ok: boolean }> }>;
  close(): Promise<void>;
}

export type ZkConnectFn = (config: Record<string, unknown>) => Promise<ZkHandle>;

export function createMemoryZk(): ZkHandle {
  const nodes = new Map<string, string>([["/", ""], ["/e2mcp", "hello zk"]]);
  const watchers = new Map<string, Array<(e: ZkWatchEvent) => void>>();
  const parent = (path: string) => {
    const i = path.lastIndexOf("/");
    return i <= 0 ? "/" : path.slice(0, i);
  };
  const notify = (path: string, type: number) => {
    const list = watchers.get(path) ?? [];
    watchers.set(path, []);
    for (const fn of list) fn({ type, path, state: "SyncConnected" });
  };
  return {
    async ruok() {
      return "imok";
    },
    async exists(path) {
      return { exists: nodes.has(path) };
    },
    async get(path) {
      const data = nodes.get(path);
      if (data === undefined) throw new AdapterError("E_NOT_FOUND", `ZK no node ${path}`, { protocol: "zookeeper" });
      return { path, data };
    },
    async getChildren(path) {
      const prefix = path === "/" ? "/" : `${path}/`;
      const children = [...nodes.keys()]
        .filter((p) => p !== path && p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
        .map((p) => p.slice(prefix.length));
      if (!nodes.has(path) && path !== "/") {
        throw new AdapterError("E_NOT_FOUND", `ZK no node ${path}`, { protocol: "zookeeper" });
      }
      return { path, children };
    },
    async create(path, data) {
      if (nodes.has(path)) throw new AdapterError("E_PROTOCOL", `ZK node exists ${path}`, { protocol: "zookeeper" });
      if (path !== "/" && !nodes.has(parent(path))) {
        throw new AdapterError("E_NOT_FOUND", `ZK no parent for ${path}`, { protocol: "zookeeper" });
      }
      nodes.set(path, data);
      notify(path, EVENT_NODE_CREATED);
      return { path };
    },
    async set(path, data) {
      if (!nodes.has(path)) throw new AdapterError("E_NOT_FOUND", `ZK no node ${path}`, { protocol: "zookeeper" });
      nodes.set(path, data);
      notify(path, EVENT_NODE_DATA);
      return { path };
    },
    async delete(path) {
      if (!nodes.delete(path)) throw new AdapterError("E_NOT_FOUND", `ZK no node ${path}`, { protocol: "zookeeper" });
      notify(path, EVENT_NODE_DELETED);
      return { path, deleted: true as const };
    },
    async watchOnce(path, timeoutMs) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new AdapterError("E_TIMEOUT", "zookeeper watch timeout", { protocol: "zookeeper" })),
          timeoutMs,
        );
        const list = watchers.get(path) ?? [];
        list.push((e) => {
          clearTimeout(timer);
          resolve(e);
        });
        watchers.set(path, list);
      });
    },
    async multi(ops) {
      const results: Array<{ op: string; path: string; ok: boolean }> = [];
      for (const op of ops) {
        try {
          if (op.op === "create") await this.create(op.path, op.data ?? "");
          else if (op.op === "set") await this.set(op.path, op.data ?? "");
          else await this.delete(op.path);
          results.push({ op: op.op, path: op.path, ok: true });
        } catch {
          results.push({ op: op.op, path: op.path, ok: false });
          break;
        }
      }
      return { results };
    },
    async close() {
      nodes.clear();
      watchers.clear();
    },
  };
}

async function readFrame(socket: Socket, timeoutMs: number, leftover: { buf: Buffer; notify?: () => void }): Promise<Buffer> {
  const tryDecode = () => {
    const hit = decodeFrame(leftover.buf);
    if (!hit) return undefined;
    leftover.buf = hit.rest;
    return hit.body;
  };
  const ready = tryDecode();
  if (ready) return ready;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      leftover.notify = undefined;
      reject(new AdapterError("E_TIMEOUT", "zookeeper timeout", { protocol: "zookeeper" }));
    }, timeoutMs);
    leftover.notify = () => {
      const body = tryDecode();
      if (body) {
        leftover.notify = undefined;
        clearTimeout(timer);
        resolve(body);
      }
    };
    socket.once("error", (err) => {
      leftover.notify = undefined;
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function liveZk(config: Record<string, unknown>): Promise<ZkHandle> {
  const host = stringField(config, "host") ?? stringField(config, "url")?.replace(/^zookeeper:\/\//i, "").split(":")[0];
  if (!host) throw new AdapterError("E_INVALID_CONFIG", "zookeeper adapter requires config.host", { protocol: "zookeeper" });
  await assertHostAllowed(host);
  const port = typeof config.port === "number" ? config.port : 2181;
  const timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 4000;
  const socket = await new Promise<Socket>((resolve, reject) => {
    const s = createConnection({ host, port, timeout: timeoutMs }, () => resolve(s));
    s.once("error", reject);
  });
  const leftover: { buf: Buffer; notify?: () => void } = { buf: Buffer.alloc(0) as Buffer };
  socket.on("data", (chunk) => {
    leftover.buf = Buffer.concat([leftover.buf, chunk]);
    leftover.notify?.();
  });
  socket.write(encodeConnectRequest(timeoutMs));
  const conn = await readFrame(socket, timeoutMs, leftover);
  if (conn.length < 16) throw new AdapterError("E_PROTOCOL", "zookeeper connect short", { protocol: "zookeeper" });
  let xid = 1;
  const watchWaiters: Array<(e: ZkWatchEvent) => void> = [];
  const takeReply = async (wantXid: number): Promise<Reader> => {
    for (;;) {
      const reply = await readFrame(socket, timeoutMs, leftover);
      const r = new Reader(reply);
      const rxid = r.i32();
      r.i64();
      const err = r.i32();
      if (rxid === WATCH_XID) {
        const type = r.i32();
        r.i32();
        const path = r.str();
        watchWaiters.shift()?.({ type, path, state: "SyncConnected" });
        continue;
      }
      if (rxid !== wantXid) throw new AdapterError("E_PROTOCOL", `zookeeper xid ${rxid}!=${wantXid}`, { protocol: "zookeeper" });
      if (err === ZK_NONODE) throw new AdapterError("E_NOT_FOUND", "ZK NONODE", { protocol: "zookeeper" });
      if (err !== ZK_OK) throw new AdapterError("E_PROTOCOL", `ZK err ${err}`, { protocol: "zookeeper" });
      return r;
    }
  };
  const rpc = async (type: number, body: Buffer) => {
    const id = xid++;
    socket.write(encodeRequest(id, type, body));
    return takeReply(id);
  };
  return {
    async ruok() {
      const s = await new Promise<Socket>((resolve, reject) => {
        const c = createConnection({ host, port, timeout: timeoutMs }, () => resolve(c));
        c.once("error", reject);
      });
      try {
        const reply = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new AdapterError("E_TIMEOUT", "zk ruok timeout", { protocol: "zookeeper" })), timeoutMs);
          s.once("data", (chunk) => {
            clearTimeout(timer);
            resolve(chunk.toString("utf8"));
          });
          s.once("error", reject);
          s.write("ruok");
        });
        return reply.trim();
      } finally {
        s.destroy();
      }
    },
    async exists(path) {
      try {
        await rpc(OP_EXISTS, Buffer.concat([ustr(path), Buffer.from([0])]));
        return { exists: true };
      } catch (err) {
        if (err instanceof AdapterError && err.code === "E_NOT_FOUND") return { exists: false };
        throw err;
      }
    },
    async get(path) {
      const r = await rpc(OP_GETDATA, Buffer.concat([ustr(path), Buffer.from([0])]));
      return { path, data: r.bytes().toString("utf8") };
    },
    async getChildren(path) {
      const r = await rpc(OP_GETCHILDREN, Buffer.concat([ustr(path), Buffer.from([0])]));
      const n = r.i32();
      const children: string[] = [];
      for (let i = 0; i < n; i++) children.push(r.str());
      return { path, children };
    },
    async create(path, data) {
      const r = await rpc(OP_CREATE, Buffer.concat([ustr(path), bytes(Buffer.from(data, "utf8")), i32(0), i32(0)]));
      return { path: r.str() || path };
    },
    async set(path, data) {
      await rpc(OP_SETDATA, Buffer.concat([ustr(path), bytes(Buffer.from(data, "utf8")), i32(-1)]));
      return { path };
    },
    async delete(path) {
      await rpc(OP_DELETE, Buffer.concat([ustr(path), i32(-1)]));
      return { path, deleted: true as const };
    },
    async watchOnce(path, ms) {
      await rpc(OP_GETDATA, Buffer.concat([ustr(path), Buffer.from([1])]));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new AdapterError("E_TIMEOUT", "zookeeper watch timeout", { protocol: "zookeeper" })),
          ms,
        );
        watchWaiters.push((e) => {
          clearTimeout(timer);
          resolve(e);
        });
        void (async () => {
          try {
            while (watchWaiters.length) {
              const reply = await readFrame(socket, ms, leftover);
              const r = new Reader(reply);
              const rxid = r.i32();
              r.i64();
              r.i32();
              if (rxid !== WATCH_XID) continue;
              const type = r.i32();
              r.i32();
              const p = r.str();
              const waiter = watchWaiters.shift();
              if (waiter) waiter({ type, path: p, state: "SyncConnected" });
            }
          } catch {
            /* timeout surfaced via timer */
          }
        })();
      });
    },
    async multi(ops) {
      const parts: Buffer[] = [];
      for (const op of ops) {
        if (op.op === "create") {
          parts.push(multiHeader(OP_CREATE, false, 0), Buffer.concat([ustr(op.path), bytes(Buffer.from(op.data ?? "", "utf8")), i32(0), i32(0)]));
        } else if (op.op === "set") {
          parts.push(multiHeader(OP_SETDATA, false, 0), Buffer.concat([ustr(op.path), bytes(Buffer.from(op.data ?? "", "utf8")), i32(-1)]));
        } else {
          parts.push(multiHeader(OP_DELETE, false, 0), Buffer.concat([ustr(op.path), i32(-1)]));
        }
      }
      parts.push(multiHeader(-1, true, -1));
      const r = await rpc(OP_MULTI, Buffer.concat(parts));
      const results: Array<{ op: string; path: string; ok: boolean }> = [];
      for (const op of ops) {
        const hdr = readMultiHeader(r);
        if (hdr.done) break;
        if (hdr.type === OP_CREATE) r.str();
        else if (hdr.type === OP_SETDATA) r.o += dummyStat().length;
        results.push({ op: op.op, path: op.path, ok: hdr.err === ZK_OK });
      }
      return { results };
    },
    async close() {
      try {
        socket.write(encodeRequest(xid++, OP_CLOSE, Buffer.alloc(0)));
      } catch {
        /* ignore */
      }
      socket.destroy();
    },
  };
}

async function defaultConnect(config: Record<string, unknown>): Promise<ZkHandle> {
  const host = stringField(config, "host") ?? stringField(config, "url");
  if (config.simulator === true || !host) return createMemoryZk();
  return liveZk(config);
}

function encodeWatchEvent(type: number, path: string): Buffer {
  return frame(Buffer.concat([i32(WATCH_XID), i64(0), i32(ZK_OK), i32(type), i32(3), ustr(path)]));
}

export async function listenZkLoopback(): Promise<{ port: number; close: () => Promise<void> }> {
  const mem = createMemoryZk();
  const watches = new Map<string, Set<Socket>>();
  const addWatch = (socket: Socket, path: string) => {
    const set = watches.get(path) ?? new Set<Socket>();
    set.add(socket);
    watches.set(path, set);
  };
  const fire = (path: string, type: number) => {
    const set = watches.get(path);
    if (!set) return;
    watches.delete(path);
    for (const s of set) {
      try {
        s.write(encodeWatchEvent(type, path));
      } catch {
        /* peer gone */
      }
    }
  };
  const server = createServer((socket) => {
    let buf: Buffer = Buffer.alloc(0);
    let authed = false;
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      void (async () => {
        if (!authed && buf.length >= 4) {
          const four = buf.subarray(0, 4).toString("ascii");
          if (four === "ruok") {
            socket.write("imok");
            socket.end();
            buf = Buffer.alloc(0);
            return;
          }
        }
        for (;;) {
          const hit = decodeFrame(buf);
          if (!hit) return;
          buf = hit.rest;
          if (!authed) {
            socket.write(encodeConnectResponse(1));
            authed = true;
            continue;
          }
          const r = new Reader(hit.body);
          const xid = r.i32();
          const type = r.i32();
          try {
            if (type === OP_GETDATA) {
              const path = r.str();
              const watch = r.buf[r.o] === 1;
              const got = await mem.get(path);
              if (watch) addWatch(socket, path);
              socket.write(encodeReply(xid, ZK_OK, Buffer.concat([bytes(Buffer.from(got.data, "utf8")), dummyStat()])));
            } else if (type === OP_EXISTS) {
              const path = r.str();
              const watch = r.buf[r.o] === 1;
              const ex = await mem.exists(path);
              if (watch) addWatch(socket, path);
              socket.write(encodeReply(xid, ex.exists ? ZK_OK : ZK_NONODE, ex.exists ? dummyStat() : Buffer.alloc(0)));
            } else if (type === OP_GETCHILDREN) {
              const path = r.str();
              const kids = await mem.getChildren(path);
              socket.write(encodeReply(xid, ZK_OK, Buffer.concat([i32(kids.children.length), ...kids.children.map(ustr)])));
            } else if (type === OP_CREATE) {
              const path = r.str();
              const data = r.bytes().toString("utf8");
              const created = await mem.create(path, data);
              fire(path, EVENT_NODE_CREATED);
              socket.write(encodeReply(xid, ZK_OK, ustr(created.path)));
            } else if (type === OP_SETDATA) {
              const path = r.str();
              const data = r.bytes().toString("utf8");
              await mem.set(path, data);
              fire(path, EVENT_NODE_DATA);
              socket.write(encodeReply(xid, ZK_OK, dummyStat()));
            } else if (type === OP_DELETE) {
              const path = r.str();
              await mem.delete(path);
              fire(path, EVENT_NODE_DELETED);
              socket.write(encodeReply(xid, ZK_OK, Buffer.alloc(0)));
            } else if (type === OP_MULTI) {
              const results: Buffer[] = [];
              for (;;) {
                const hdr = readMultiHeader(r);
                if (hdr.done || hdr.type === -1) break;
                try {
                  if (hdr.type === OP_CREATE) {
                    const path = r.str();
                    const data = r.bytes().toString("utf8");
                    skipCreateAclAndFlags(r);
                    await mem.create(path, data);
                    fire(path, EVENT_NODE_CREATED);
                    results.push(Buffer.concat([multiHeader(OP_CREATE, false, 0), ustr(path)]));
                  } else if (hdr.type === OP_SETDATA) {
                    const path = r.str();
                    const data = r.bytes().toString("utf8");
                    r.i32();
                    await mem.set(path, data);
                    fire(path, EVENT_NODE_DATA);
                    results.push(Buffer.concat([multiHeader(OP_SETDATA, false, 0), dummyStat()]));
                  } else if (hdr.type === OP_DELETE) {
                    const path = r.str();
                    r.i32();
                    await mem.delete(path);
                    fire(path, EVENT_NODE_DELETED);
                    results.push(multiHeader(OP_DELETE, false, 0));
                  } else {
                    results.push(multiHeader(hdr.type, false, -1));
                    break;
                  }
                } catch {
                  results.push(multiHeader(hdr.type, false, ZK_NONODE));
                  break;
                }
              }
              results.push(multiHeader(-1, true, -1));
              socket.write(encodeReply(xid, ZK_OK, Buffer.concat(results)));
            } else if (type === OP_CLOSE) {
              socket.end();
            } else {
              socket.write(encodeReply(xid, ZK_OK, Buffer.alloc(0)));
            }
          } catch (err) {
            const code = err instanceof AdapterError && err.code === "E_NOT_FOUND" ? ZK_NONODE : -1;
            socket.write(encodeReply(xid, code, Buffer.alloc(0)));
          }
        }
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as { port: number }).port, close: () => new Promise((r) => { server.close(() => r()); (server as { closeAllConnections?: () => void }).closeAllConnections?.(); }) };
}

/** ZooKeeper: ruok + binary connect/get/create + one-shot watch + MULTI. ACL/SASL E_UNSUPPORTED. */
export class ZookeeperAdapter implements ProtocolAdapter {
  readonly protocol = "zookeeper";
  private handle: ZkHandle | undefined;
  private connected = false;
  private allowWrite = false;

  constructor(
    readonly id: string,
    private readonly connectFn: ZkConnectFn = defaultConnect,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    this.allowWrite = allowWriteFrom(config);
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
        name: "ruok",
        description: "four-letter ruok",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "exists",
        description: "exists path",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
      },
      {
        name: "get",
        description: "getData",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
      },
      {
        name: "get_children",
        description: "getChildren",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
      },
      {
        name: "create",
        description: "create znode (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" }, data: { type: "string", default: "" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
      {
        name: "set",
        description: "setData (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" }, data: { type: "string" } },
          required: ["path", "data"],
          additionalProperties: false,
        },
      },
      {
        name: "delete",
        description: "delete znode (requires allowWrite=true)",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
      },
      {
        name: "watch_once",
        description: "one-shot data watch (GETDATA watch=1); not persistent session watchers",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" }, timeoutMs: { type: "integer", default: 1500 } },
          required: ["path"],
          additionalProperties: false,
        },
      },
      {
        name: "multi",
        description: "MULTI create/set/delete (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: {
            ops: {
              type: "array",
              items: { type: "object", additionalProperties: true },
              description: "{ op: create|set|delete, path, data? }",
            },
          },
          required: ["ops"],
          additionalProperties: false,
        },
      },
      {
        name: "set_acl",
        description: "ACL is E_UNSUPPORTED",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
      },
      {
        name: "add_auth",
        description: "SASL/auth is E_UNSUPPORTED",
        inputSchema: { type: "object", properties: { scheme: { type: "string" } }, additionalProperties: false },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const h = this.handle!;
    if (toolName === "ruok") return { reply: await h.ruok() };
    if (toolName === "exists") return h.exists(requiredString(args, "path"));
    if (toolName === "get") return h.get(requiredString(args, "path"));
    if (toolName === "get_children") return h.getChildren(requiredString(args, "path"));
    if (toolName === "create") {
      assertCanWrite("zookeeper", this.allowWrite);
      return h.create(requiredString(args, "path"), typeof args.data === "string" ? args.data : "");
    }
    if (toolName === "set") {
      assertCanWrite("zookeeper", this.allowWrite);
      return h.set(requiredString(args, "path"), requiredString(args, "data"));
    }
    if (toolName === "delete") {
      assertCanWrite("zookeeper", this.allowWrite);
      return h.delete(requiredString(args, "path"));
    }
    if (toolName === "watch_once") {
      if (!h.watchOnce) throw new AdapterError("E_UNSUPPORTED", "ZK handle has no watch", { protocol: "zookeeper" });
      const ms = typeof args.timeoutMs === "number" ? args.timeoutMs : 1500;
      return h.watchOnce(requiredString(args, "path"), ms);
    }
    if (toolName === "multi") {
      assertCanWrite("zookeeper", this.allowWrite);
      if (!h.multi) throw new AdapterError("E_UNSUPPORTED", "ZK handle has no multi", { protocol: "zookeeper" });
      const raw = Array.isArray(args.ops) ? args.ops : [];
      const ops: ZkMultiOp[] = raw
        .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object")
        .map((rec): ZkMultiOp => ({
          op: rec.op === "set" || rec.op === "delete" ? rec.op : "create",
          path: String(rec.path ?? ""),
          data: typeof rec.data === "string" ? rec.data : "",
        }))
        .filter((o) => o.path);
      return h.multi(ops);
    }
    if (toolName === "set_acl" || toolName === "add_auth") {
      throw new AdapterError("E_UNSUPPORTED", "ZooKeeper ACL/SASL is not implemented", { protocol: "zookeeper" });
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown tool: ${toolName}`, { protocol: "zookeeper" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected || !this.handle) return { ok: false, detail: "not connected" };
    try {
      const r = await this.handle.ruok();
      return { ok: r.includes("imok"), detail: `zookeeper ${r}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_INVALID_CONFIG", "zookeeper adapter is not connected", { protocol: "zookeeper" });
    }
  }
}
