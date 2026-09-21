import { createConnection, createServer, type Server, type Socket } from "node:net";
import { AdapterError } from "../../runtime/errors.js";
import { assertHostAllowed } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";
import { requiredString, stringField } from "../helpers.js";

export interface FtpHandle {
  list(path: string): Promise<string[]>;
  retr(path: string): Promise<{ path: string; body: string }>;
  stor(path: string, body: string): Promise<{ path: string; size: number }>;
  dele(path: string): Promise<{ path: string; deleted: true }>;
  close(): Promise<void>;
}

export type FtpConnectFn = (config: Record<string, unknown>) => Promise<FtpHandle>;

export function createMemoryFtp(): FtpHandle {
  const files = new Map<string, string>();
  return {
    async list(path) {
      const prefix = path.replace(/\/+$/, "") || "";
      return [...files.keys()]
        .filter((p) => (prefix ? p === prefix || p.startsWith(`${prefix}/`) : true))
        .sort();
    },
    async retr(path) {
      const body = files.get(path);
      if (body === undefined) throw new AdapterError("E_NOT_FOUND", `FTP no such file ${path}`, { protocol: "ftp" });
      return { path, body };
    },
    async stor(path, body) {
      files.set(path, body);
      return { path, size: body.length };
    },
    async dele(path) {
      if (!files.delete(path)) throw new AdapterError("E_NOT_FOUND", `FTP no such file ${path}`, { protocol: "ftp" });
      return { path, deleted: true };
    },
    async close() {
      files.clear();
    },
  };
}

class FtpControl {
  private buf = "";
  constructor(private readonly socket: Socket) {}

  async readLine(timeoutMs: number): Promise<string> {
    if (this.buf.includes("\n")) {
      const i = this.buf.indexOf("\n");
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      return line;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new AdapterError("E_TIMEOUT", "FTP control timeout", { protocol: "ftp" })), timeoutMs);
      const onData = (chunk: Buffer) => {
        this.buf += chunk.toString("utf8");
        if (this.buf.includes("\n")) {
          cleanup();
          resolve(this.readLine(timeoutMs));
        }
      };
      const onErr = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.socket.off("data", onData);
        this.socket.off("error", onErr);
      };
      this.socket.on("data", onData);
      this.socket.once("error", onErr);
    });
  }

  write(line: string): void {
    this.socket.write(`${line}\r\n`);
  }
}

async function expectCode(ctrl: FtpControl, code: string, timeoutMs: number): Promise<string> {
  const line = await ctrl.readLine(timeoutMs);
  if (!line.startsWith(code)) {
    throw new AdapterError("E_PROTOCOL", `FTP expected ${code}, got ${line}`, { protocol: "ftp" });
  }
  return line;
}

function parsePasv(line: string): { host: string; port: number } {
  const m = line.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/);
  if (!m) throw new AdapterError("E_PROTOCOL", `Cannot parse PASV: ${line}`, { protocol: "ftp" });
  return { host: `${m[1]}.${m[2]}.${m[3]}.${m[4]}`, port: Number(m[5]) * 256 + Number(m[6]) };
}

