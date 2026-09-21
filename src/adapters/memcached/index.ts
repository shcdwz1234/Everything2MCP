import { createConnection, createServer, type Socket } from "node:net";
import { AdapterError } from "../../runtime/errors.js";
import { assertHostAllowed } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";
import { requiredString, stringField } from "../helpers.js";

export interface MemcachedHandle {
  get(key: string): Promise<{ key: string; value: string } | undefined>;
  set(key: string, value: string): Promise<{ stored: true }>;
  del(key: string): Promise<{ deleted: boolean }>;
  stats(): Promise<Record<string, string>>;
  close(): Promise<void>;
}

export type MemcachedConnectFn = (config: Record<string, unknown>) => Promise<MemcachedHandle>;

export function createMemoryMemcached(): MemcachedHandle {
  const kv = new Map<string, string>();
  return {
    async get(key) {
      const value = kv.get(key);
      return value === undefined ? undefined : { key, value };
    },
    async set(key, value) {
      kv.set(key, value);
      return { stored: true };
    },
    async del(key) {
      return { deleted: kv.delete(key) };
    },
    async stats() {
      return { curr_items: String(kv.size), version: "e2mcp-memcached" };
    },
    async close() {
      kv.clear();
    },
  };
}

class LineSock {
  private leftover = Buffer.alloc(0);
  constructor(private readonly socket: Socket) {}
  write(line: string): void {
    this.socket.write(`${line}\r\n`);
  }
  writeRaw(buf: Buffer): void {
    this.socket.write(buf);
  }
  async readLine(timeoutMs: number): Promise<string> {
    const nl = this.leftover.indexOf(0x0a);
    if (nl >= 0) {
      const line = this.leftover.subarray(0, nl).toString("utf8").replace(/\r$/, "");
      this.leftover = this.leftover.subarray(nl + 1);
      return line;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new AdapterError("E_TIMEOUT", "memcached timeout", { protocol: "memcached" })), timeoutMs);
      const onData = (chunk: Buffer) => {
        this.leftover = Buffer.concat([this.leftover, chunk]);
        const i = this.leftover.indexOf(0x0a);
        if (i >= 0) {
          this.socket.off("data", onData);
          clearTimeout(timer);
          resolve(this.readLine(timeoutMs));
        }
      };
      this.socket.on("data", onData);
      this.socket.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
  async readExact(n: number, timeoutMs: number): Promise<Buffer> {
    if (this.leftover.length >= n) {
      const out = this.leftover.subarray(0, n);
      this.leftover = this.leftover.subarray(n);
      return out;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new AdapterError("E_TIMEOUT", "memcached timeout", { protocol: "memcached" })), timeoutMs);
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

async function liveMemcached(config: Record<string, unknown>): Promise<MemcachedHandle> {
  const host = stringField(config, "host") ?? stringField(config, "url")?.replace(/^memcached:\/\//i, "").split(":")[0];
  if (!host) throw new AdapterError("E_INVALID_CONFIG", "memcached adapter requires config.host", { protocol: "memcached" });
  await assertHostAllowed(host);
  const port = typeof config.port === "number" ? config.port : 11211;
  const timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 4000;
  const socket = await new Promise<Socket>((resolve, reject) => {
    const s = createConnection({ host, port, timeout: timeoutMs }, () => resolve(s));
    s.once("error", reject);
  });
  const io = new LineSock(socket);
  return {
    async get(key) {
      io.write(`get ${key}`);
      const header = await io.readLine(timeoutMs);
      if (header === "END") return undefined;
      const m = header.match(/^VALUE\s+(\S+)\s+\d+\s+(\d+)/);
      if (!m) throw new AdapterError("E_PROTOCOL", `memcached GET: ${header}`, { protocol: "memcached" });
      const bytes = Number(m[2]);
      const body = await io.readExact(bytes, timeoutMs);
      await io.readLine(timeoutMs);
      const end = await io.readLine(timeoutMs);
      if (end !== "END") throw new AdapterError("E_PROTOCOL", `memcached GET end: ${end}`, { protocol: "memcached" });
      return { key, value: body.toString("utf8") };
    },
    async set(key, value) {
      const raw = Buffer.from(value, "utf8");
      io.write(`set ${key} 0 0 ${raw.length}`);
      io.writeRaw(Buffer.concat([raw, Buffer.from("\r\n")]));
      const line = await io.readLine(timeoutMs);
      if (line !== "STORED") throw new AdapterError("E_PROTOCOL", `memcached SET: ${line}`, { protocol: "memcached" });
      return { stored: true };
    },
    async del(key) {
      io.write(`delete ${key}`);
      const line = await io.readLine(timeoutMs);
      return { deleted: line === "DELETED" };
    },
    async stats() {
      io.write("stats");
      const out: Record<string, string> = {};
      for (;;) {
        const line = await io.readLine(timeoutMs);
        if (line === "END") break;
        const m = line.match(/^STAT\s+(\S+)\s+(.*)$/);
        if (m) out[m[1]!] = m[2] ?? "";
      }
      return out;
    },
    async close() {
      try {
        io.write("quit");
      } catch {
        /* ignore */
      }
      socket.destroy();
    },
  };
}

async function defaultConnect(config: Record<string, unknown>): Promise<MemcachedHandle> {
  const host = stringField(config, "host") ?? stringField(config, "url");
  if (config.simulator === true || !host) return createMemoryMemcached();
  return liveMemcached(config);
}

export async function listenMemcachedLoopback(): Promise<{ port: number; close: () => Promise<void> }> {
  const mem = createMemoryMemcached();
  const server = createServer((socket) => {
    let buf = "";
    let pending: { key: string; bytes: number } | undefined;
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      void (async () => {
        for (;;) {
          if (pending) {
            if (buf.length < pending.bytes) return;
            const value = buf.slice(0, pending.bytes);
            buf = buf.slice(pending.bytes).replace(/^\r?\n/, "");
            await mem.set(pending.key, value);
            pending = undefined;
            socket.write("STORED\r\n");
            continue;
          }
          const idx = buf.indexOf("\n");
          if (idx < 0) return;
          const line = buf.slice(0, idx).replace(/\r$/, "");
          buf = buf.slice(idx + 1);
          const [cmd, a, , , d] = line.split(/\s+/);
          const c = (cmd ?? "").toLowerCase();
          if (c === "get") {
            const hit = await mem.get(a ?? "");
            if (hit) {
              const raw = Buffer.from(hit.value, "utf8");
              socket.write(`VALUE ${hit.key} 0 ${raw.length}\r\n`);
              socket.write(raw);
              socket.write("\r\n");
            }
            socket.write("END\r\n");
          } else if (c === "set") {
            pending = { key: a ?? "", bytes: Number(d ?? 0) };
          } else if (c === "delete") {
            const del = await mem.del(a ?? "");
            socket.write(del.deleted ? "DELETED\r\n" : "NOT_FOUND\r\n");
          } else if (c === "stats") {
            const st = await mem.stats();
            for (const [k, v] of Object.entries(st)) socket.write(`STAT ${k} ${v}\r\n`);
            socket.write("END\r\n");
          } else if (c === "quit") {
            socket.end();
          } else socket.write("ERROR\r\n");
        }
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as { port: number }).port, close: () => new Promise((r) => server.close(() => r())) };
}

/** Memcached text protocol GET/SET/DELETE/STATS. Writes need allowWrite. */
export class MemcachedAdapter implements ProtocolAdapter {
  readonly protocol = "memcached";
  private handle: MemcachedHandle | undefined;
  private connected = false;
  private allowWrite = false;

  constructor(
    readonly id: string,
    private readonly connectFn: MemcachedConnectFn = defaultConnect,
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
        name: "get",
        description: "GET a key",
        inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"], additionalProperties: false },
      },
      {
        name: "set",
        description: "SET a key (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: { key: { type: "string" }, value: { type: "string" } },
          required: ["key", "value"],
          additionalProperties: false,
        },
      },
      {
        name: "delete",
        description: "DELETE a key (requires allowWrite=true)",
        inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"], additionalProperties: false },
      },
      {
        name: "stats",
        description: "STATS",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const h = this.handle!;
    if (toolName === "get") return (await h.get(requiredString(args, "key"))) ?? { missing: true };
    if (toolName === "set") {
      assertCanWrite("memcached", this.allowWrite);
      return h.set(requiredString(args, "key"), requiredString(args, "value"));
    }
    if (toolName === "delete") {
      assertCanWrite("memcached", this.allowWrite);
      return h.del(requiredString(args, "key"));
    }
    if (toolName === "stats") return { stats: await h.stats() };
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown tool: ${toolName}`, { protocol: "memcached" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected || !this.handle) return { ok: false, detail: "not connected" };
    try {
      await this.handle.stats();
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_INVALID_CONFIG", "memcached adapter is not connected", { protocol: "memcached" });
    }
  }
}
