import { createSocket, type RemoteInfo } from "node:dgram";
import { AdapterError } from "../../runtime/errors.js";
import { assertHostAllowed } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";
import { requiredString, stringField } from "../helpers.js";

export const TFTP_RRQ = 1;
export const TFTP_WRQ = 2;
export const TFTP_DATA = 3;
export const TFTP_ACK = 4;
export const TFTP_ERROR = 5;
export const TFTP_BLOCK = 512;

export interface TftpHandle {
  get(filename: string): Promise<{ filename: string; body: string }>;
  put(filename: string, body: string): Promise<{ filename: string; size: number }>;
  close(): Promise<void>;
}

export type TftpConnectFn = (config: Record<string, unknown>) => Promise<TftpHandle>;

export function encodeTftpRequest(opcode: 1 | 2, filename: string, mode = "octet"): Buffer {
  return Buffer.concat([
    Buffer.from([0, opcode]),
    Buffer.from(filename, "ascii"),
    Buffer.from([0]),
    Buffer.from(mode, "ascii"),
    Buffer.from([0]),
  ]);
}

export function encodeTftpData(block: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt16BE(TFTP_DATA, 0);
  head.writeUInt16BE(block, 2);
  return Buffer.concat([head, payload]);
}

export function encodeTftpAck(block: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt16BE(TFTP_ACK, 0);
  buf.writeUInt16BE(block, 2);
  return buf;
}

export function decodeTftp(buf: Buffer): { opcode: number; block?: number; filename?: string; payload?: Buffer; message?: string } {
  if (buf.length < 2) return { opcode: 0 };
  const opcode = buf.readUInt16BE(0);
  if (opcode === TFTP_RRQ || opcode === TFTP_WRQ) {
    const rest = buf.subarray(2);
    const z = rest.indexOf(0);
    return { opcode, filename: rest.subarray(0, z < 0 ? rest.length : z).toString("ascii") };
  }
  if (opcode === TFTP_DATA || opcode === TFTP_ACK) {
    return { opcode, block: buf.length >= 4 ? buf.readUInt16BE(2) : 0, payload: buf.subarray(4) };
  }
  if (opcode === TFTP_ERROR) {
    return { opcode, message: buf.subarray(4).toString("utf8").replace(/\0+$/, "") };
  }
  return { opcode };
}

export function createMemoryTftp(): TftpHandle {
  const files = new Map<string, string>([["readme.txt", "hello tftp"]]);
  return {
    async get(filename) {
      const body = files.get(filename);
      if (body === undefined) throw new AdapterError("E_NOT_FOUND", `TFTP no such file ${filename}`, { protocol: "tftp" });
      return { filename, body };
    },
    async put(filename, body) {
      files.set(filename, body);
      return { filename, size: Buffer.byteLength(body) };
    },
    async close() {
      files.clear();
    },
  };
}

function udpSession(timeoutMs: number): {
  ask: (host: string, port: number, packet: Buffer) => Promise<{ buf: Buffer; rinfo: RemoteInfo }>;
  close: () => void;
} {
  const sock = createSocket("udp4");
  let waiter: ((msg: { buf: Buffer; rinfo: RemoteInfo }) => void) | undefined;
  sock.on("message", (buf, rinfo) => {
    const w = waiter;
    waiter = undefined;
    w?.({ buf, rinfo });
  });
  return {
    ask(host, port, packet) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiter = undefined;
          reject(new AdapterError("E_TIMEOUT", "TFTP timeout", { protocol: "tftp" }));
        }, timeoutMs);
        waiter = (msg) => {
          clearTimeout(timer);
          resolve(msg);
        };
        sock.send(packet, port, host, (err) => {
          if (err) {
            clearTimeout(timer);
            waiter = undefined;
            reject(err);
          }
        });
      });
    },
    close() {
      try {
        sock.close();
      } catch {
        /* ignore */
      }
    },
  };
}

