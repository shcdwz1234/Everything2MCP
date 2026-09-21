import { createConnection, createServer, type Socket } from "node:net";
import { AdapterError } from "../../runtime/errors.js";
import { assertHostAllowed } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";
import { requiredString, stringField } from "../helpers.js";

export interface BeanstalkJob {
  id: number;
  body: string;
  tube: string;
}

export interface BeanstalkHandle {
  stats(): Promise<Record<string, string>>;
  listTubes(): Promise<string[]>;
  peek(): Promise<BeanstalkJob | undefined>;
  put(body: string, tube?: string): Promise<{ id: number }>;
  reserve(timeoutSec?: number): Promise<BeanstalkJob>;
  delete(id: number): Promise<{ deleted: true }>;
  close(): Promise<void>;
}

export type BeanstalkConnectFn = (config: Record<string, unknown>) => Promise<BeanstalkHandle>;

export function createMemoryBeanstalk(): BeanstalkHandle {
  const ready: BeanstalkJob[] = [];
  let seq = 1;
  let tube = "default";
  return {
    async stats() {
      return { "current-jobs-ready": String(ready.length), "current-tubes": "1", version: "e2mcp-beanstalkd" };
    },
    async listTubes() {
      return [...new Set(["default", ...ready.map((j) => j.tube), tube])];
    },
    async peek() {
      return ready[0];
    },
    async put(body, named) {
      const job = { id: seq++, body, tube: named ?? tube };
      ready.push(job);
      return { id: job.id };
    },
    async reserve() {
      const job = ready.shift();
      if (!job) throw new AdapterError("E_TIMEOUT", "beanstalkd TIMED_OUT", { protocol: "beanstalkd" });
      return job;
    },
    async delete(id) {
      const i = ready.findIndex((j) => j.id === id);
      if (i >= 0) ready.splice(i, 1);
      return { deleted: true as const };
    },
    async close() {
      ready.length = 0;
    },
  };
}

