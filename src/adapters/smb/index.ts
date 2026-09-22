import { createConnection, createServer, type Server } from "node:net";
import { AdapterError } from "../../runtime/errors.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { stringField } from "../helpers.js";

export interface SmbFile {
  name: string;
  body: string;
}

export interface SmbHandle {
  list(): Promise<{ share: string; files: string[] }>;
  get(name: string): Promise<{ name: string; body: string }>;
  negotiate(): Promise<{ dialect: string; note: string }>;
  close(): Promise<void>;
}

export type SmbConnectFn = (config: Record<string, unknown>) => Promise<SmbHandle>;

const SMB2_PROTOCOL = Buffer.from([0xfe, 0x53, 0x4d, 0x42]);

export function buildSmb2Negotiate(): Buffer {
  const dialects = Buffer.from([0x02, 0x02, 0x10, 0x02, 0x00, 0x03, 0x02, 0x03, 0x11, 0x03]);
  const header = Buffer.alloc(64);
  SMB2_PROTOCOL.copy(header, 0);
  header.writeUInt16LE(64, 4);
  header.writeUInt16LE(0, 12); // NEGOTIATE
  header.writeUInt16LE(1, 14);
  header.writeBigUInt64LE(0n, 24);
  const body = Buffer.alloc(36 + dialects.length);
  body.writeUInt16LE(36, 0);
  body.writeUInt16LE(dialects.length / 2, 2);
  body.writeUInt16LE(1, 4); // signing enabled
  dialects.copy(body, 36);
  const payload = Buffer.concat([header, body]);
  const framed = Buffer.alloc(4 + payload.length);
  framed.writeUInt32BE(payload.length, 0);
  payload.copy(framed, 4);
  return framed;
}

export function parseSmb2Dialect(buf: Buffer): string | undefined {
  const payload = buf.length >= 4 && buf[0] !== 0xfe ? buf.subarray(4) : buf;
  if (payload.length < 70 || payload.subarray(0, 4).toString("hex") !== "fe534d42") return undefined;
  const dialect = payload.readUInt16LE(68);
  return `0x${dialect.toString(16).padStart(4, "0")}`;
}

export function createMemorySmb(files?: SmbFile[]): SmbHandle {
  const store = [...(files ?? [{ name: "readme.txt", body: "smb simulator" }])];
  return {
    async list() {
      return { share: "sim", files: store.map((f) => f.name) };
    },
    async get(name) {
      const hit = store.find((f) => f.name === name);
      if (!hit) throw new AdapterError("E_NOT_FOUND", `smb file ${name} missing`, { protocol: "smb" });
      return hit;
    },
    async negotiate() {
      return { dialect: "SMB 3.1.1 (simulator)", note: "No live CIFS session" };
    },
    async close() {
      store.length = 0;
    },
  };
}

async function liveNegotiate(host: string, port: number, timeoutMs: number): Promise<{ dialect: string; note: string }> {
  const packet = buildSmb2Negotiate();
  const dialect = await new Promise<string>((resolve, reject) => {
    const sock = createConnection({ host, port });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new AdapterError("E_TIMEOUT", `smb negotiate ${host}:${port} timed out`, { protocol: "smb" }));
    }, timeoutMs);
    sock.on("data", (c) => chunks.push(c));
    sock.on("error", (err) => {
      clearTimeout(timer);
      reject(new AdapterError("E_PROTOCOL", `smb TCP ${err.message}`, { protocol: "smb" }));
    });
    sock.on("connect", () => sock.write(packet));
    sock.on("end", () => {
      clearTimeout(timer);
      const parsed = parseSmb2Dialect(Buffer.concat(chunks));
      if (!parsed) {
        reject(
          new AdapterError("E_PROTOCOL", "SMB2 negotiate reply missing (not a full CIFS client)", { protocol: "smb" }),
        );
        return;
      }
      resolve(parsed);
    });
  });
  return { dialect, note: "Negotiate-only MVP. TREE_CONNECT / QUERY_DIRECTORY on live shares is E_UNSUPPORTED." };
}

export class SmbAdapter implements ProtocolAdapter {
  readonly protocol = "smb";
  private handle: SmbHandle | undefined;
  private live = false;

  constructor(
    readonly id: string,
    private readonly connectFn: SmbConnectFn = defaultConnect,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    this.live = config.simulator !== true && Boolean(stringField(config, "host") || stringField(config, "url"));
    this.handle = await this.connectFn(config);
  }

  async disconnect(): Promise<void> {
    await this.handle?.close();
    this.handle = undefined;
  }

  async listTools(): Promise<McpToolSchema[]> {
    return [
      {
        name: "list",
        description: "List files in the simulated share. Live TCP does not enumerate directories (honest gap).",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
      },
      {
        name: "get",
        description: "Read one simulated file. Live share reads are E_UNSUPPORTED.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: "negotiate",
        description: "SMB2 NEGOTIATE on TCP 445 (dialect only). Not a full TREE_CONNECT client.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.handle) throw new AdapterError("E_NOT_CONNECTED", "smb not connected", { protocol: this.protocol });
    if (toolName === "negotiate") return this.handle.negotiate();
    if (this.live && (toolName === "list" || toolName === "get")) {
      throw new AdapterError(
        "E_UNSUPPORTED",
        "Live SMB/CIFS file ops are not implemented (negotiate-only MVP; use simulator:true)",
        { protocol: this.protocol },
      );
    }
    if (toolName === "list") return this.handle.list();
    if (toolName === "get") {
      const name = typeof args.name === "string" ? args.name : "";
      if (!name) throw new AdapterError("E_INVALID_ARGUMENT", "name required", { protocol: this.protocol });
      return this.handle.get(name);
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown tool ${toolName}`, { protocol: this.protocol });
  }

  async health(): Promise<AdapterHealth> {
    return { ok: Boolean(this.handle), detail: this.live ? "live-negotiate-only" : "simulator" };
  }
}

async function defaultConnect(config: Record<string, unknown>): Promise<SmbHandle> {
  if (config.simulator === true || (!stringField(config, "host") && !stringField(config, "url"))) {
    return createMemorySmb();
  }
  const host = stringField(config, "host") ?? "127.0.0.1";
  const port = typeof config.port === "number" ? config.port : 445;
  const timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 2500;
  const dialect = await liveNegotiate(host, port, timeoutMs);
  return {
    async list() {
      throw new AdapterError("E_UNSUPPORTED", "live list not implemented", { protocol: "smb" });
    },
    async get() {
      throw new AdapterError("E_UNSUPPORTED", "live get not implemented", { protocol: "smb" });
    },
    async negotiate() {
      return dialect;
    },
    async close() {
      /* tcp one-shot already closed */
    },
  };
}

export async function listenSmb2Loopback(): Promise<{ port: number; close: () => Promise<void> }> {
  const dialectBody = Buffer.alloc(64 + 8);
  SMB2_PROTOCOL.copy(dialectBody, 0);
  dialectBody.writeUInt16LE(64, 4);
  dialectBody.writeUInt16LE(0x0311, 68);
  const framed = Buffer.alloc(4 + dialectBody.length);
  framed.writeUInt32BE(dialectBody.length, 0);
  dialectBody.copy(framed, 4);
  const server: Server = createServer((sock) => {
    sock.on("data", () => {
      sock.end(framed);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