async function liveTftp(config: Record<string, unknown>): Promise<TftpHandle> {
  const host = stringField(config, "host") ?? stringField(config, "url")?.replace(/^tftp:\/\//i, "").split(":")[0];
  if (!host) throw new AdapterError("E_INVALID_CONFIG", "TFTP adapter requires config.host", { protocol: "tftp" });
  await assertHostAllowed(host);
  const port = typeof config.port === "number" ? config.port : 69;
  const timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 4000;
  return {
    async get(filename) {
      const sess = udpSession(timeoutMs);
      try {
        const first = await sess.ask(host, port, encodeTftpRequest(TFTP_RRQ, filename));
        const parts: Buffer[] = [];
        let msg = decodeTftp(first.buf);
        let peerPort = first.rinfo.port;
        for (;;) {
          if (msg.opcode === TFTP_ERROR) {
            throw new AdapterError("E_NOT_FOUND", msg.message || `TFTP error ${filename}`, { protocol: "tftp" });
          }
          if (msg.opcode !== TFTP_DATA || msg.block === undefined) {
            throw new AdapterError("E_PROTOCOL", `TFTP expected DATA, got ${msg.opcode}`, { protocol: "tftp" });
          }
          if (msg.payload) parts.push(msg.payload);
          const ack = encodeTftpAck(msg.block);
          if ((msg.payload?.length ?? 0) < TFTP_BLOCK) {
            sess.ask(host, peerPort, ack).catch(() => undefined);
            break;
          }
          const next = await sess.ask(host, peerPort, ack);
          peerPort = next.rinfo.port;
          msg = decodeTftp(next.buf);
        }
        return { filename, body: Buffer.concat(parts).toString("utf8") };
      } finally {
        sess.close();
      }
    },
    async put(filename, body) {
      const sess = udpSession(timeoutMs);
      try {
        const first = await sess.ask(host, port, encodeTftpRequest(TFTP_WRQ, filename));
        const start = decodeTftp(first.buf);
        if (start.opcode === TFTP_ERROR) {
          throw new AdapterError("E_PROTOCOL", start.message || "TFTP WRQ error", { protocol: "tftp" });
        }
        if (start.opcode !== TFTP_ACK) {
          throw new AdapterError("E_PROTOCOL", `TFTP expected ACK 0, got ${start.opcode}`, { protocol: "tftp" });
        }
        const raw = Buffer.from(body, "utf8");
        let offset = 0;
        let block = 1;
        let peerPort = first.rinfo.port;
        while (offset <= raw.length) {
          const slice = raw.subarray(offset, offset + TFTP_BLOCK);
          const reply = await sess.ask(host, peerPort, encodeTftpData(block, slice));
          const ack = decodeTftp(reply.buf);
          if (ack.opcode !== TFTP_ACK || ack.block !== block) {
            throw new AdapterError("E_PROTOCOL", `TFTP ACK mismatch ${ack.block}`, { protocol: "tftp" });
          }
          peerPort = reply.rinfo.port;
          offset += TFTP_BLOCK;
          block += 1;
          if (slice.length < TFTP_BLOCK) break;
        }
        return { filename, size: raw.length };
      } finally {
        sess.close();
      }
    },
    async close() {
      /* stateless */
    },
  };
}

async function defaultConnect(config: Record<string, unknown>): Promise<TftpHandle> {
  const host = stringField(config, "host") ?? stringField(config, "url");
  if (config.simulator === true || !host) return createMemoryTftp();
  return liveTftp(config);
}

export async function listenTftpLoopback(): Promise<{ port: number; close: () => Promise<void> }> {
  const mem = createMemoryTftp();
  const pendingWrite = new Map<string, string>();
  const sock = createSocket("udp4");
  sock.on("message", (buf, rinfo) => {
    const msg = decodeTftp(buf);
    const peer = `${rinfo.address}:${rinfo.port}`;
    void (async () => {
      if (msg.opcode === TFTP_RRQ) {
        try {
          const file = await mem.get(msg.filename ?? "");
          const raw = Buffer.from(file.body, "utf8");
          sock.send(encodeTftpData(1, raw.subarray(0, TFTP_BLOCK)), rinfo.port, rinfo.address);
        } catch (err) {
          const text = err instanceof Error ? err.message : "not found";
          sock.send(Buffer.concat([Buffer.from([0, TFTP_ERROR, 0, 1]), Buffer.from(text), Buffer.from([0])]), rinfo.port, rinfo.address);
        }
      } else if (msg.opcode === TFTP_WRQ) {
        pendingWrite.set(peer, msg.filename || "upload.bin");
        sock.send(encodeTftpAck(0), rinfo.port, rinfo.address);
      } else if (msg.opcode === TFTP_DATA && msg.block === 1) {
        const name = pendingWrite.get(peer) ?? "upload.bin";
        pendingWrite.delete(peer);
        await mem.put(name, (msg.payload ?? Buffer.alloc(0)).toString("utf8"));
        sock.send(encodeTftpAck(1), rinfo.port, rinfo.address);
      }
    })();
  });
  await new Promise<void>((r) => sock.bind(0, "127.0.0.1", () => r()));
  return { port: sock.address().port, close: () => new Promise((r) => sock.close(() => r())) };
}

/** TFTP RRQ/WRQ/DATA/ACK (RFC 1350 octet). WRQ needs allowWrite. Not FTP/SFTP. */
export class TftpAdapter implements ProtocolAdapter {
  readonly protocol = "tftp";
  private handle: TftpHandle | undefined;
  private connected = false;
  private allowWrite = false;

  constructor(
    readonly id: string,
    private readonly connectFn: TftpConnectFn = defaultConnect,
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
        description: "TFTP RRQ (read; not FTP)",
        inputSchema: { type: "object", properties: { filename: { type: "string" } }, required: ["filename"], additionalProperties: false },
      },
      {
        name: "put",
        description: "TFTP WRQ (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: { filename: { type: "string" }, body: { type: "string" } },
          required: ["filename", "body"],
          additionalProperties: false,
        },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    if (toolName === "get") return this.handle!.get(requiredString(args, "filename"));
    if (toolName === "put") {
      assertCanWrite("tftp", this.allowWrite);
      return this.handle!.put(requiredString(args, "filename"), requiredString(args, "body"));
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown tool: ${toolName}`, { protocol: "tftp" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected || !this.handle) return { ok: false, detail: "not connected" };
    return { ok: true, detail: "tftp rfc1350" };
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_INVALID_CONFIG", "TFTP adapter is not connected", { protocol: "tftp" });
    }
  }
}