class LineSock {
  private leftover = "";
  constructor(private socket: Socket) {}
  write(line: string): void {
    this.socket.write(`${line}\r\n`);
  }
  writeRaw(buf: Buffer): void {
    this.socket.write(buf);
  }
  async readLine(timeoutMs: number): Promise<string> {
    if (this.leftover.includes("\n")) {
      const i = this.leftover.indexOf("\n");
      const line = this.leftover.slice(0, i).replace(/\r$/, "");
      this.leftover = this.leftover.slice(i + 1);
      return line;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new AdapterError("E_TIMEOUT", "beanstalkd timeout", { protocol: "beanstalkd" })),
        timeoutMs,
      );
      const onData = (chunk: Buffer) => {
        this.leftover += chunk.toString("utf8");
        if (this.leftover.includes("\n")) {
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
    const take = (): Buffer | undefined => {
      const buf = Buffer.from(this.leftover, "utf8");
      if (buf.length >= n) {
        const out = buf.subarray(0, n);
        this.leftover = buf.subarray(n).toString("utf8").replace(/^\r?\n/, "");
        return out;
      }
      return undefined;
    };
    const hit = take();
    if (hit) return hit;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new AdapterError("E_TIMEOUT", "beanstalkd timeout", { protocol: "beanstalkd" })),
        timeoutMs,
      );
      const onData = (chunk: Buffer) => {
        this.leftover += chunk.toString("utf8");
        const got = take();
        if (got) {
          this.socket.off("data", onData);
          clearTimeout(timer);
          resolve(got);
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

async function yamlBlock(io: LineSock, timeoutMs: number): Promise<string> {
  const header = await io.readLine(timeoutMs);
  const m = header.match(/^OK\s+(\d+)/);
  if (!m) throw new AdapterError("E_PROTOCOL", `beanstalkd: ${header}`, { protocol: "beanstalkd" });
  const raw = await io.readExact(Number(m[1]), timeoutMs);
  return raw.toString("utf8");
}

async function liveBeanstalk(config: Record<string, unknown>): Promise<BeanstalkHandle> {
  const host = stringField(config, "host") ?? stringField(config, "url")?.replace(/^beanstalkd?:\/\//i, "").split(":")[0];
  if (!host) throw new AdapterError("E_INVALID_CONFIG", "beanstalkd adapter requires config.host", { protocol: "beanstalkd" });
  await assertHostAllowed(host);
  const port = typeof config.port === "number" ? config.port : 11300;
  const timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 4000;
  const socket = await new Promise<Socket>((resolve, reject) => {
    const s = createConnection({ host, port, timeout: timeoutMs }, () => resolve(s));
    s.once("error", reject);
  });
  const io = new LineSock(socket);
  let tube = stringField(config, "tube") ?? "default";
  const use = async (name: string) => {
    io.write(`use ${name}`);
    const line = await io.readLine(timeoutMs);
    if (!line.startsWith("USING")) throw new AdapterError("E_PROTOCOL", `beanstalkd USE: ${line}`, { protocol: "beanstalkd" });
    tube = name;
  };
  await use(tube);
  return {
    async stats() {
      io.write("stats");
      const yaml = await yamlBlock(io, timeoutMs);
      const out: Record<string, string> = {};
      for (const line of yaml.split(/\r?\n/)) {
        const m = line.match(/^([^:]+):\s*(.*)$/);
        if (m) out[m[1]!.trim()] = m[2]!.trim();
      }
      return out;
    },
    async listTubes() {
      io.write("list-tubes");
      const yaml = await yamlBlock(io, timeoutMs);
      return yaml
        .split(/\r?\n/)
        .map((l) => l.replace(/^- /, "").trim())
        .filter(Boolean);
    },
    async peek() {
      io.write("peek-ready");
      const header = await io.readLine(timeoutMs);
      if (header.startsWith("NOT_FOUND")) return undefined;
      const m = header.match(/^FOUND\s+(\d+)\s+(\d+)/);
      if (!m) throw new AdapterError("E_PROTOCOL", `beanstalkd PEEK: ${header}`, { protocol: "beanstalkd" });
      const body = (await io.readExact(Number(m[2]), timeoutMs)).toString("utf8");
      return { id: Number(m[1]), body, tube };
    },
    async put(body, named) {
      if (named && named !== tube) await use(named);
      const raw = Buffer.from(body, "utf8");
      io.write(`put 0 0 60 ${raw.length}`);
      io.writeRaw(Buffer.concat([raw, Buffer.from("\r\n")]));
      const line = await io.readLine(timeoutMs);
      const m = line.match(/^INSERTED\s+(\d+)/);
      if (!m) throw new AdapterError("E_PROTOCOL", `beanstalkd PUT: ${line}`, { protocol: "beanstalkd" });
      return { id: Number(m[1]) };
    },
    async reserve(timeoutSec = 0) {
      io.write(`reserve-with-timeout ${timeoutSec}`);
      const header = await io.readLine(timeoutMs);
      if (header.startsWith("TIMED_OUT")) {
        throw new AdapterError("E_TIMEOUT", "beanstalkd TIMED_OUT", { protocol: "beanstalkd" });
      }
      const m = header.match(/^RESERVED\s+(\d+)\s+(\d+)/);
      if (!m) throw new AdapterError("E_PROTOCOL", `beanstalkd RESERVE: ${header}`, { protocol: "beanstalkd" });
      const body = (await io.readExact(Number(m[2]), timeoutMs)).toString("utf8");
      return { id: Number(m[1]), body, tube };
    },
    async delete(id) {
      io.write(`delete ${id}`);
      const line = await io.readLine(timeoutMs);
      if (!line.startsWith("DELETED") && !line.startsWith("NOT_FOUND")) {
        throw new AdapterError("E_PROTOCOL", `beanstalkd DELETE: ${line}`, { protocol: "beanstalkd" });
      }
      return { deleted: true as const };
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

async function defaultConnect(config: Record<string, unknown>): Promise<BeanstalkHandle> {
  const host = stringField(config, "host") ?? stringField(config, "url");
  if (config.simulator === true || !host) return createMemoryBeanstalk();
  return liveBeanstalk(config);
}

export async function listenBeanstalkLoopback(): Promise<{ port: number; close: () => Promise<void> }> {
  const mem = createMemoryBeanstalk();
  const reserved = new Map<number, BeanstalkJob>();
  const server = createServer((socket) => {
    let buf = "";
    let pending: { bytes: number } | undefined;
    let tube = "default";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      void (async () => {
        for (;;) {
          if (pending) {
            if (Buffer.byteLength(buf) < pending.bytes) return;
            const raw = Buffer.from(buf, "utf8").subarray(0, pending.bytes).toString("utf8");
            buf = Buffer.from(buf, "utf8").subarray(pending.bytes).toString("utf8").replace(/^\r?\n/, "");
            const { id } = await mem.put(raw, tube);
            socket.write(`INSERTED ${id}\r\n`);
            pending = undefined;
            continue;
          }
          const idx = buf.indexOf("\n");
          if (idx < 0) return;
          const line = buf.slice(0, idx).replace(/\r$/, "");
          buf = buf.slice(idx + 1);
          const parts = line.split(/\s+/);
          const cmd = (parts[0] ?? "").toLowerCase();
          if (cmd === "stats") {
            const st = await mem.stats();
            const yaml = Object.entries(st)
              .map(([k, v]) => `${k}: ${v}`)
              .join("\n");
            const body = `${yaml}\n`;
            socket.write(`OK ${Buffer.byteLength(body)}\r\n${body}`);
          } else if (cmd === "list-tubes") {
            const tubes = await mem.listTubes();
            const yaml = `${tubes.map((t) => `- ${t}`).join("\n")}\n`;
            socket.write(`OK ${Buffer.byteLength(yaml)}\r\n${yaml}`);
          } else if (cmd === "use") {
            tube = parts[1] ?? "default";
            socket.write(`USING ${tube}\r\n`);
          } else if (cmd === "watch") {
            socket.write(`WATCHING 1\r\n`);
          } else if (cmd === "put") {
            pending = { bytes: Number(parts[4] ?? 0) };
          } else if (cmd === "peek-ready") {
            const job = await mem.peek();
            if (!job) socket.write("NOT_FOUND\r\n");
            else {
              const raw = Buffer.from(job.body, "utf8");
              socket.write(`FOUND ${job.id} ${raw.length}\r\n`);
              socket.write(raw);
              socket.write("\r\n");
            }
          } else if (cmd === "reserve" || cmd === "reserve-with-timeout") {
            try {
              const job = await mem.reserve();
              reserved.set(job.id, job);
              const raw = Buffer.from(job.body, "utf8");
              socket.write(`RESERVED ${job.id} ${raw.length}\r\n`);
              socket.write(raw);
              socket.write("\r\n");
            } catch {
              socket.write("TIMED_OUT\r\n");
            }
          } else if (cmd === "delete") {
            const id = Number(parts[1]);
            reserved.delete(id);
            await mem.delete(id);
            socket.write("DELETED\r\n");
          } else if (cmd === "quit") {
            socket.end();
          } else socket.write("UNKNOWN_COMMAND\r\n");
        }
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as { port: number }).port, close: () => new Promise((r) => { server.close(() => r()); (server as { closeAllConnections?: () => void }).closeAllConnections?.(); }) };
}

/** Beanstalkd text protocol put/reserve/delete/stats. Writes need allowWrite. */
export class BeanstalkdAdapter implements ProtocolAdapter {
  readonly protocol = "beanstalkd";
  private handle: BeanstalkHandle | undefined;
  private connected = false;
  private allowWrite = false;

  constructor(
    readonly id: string,
    private readonly connectFn: BeanstalkConnectFn = defaultConnect,
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
        name: "stats",
        description: "beanstalkd stats",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "list_tubes",
        description: "list-tubes",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "peek",
        description: "peek-ready without reserving",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "put",
        description: "put a job (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: { body: { type: "string" }, tube: { type: "string" } },
          required: ["body"],
          additionalProperties: false,
        },
      },
      {
        name: "reserve",
        description: "reserve a job (requires allowWrite=true; mutates ready queue)",
        inputSchema: {
          type: "object",
          properties: { timeoutSec: { type: "integer", default: 0 } },
          additionalProperties: false,
        },
      },
      {
        name: "delete",
        description: "delete a job (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: { id: { type: "integer" } },
          required: ["id"],
          additionalProperties: false,
        },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const h = this.handle!;
    if (toolName === "stats") return { stats: await h.stats() };
    if (toolName === "list_tubes") return { tubes: await h.listTubes() };
    if (toolName === "peek") {
      const job = await h.peek();
      return job ?? { empty: true };
    }
    if (toolName === "put") {
      assertCanWrite("beanstalkd", this.allowWrite);
      return h.put(requiredString(args, "body"), typeof args.tube === "string" ? args.tube : undefined);
    }
    if (toolName === "reserve") {
      assertCanWrite("beanstalkd", this.allowWrite);
      const timeoutSec = typeof args.timeoutSec === "number" ? args.timeoutSec : 0;
      return h.reserve(timeoutSec);
    }
    if (toolName === "delete") {
      assertCanWrite("beanstalkd", this.allowWrite);
      const id = typeof args.id === "number" ? args.id : Number(args.id);
      return h.delete(id);
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown tool: ${toolName}`, { protocol: "beanstalkd" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected || !this.handle) return { ok: false, detail: "not connected" };
    try {
      await this.handle.stats();
      return { ok: true, detail: "beanstalkd" };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_INVALID_CONFIG", "beanstalkd adapter is not connected", { protocol: "beanstalkd" });
    }
  }
}
