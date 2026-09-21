import { createConnection, createServer, type Socket } from "node:net";
import { AdapterError } from "../../runtime/errors.js";
import { assertHostAllowed } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";
import { stringField } from "../helpers.js";

export interface Pop3Message {
  id: number;
  raw: string;
  deleted?: boolean;
}

export interface Pop3Handle {
  stat(): Promise<{ count: number; octets: number }>;
  list(): Promise<Array<{ id: number; octets: number }>>;
  retr(id: number): Promise<{ id: number; raw: string }>;
  dele(id: number): Promise<{ id: number; deleted: true }>;
  rset(): Promise<{ reset: true }>;
  close(): Promise<void>;
}

export type Pop3ConnectFn = (config: Record<string, unknown>) => Promise<Pop3Handle>;

export function createMemoryPop3(): Pop3Handle {
  const msgs: Pop3Message[] = [{ id: 1, raw: "From: a@b\r\nSubject: pop\r\n\r\nhello pop3" }];
  return {
    async stat() {
      const live = msgs.filter((m) => !m.deleted);
      return { count: live.length, octets: live.reduce((n, m) => n + Buffer.byteLength(m.raw), 0) };
    },
    async list() {
      return msgs.filter((m) => !m.deleted).map((m) => ({ id: m.id, octets: Buffer.byteLength(m.raw) }));
    },
    async retr(id) {
      const hit = msgs.find((m) => m.id === id && !m.deleted);
      if (!hit) throw new AdapterError("E_NOT_FOUND", `POP3 no such message ${id}`, { protocol: "pop3" });
      return { id, raw: hit.raw };
    },
    async dele(id) {
      const hit = msgs.find((m) => m.id === id);
      if (!hit) throw new AdapterError("E_NOT_FOUND", `POP3 no such message ${id}`, { protocol: "pop3" });
      hit.deleted = true;
      return { id, deleted: true };
    },
    async rset() {
      for (const m of msgs) m.deleted = false;
      return { reset: true };
    },
    async close() {
      msgs.length = 0;
    },
  };
}

class LineSock {
  private buf = "";
  private waiter: { resolve: (line: string) => void; reject: (err: unknown) => void; timer: NodeJS.Timeout } | undefined;
  constructor(private readonly socket: Socket) {
    this.socket.on("data", (chunk: Buffer) => {
      this.buf += chunk.toString("utf8");
      this.flush();
    });
    this.socket.on("error", (err) => {
      this.waiter?.reject(err);
      this.waiter = undefined;
    });
  }
  write(line: string): void {
    this.socket.write(`${line}\r\n`);
  }
  private flush(): void {
    if (!this.waiter || !this.buf.includes("\n")) return;
    const i = this.buf.indexOf("\n");
    const line = this.buf.slice(0, i).replace(/\r$/, "");
    this.buf = this.buf.slice(i + 1);
    const { resolve, timer } = this.waiter;
    this.waiter = undefined;
    clearTimeout(timer);
    resolve(line);
  }
  async readLine(timeoutMs: number): Promise<string> {
    if (this.buf.includes("\n")) {
      const i = this.buf.indexOf("\n");
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      return line;
    }
    return new Promise((resolve, reject) => {
      this.waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiter = undefined;
          reject(new AdapterError("E_TIMEOUT", "POP3 timeout", { protocol: "pop3" }));
        }, timeoutMs),
      };
    });
  }
}

async function expectOk(io: LineSock, timeoutMs: number): Promise<string> {
  const line = await io.readLine(timeoutMs);
  if (!line.startsWith("+OK")) throw new AdapterError("E_PROTOCOL", `POP3: ${line}`, { protocol: "pop3" });
  return line;
}

async function readMultiline(io: LineSock, timeoutMs: number): Promise<string[]> {
  const lines: string[] = [];
  for (;;) {
    const line = await io.readLine(timeoutMs);
    if (line === ".") break;
    lines.push(line.startsWith("..") ? line.slice(1) : line);
  }
  return lines;
}

