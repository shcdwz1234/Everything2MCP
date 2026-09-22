import { createConnection, createServer, type Server } from "node:net";
import { AdapterError } from "../../runtime/errors.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { stringField } from "../helpers.js";

export interface NfsHandle {
  ping(): Promise<{ ok: true; program: number; version: number }>;
  listExports(): Promise<{ exports: Array<{ path: string; clients: string[] }> }>;
  close(): Promise<void>;
}

export type NfsConnectFn = (config: Record<string, unknown>) => Promise<NfsHandle>;

const NFS_PROGRAM = 100003;
const NFS_VERSION = 3;

export function encodeRpcNull(xid: number, program: number, version: number): Buffer {
  const body = Buffer.alloc(40);
  body.writeUInt32BE(xid >>> 0, 0);
  body.writeUInt32BE(0, 4);
  body.writeUInt32BE(2, 8);
  body.writeUInt32BE(program >>> 0, 12);
  body.writeUInt32BE(version >>> 0, 16);
  body.writeUInt32BE(0, 20);
  body.writeUInt32BE(0, 24);
  body.writeUInt32BE(0, 28);
  body.writeUInt32BE(0, 32);
  body.writeUInt32BE(0, 36);
  const framed = Buffer.alloc(4 + body.length);
  framed.writeUInt32BE((body.length | 0x80000000) >>> 0, 0);
  body.copy(framed, 4);
  return framed;
}

export function decodeRpcAccepted(buf: Buffer): boolean {
  const payload = buf.length >= 8 ? buf.subarray(4) : buf;
  if (payload.length < 24) return false;
  const msgType = payload.readUInt32BE(4);
  const replyStat = payload.readUInt32BE(8);
  return msgType === 1 && replyStat === 0;
}

export function createMemoryNfs(): NfsHandle {
  return {
    async ping() {
      return { ok: true, program: NFS_PROGRAM, version: NFS_VERSION };
    },
    async listExports() {
      return { exports: [{ path: "/export/sim", clients: ["*"] }] };
    },
    async close() {
      /* mem */
    },
  };
}

async function livePing(host: string, port: number, timeoutMs: number): Promise<void> {
  const packet = encodeRpcNull(0x61e2c000, NFS_PROGRAM, NFS_VERSION);
  await new Promise<void>((resolve, reject) => {
    const sock = createConnection({ host, port });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new AdapterError("E_TIMEOUT", `nfs ping ${host}:${port} timed out`, { protocol: "nfs" }));
    }, timeoutMs);
    sock.on("data", (c) => chunks.push(c));
    sock.on("error", (err) => {
      clearTimeout(timer);
      reject(new AdapterError("E_PROTOCOL", `nfs TCP ${err.message}`, { protocol: "nfs" }));
    });
    sock.on("connect", () => sock.write(packet));
    sock.on("end", () => {
      clearTimeout(timer);
      if (!decodeRpcAccepted(Buffer.concat(chunks))) {
        reject(new AdapterError("E_PROTOCOL", "NFSv3 NULL reply not MSG_ACCEPTED", { protocol: "nfs" }));
        return;
      }
      resolve();
    });
  });
}

export class NfsAdapter implements ProtocolAdapter {
  readonly protocol = "nfs";
  private handle: NfsHandle | undefined;
  private live = false;

  constructor(
    readonly id: string,
    private readonly connectFn: NfsConnectFn = defaultConnect,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    this.live = config.simulator !== true && Boolean(stringField(config, "host"));
    this.handle = await this.connectFn(config);
  }

  async disconnect(): Promise<void> {
    await this.handle?.close();
    this.handle = undefined;
  }

  async listTools(): Promise<McpToolSchema[]> {
    return [
      {
        name: "ping",
        description: "NFSv3 ONC RPC NULL (program 100003). Proves reachability, not a mount.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
      },
      {
        name: "list_exports",
        description: "Simulator export table. Live mountd/SHOWMOUNT is E_UNSUPPORTED (no multicast, no full NFS client).",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    void args;
    if (!this.handle) throw new AdapterError("E_NOT_CONNECTED", "nfs not connected", { protocol: this.protocol });
    if (toolName === "ping") return this.handle.ping();
    if (toolName === "list_exports") {
      if (this.live) {
        throw new AdapterError("E_UNSUPPORTED", "live NFS SHOWMOUNT/MOUNTv3 is not implemented (simulator only)", {
          protocol: this.protocol,
        });
      }
      return this.handle.listExports();
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown tool ${toolName}`, { protocol: this.protocol });
  }

  async health(): Promise<AdapterHealth> {
    return { ok: Boolean(this.handle), detail: this.live ? "live-null-ping" : "simulator" };
  }
}

async function defaultConnect(config: Record<string, unknown>): Promise<NfsHandle> {
  if (config.simulator === true || !stringField(config, "host")) return createMemoryNfs();
  const host = stringField(config, "host")!;
  const port = typeof config.port === "number" ? config.port : 2049;
  const timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 2500;
  await livePing(host, port, timeoutMs);
  return {
    async ping() {
      return { ok: true, program: NFS_PROGRAM, version: NFS_VERSION };
    },
    async listExports() {
      throw new AdapterError("E_UNSUPPORTED", "live list_exports not implemented", { protocol: "nfs" });
    },
    async close() {
      /* one-shot */
    },
  };
}

export async function listenNfsLoopback(): Promise<{ port: number; close: () => Promise<void> }> {
  const replyBody = Buffer.alloc(28);
  replyBody.writeUInt32BE(0x61e2c000, 0);
  replyBody.writeUInt32BE(1, 4);
  replyBody.writeUInt32BE(0, 8);
  replyBody.writeUInt32BE(0, 12);
  replyBody.writeUInt32BE(0, 16);
  replyBody.writeUInt32BE(0, 20);
  const framed = Buffer.alloc(4 + replyBody.length);
  framed.writeUInt32BE((replyBody.length | 0x80000000) >>> 0, 0);
  replyBody.copy(framed, 4);
  const server: Server = createServer((sock) => {
    sock.on("data", () => sock.end(framed));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