async function readAll(socket: Socket, timeoutMs: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new AdapterError("E_TIMEOUT", "FTP data timeout", { protocol: "ftp" }));
    }, timeoutMs);
    socket.on("data", (c) => chunks.push(c));
    socket.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function liveFtp(config: Record<string, unknown>): Promise<FtpHandle> {
  const host = stringField(config, "host") ?? stringField(config, "url")?.replace(/^ftps?:\/\//i, "").split(":")[0];
  if (!host) throw new AdapterError("E_INVALID_CONFIG", "FTP adapter requires config.host", { protocol: "ftp" });
  await assertHostAllowed(host);
  const port = typeof config.port === "number" ? config.port : 21;
  const timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 4000;
  const user = stringField(config, "user") ?? stringField(config, "username") ?? "anonymous";
  const pass = stringField(config, "password") ?? stringField(config, "pass") ?? "anonymous@";
  const socket = await new Promise<Socket>((resolve, reject) => {
    const s = createConnection({ host, port, timeout: timeoutMs }, () => resolve(s));
    s.once("error", reject);
  });
  const ctrl = new FtpControl(socket);
  await expectCode(ctrl, "220", timeoutMs);
  ctrl.write(`USER ${user}`);
  const afterUser = await ctrl.readLine(timeoutMs);
  if (afterUser.startsWith("331")) {
    ctrl.write(`PASS ${pass}`);
    await expectCode(ctrl, "230", timeoutMs);
  } else if (!afterUser.startsWith("230")) {
    throw new AdapterError("E_PROTOCOL", `FTP USER failed: ${afterUser}`, { protocol: "ftp" });
  }
  const pasvConnect = async (): Promise<Socket> => {
    ctrl.write("PASV");
    const line = await expectCode(ctrl, "227", timeoutMs);
    const dest = parsePasv(line);
    await assertHostAllowed(dest.host);
    return new Promise((resolve, reject) => {
      const s = createConnection({ host: dest.host, port: dest.port, timeout: timeoutMs }, () => resolve(s));
      s.once("error", reject);
    });
  };
  return {
    async list(path) {
      const data = await pasvConnect();
      ctrl.write(path && path !== "/" ? `LIST ${path}` : "LIST");
      await expectCode(ctrl, "150", timeoutMs);
      const body = await readAll(data, timeoutMs);
      await expectCode(ctrl, "226", timeoutMs);
      return body
        .toString("utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    },
    async retr(path) {
      const data = await pasvConnect();
      ctrl.write(`RETR ${path}`);
      await expectCode(ctrl, "150", timeoutMs);
      const body = await readAll(data, timeoutMs);
      await expectCode(ctrl, "226", timeoutMs);
      return { path, body: body.toString("utf8") };
    },
    async stor(path, body) {
      const data = await pasvConnect();
      ctrl.write(`STOR ${path}`);
      await expectCode(ctrl, "150", timeoutMs);
      data.end(body);
      await expectCode(ctrl, "226", timeoutMs);
      return { path, size: body.length };
    },
    async dele(path) {
      ctrl.write(`DELE ${path}`);
      await expectCode(ctrl, "250", timeoutMs);
      return { path, deleted: true };
    },
    async close() {
      try {
        ctrl.write("QUIT");
      } catch {
        /* ignore */
      }
      socket.destroy();
    },
  };
}

async function defaultConnect(config: Record<string, unknown>): Promise<FtpHandle> {
  const host = stringField(config, "host") ?? stringField(config, "url");
  if (config.simulator === true || !host) return createMemoryFtp();
  return liveFtp(config);
}

/** Minimal loopback FTP (220/USER/PASS/PASV/LIST/RETR/STOR/DELE) for hermetic tests. */
export async function listenFtpLoopback(files?: Map<string, string>): Promise<{ port: number; close: () => Promise<void> }> {
  const store = files ?? new Map<string, string>([["readme.txt", "hello ftp"]]);
  const dataServers: Server[] = [];
  const server = createServer((socket) => {
    let buf = "";
    socket.write("220 e2mcp FTP ready\r\n");
    const send = (line: string) => socket.write(`${line}\r\n`);
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        const [cmd, ...rest] = line.split(" ");
        const arg = rest.join(" ");
        const c = (cmd ?? "").toUpperCase();
        if (c === "USER") send("331 password required");
        else if (c === "PASS") send("230 logged in");
        else if (c === "QUIT") {
          send("221 bye");
          socket.end();
        } else if (c === "PASV") {
          const ds = createServer();
          dataServers.push(ds);
          const slot = socket as Socket & { _data?: Server; _peer?: Socket };
          ds.on("connection", (dataSock) => {
            slot._peer = dataSock;
          });
          ds.listen(0, "127.0.0.1", () => {
            const addr = ds.address();
            const p = typeof addr === "object" && addr ? addr.port : 0;
            const p1 = Math.floor(p / 256);
            const p2 = p % 256;
            slot._data = ds;
            send(`227 Entering Passive Mode (127,0,0,1,${p1},${p2})`);
          });
        } else if (c === "LIST" || c === "RETR" || c === "STOR") {
          const slot = socket as Socket & { _data?: Server; _peer?: Socket };
          const finish = (body?: Buffer) => {
            if (c === "STOR" && arg) store.set(arg, body?.toString("utf8") ?? "");
            send("226 done");
            slot._data?.close();
            slot._peer = undefined;
            slot._data = undefined;
          };
          const run = (dataSock: Socket) => {
            send("150 opening data");
            if (c === "LIST") {
              dataSock.end(`${[...store.keys()].join("\r\n")}\r\n`);
              finish();
            } else if (c === "RETR") {
              const body = store.get(arg);
              if (body === undefined) {
                send("550 missing");
                dataSock.end();
                return;
              }
              dataSock.end(body);
              finish();
            } else {
              const chunks: Buffer[] = [];
              dataSock.on("data", (d) => chunks.push(d));
              dataSock.on("end", () => finish(Buffer.concat(chunks)));
            }
          };
          if (slot._peer) run(slot._peer);
          else if (slot._data) slot._data.once("connection", run);
          else send("425 no PASV");
        } else if (c === "DELE") {
          if (store.delete(arg)) send("250 deleted");
          else send("550 missing");
        } else send("502 not implemented");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    port,
    async close() {
      await Promise.all(dataServers.map((s) => new Promise<void>((r) => s.close(() => r()))));
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** FTP LIST/RETR/STOR/DELE. Memory store or PASV control channel. Not SFTP/FTPS. */
export class FtpAdapter implements ProtocolAdapter {
  readonly protocol = "ftp";
  private handle: FtpHandle | undefined;
  private connected = false;
  private allowWrite = false;

  constructor(
    readonly id: string,
    private readonly connectFn: FtpConnectFn = defaultConnect,
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
        name: "list",
        description: "LIST directory names",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string", default: "" } },
          additionalProperties: false,
        },
      },
      {
        name: "retr",
        description: "RETR a file as UTF-8 text",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
      {
        name: "stor",
        description: "STOR a file (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" }, body: { type: "string" } },
          required: ["path", "body"],
          additionalProperties: false,
        },
      },
      {
        name: "dele",
        description: "DELE a file (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const h = this.handle!;
    if (toolName === "list") return { names: await h.list(typeof args.path === "string" ? args.path : "") };
    if (toolName === "retr") return h.retr(requiredString(args, "path"));
    if (toolName === "stor") {
      assertCanWrite("ftp", this.allowWrite);
      return h.stor(requiredString(args, "path"), requiredString(args, "body"));
    }
    if (toolName === "dele") {
      assertCanWrite("ftp", this.allowWrite);
      return h.dele(requiredString(args, "path"));
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown tool: ${toolName}`, { protocol: "ftp" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected || !this.handle) return { ok: false, detail: "not connected" };
    try {
      await this.handle.list("");
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_INVALID_CONFIG", "FTP adapter is not connected", { protocol: "ftp" });
    }
  }
}