async function livePop3(config: Record<string, unknown>): Promise<Pop3Handle> {
  const host = stringField(config, "host") ?? stringField(config, "url")?.replace(/^pop3s?:\/\//i, "").split(":")[0];
  if (!host) throw new AdapterError("E_INVALID_CONFIG", "POP3 adapter requires config.host", { protocol: "pop3" });
  await assertHostAllowed(host);
  const port = typeof config.port === "number" ? config.port : 110;
  const timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 4000;
  const user = stringField(config, "user") ?? stringField(config, "username") ?? "anonymous";
  const pass = stringField(config, "password") ?? stringField(config, "pass") ?? "";
  const socket = await new Promise<Socket>((resolve, reject) => {
    const s = createConnection({ host, port, timeout: timeoutMs }, () => resolve(s));
    s.once("error", reject);
  });
  const io = new LineSock(socket);
  await expectOk(io, timeoutMs);
  io.write(`USER ${user}`);
  await expectOk(io, timeoutMs);
  io.write(`PASS ${pass}`);
  await expectOk(io, timeoutMs);
  return {
    async stat() {
      io.write("STAT");
      const line = await expectOk(io, timeoutMs);
      const p = line.split(/\s+/);
      return { count: Number(p[1] ?? 0), octets: Number(p[2] ?? 0) };
    },
    async list() {
      io.write("LIST");
      await expectOk(io, timeoutMs);
      const lines = await readMultiline(io, timeoutMs);
      return lines.map((l) => {
        const [id, octets] = l.split(/\s+/);
        return { id: Number(id), octets: Number(octets ?? 0) };
      });
    },
    async retr(id) {
      io.write(`RETR ${id}`);
      await expectOk(io, timeoutMs);
      const raw = (await readMultiline(io, timeoutMs)).join("\r\n");
      return { id, raw };
    },
    async dele(id) {
      io.write(`DELE ${id}`);
      await expectOk(io, timeoutMs);
      return { id, deleted: true };
    },
    async rset() {
      io.write("RSET");
      await expectOk(io, timeoutMs);
      return { reset: true };
    },
    async close() {
      try {
        io.write("QUIT");
      } catch {
        /* ignore */
      }
      socket.destroy();
    },
  };
}

async function defaultConnect(config: Record<string, unknown>): Promise<Pop3Handle> {
  const host = stringField(config, "host") ?? stringField(config, "url");
  if (config.simulator === true || !host) return createMemoryPop3();
  return livePop3(config);
}

export async function listenPop3Loopback(): Promise<{ port: number; close: () => Promise<void> }> {
  const mem = createMemoryPop3();
  const server = createServer((socket) => {
    let buf = "";
    socket.write("+OK POP3 e2mcp ready\r\n");
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        const [cmd, arg] = line.split(/\s+/);
        const c = (cmd ?? "").toUpperCase();
        void (async () => {
          if (c === "USER" || c === "PASS") socket.write("+OK\r\n");
          else if (c === "STAT") {
            const s = await mem.stat();
            socket.write(`+OK ${s.count} ${s.octets}\r\n`);
          } else if (c === "LIST") {
            socket.write("+OK scan\r\n");
            for (const m of await mem.list()) socket.write(`${m.id} ${m.octets}\r\n`);
            socket.write(".\r\n");
          } else if (c === "RETR") {
            const msg = await mem.retr(Number(arg));
            socket.write("+OK\r\n");
            socket.write(`${msg.raw.replace(/^\./gm, "..")}\r\n.\r\n`);
          } else if (c === "DELE") {
            await mem.dele(Number(arg));
            socket.write("+OK deleted\r\n");
          } else if (c === "RSET") {
            await mem.rset();
            socket.write("+OK\r\n");
          } else if (c === "QUIT") {
            socket.write("+OK bye\r\n");
            socket.end();
          } else socket.write("-ERR\r\n");
        })();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { port, close: () => new Promise((r) => server.close(() => r())) };
}

/** POP3 STAT/LIST/RETR. DELE/RSET require allowWrite. Not SMTP send. */
export class Pop3Adapter implements ProtocolAdapter {
  readonly protocol = "pop3";
  private handle: Pop3Handle | undefined;
  private connected = false;
  private allowWrite = false;

  constructor(
    readonly id: string,
    private readonly connectFn: Pop3ConnectFn = defaultConnect,
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
        name: "stat",
        description: "STAT message count / octets",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "list",
        description: "LIST message ids",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "retr",
        description: "RETR a message (read; not SMTP)",
        inputSchema: {
          type: "object",
          properties: { id: { type: "integer" } },
          required: ["id"],
          additionalProperties: false,
        },
      },
      {
        name: "dele",
        description: "DELE mark deleted (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: { id: { type: "integer" } },
          required: ["id"],
          additionalProperties: false,
        },
      },
      {
        name: "rset",
        description: "RSET undelete (requires allowWrite=true)",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const h = this.handle!;
    if (toolName === "stat") return h.stat();
    if (toolName === "list") return { messages: await h.list() };
    if (toolName === "retr") return h.retr(Number(args.id));
    if (toolName === "dele") {
      assertCanWrite("pop3", this.allowWrite);
      return h.dele(Number(args.id));
    }
    if (toolName === "rset") {
      assertCanWrite("pop3", this.allowWrite);
      return h.rset();
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown tool: ${toolName}`, { protocol: "pop3" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected || !this.handle) return { ok: false, detail: "not connected" };
    try {
      await this.handle.stat();
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_INVALID_CONFIG", "POP3 adapter is not connected", { protocol: "pop3" });
    }
  }
}
