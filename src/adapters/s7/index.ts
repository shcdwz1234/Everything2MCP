import { createConnection } from "node:net";
import { AdapterError } from "../../runtime/errors.js";
import { assertHostAllowed } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";
import { stringField } from "../helpers.js";
import {
  decodeReadVar,
  decodeReadVarResponse,
  decodeValue,
  decodeWriteVar,
  encodeCotpCc,
  encodeCotpCr,
  encodeReadVar,
  encodeReadVarResponse,
  encodeValue,
  encodeWriteVar,
  isCotpCc,
  parseAddress,
  S7_PORT,
  sizeOf,
  type S7Address,
  type S7Area,
} from "./codec.js";

export interface S7Handle {
  read(addr: S7Address): Promise<{ address: string; value: unknown; type: string }>;
  write(addr: S7Address, value: unknown): Promise<{ address: string; value: unknown; type: string }>;
  listAreas(): Promise<Array<{ area: string; db?: number; bytes: number }>>;
  close(): Promise<void>;
}

export type S7ConnectFn = (config: Record<string, unknown>) => Promise<S7Handle>;

interface AreaBuf {
  area: S7Area;
  db: number;
  data: Buffer;
}

function fmtAddr(addr: S7Address): string {
  if (addr.area === "DB") {
    const k = addr.type === "BIT" ? "DBX" : addr.type === "BYTE" ? "DBB" : addr.type === "INT" || addr.type === "WORD" ? "DBW" : "DBD";
    return addr.type === "BIT" ? `DB${addr.db}.${k}${addr.byte}.${addr.bit}` : `DB${addr.db}.${k}${addr.byte}`;
  }
  const k = addr.type === "BIT" ? "X" : addr.type === "BYTE" ? "B" : addr.type === "INT" || addr.type === "WORD" ? "W" : "D";
  return addr.type === "BIT" ? `${addr.area}${k}${addr.byte}.${addr.bit}` : `${addr.area}${k}${addr.byte}`;
}

function resolveAddr(args: Record<string, unknown>): S7Address {
  if (typeof args.address === "string" && args.address.trim()) return parseAddress(args.address);
  const areaRaw = typeof args.area === "string" ? args.area.toUpperCase() : "";
  if (!areaRaw || !(areaRaw === "DB" || areaRaw === "M" || areaRaw === "I" || areaRaw === "Q")) {
    throw new AdapterError("E_INVALID_ARGUMENT", "S7 read needs address (DB1.DBW0) or area=DB|M|I|Q", { protocol: "s7" });
  }
  const typeRaw = typeof args.type === "string" ? args.type.toUpperCase() : "BYTE";
  const type = (["BIT", "BYTE", "CHAR", "WORD", "INT", "DWORD", "DINT", "REAL"].includes(typeRaw) ? typeRaw : "BYTE") as S7Address["type"];
  return {
    area: areaRaw,
    db: typeof args.db === "number" ? args.db : 1,
    byte: typeof args.byte === "number" ? args.byte : 0,
    bit: typeof args.bit === "number" ? args.bit : 0,
    type,
    count: typeof args.count === "number" && args.count > 0 ? args.count : 1,
  };
}

export function createS7Simulator(config: Record<string, unknown>): S7Handle {
  const areas: AreaBuf[] = [];
  const push = (area: S7Area, db: number, bytes: number, seed?: Record<string, unknown>) => {
    const data = Buffer.alloc(Math.max(bytes, 64));
    if (seed && typeof seed.MW10 === "number") data.writeUInt16BE(seed.MW10 & 0xffff, 10);
    areas.push({ area, db, data });
  };
  if (Array.isArray(config.areas)) {
    for (const raw of config.areas) {
      if (!raw || typeof raw !== "object") continue;
      const rec = raw as Record<string, unknown>;
      const area = String(rec.area ?? "M").toUpperCase() as S7Area;
      const db = typeof rec.db === "number" ? rec.db : area === "DB" ? 1 : 0;
      const bytes = typeof rec.bytes === "number" ? rec.bytes : 256;
      const data = Buffer.alloc(bytes);
      if (typeof rec.hex === "string") Buffer.from(rec.hex, "hex").copy(data);
      areas.push({ area, db, data });
    }
  }
  if (!areas.length) {
    push("DB", 1, 256);
    push("M", 0, 256);
    push("I", 0, 64);
    push("Q", 0, 64);
    const db1 = areas[0]!.data;
    db1.writeUInt16BE(42, 0); // DB1.DBW0
    db1.writeFloatBE(21.5, 4); // DB1.DBD4 as REAL bytes
    areas[1]!.data.writeUInt16BE(7, 10); // MW10
  }

  const find = (addr: S7Address): AreaBuf => {
    const hit = areas.find((a) => a.area === addr.area && (addr.area !== "DB" || a.db === addr.db));
    if (!hit) {
      throw new AdapterError("E_NOT_FOUND", `Unknown S7 area ${addr.area}${addr.area === "DB" ? addr.db : ""}`, { protocol: "s7" });
    }
    return hit;
  };

  return {
    async read(addr) {
      const buf = find(addr).data;
      const n = sizeOf(addr.type, addr.count);
      if (addr.byte + n > buf.length) {
        throw new AdapterError("E_INVALID_ARGUMENT", `S7 address out of range byte=${addr.byte}`, { protocol: "s7" });
      }
      const slice = buf.subarray(addr.byte, addr.byte + n);
      if (addr.type === "BIT") {
        const bit = (buf[addr.byte] ?? 0) & (1 << (addr.bit & 7));
        return { address: fmtAddr(addr), value: bit !== 0, type: addr.type };
      }
      return { address: fmtAddr(addr), value: decodeValue(addr.type, slice), type: addr.type };
    },
    async write(addr, value) {
      const area = find(addr);
      const encoded = encodeValue(addr.type, value);
      if (addr.type === "BIT") {
        const mask = 1 << (addr.bit & 7);
        if (value) area.data[addr.byte] = (area.data[addr.byte] ?? 0) | mask;
        else area.data[addr.byte] = (area.data[addr.byte] ?? 0) & ~mask;
      } else {
        encoded.copy(area.data, addr.byte);
      }
      return { address: fmtAddr(addr), value, type: addr.type };
    },
    async listAreas() {
      return areas.map((a) => ({ area: a.area, ...(a.area === "DB" ? { db: a.db } : {}), bytes: a.data.length }));
    },
    async close() {
      /* memory */
    },
  };
}

export function createS7PduPeer(handle: S7Handle): { onRequest(buf: Buffer): Promise<Buffer | undefined> } {
  return {
    async onRequest(buf) {
      if (buf[0] === 0x03 && buf[5] === 0xe0) return encodeCotpCc();
      const read = decodeReadVar(buf);
      if (read) {
        const got = await handle.read(read);
        return encodeReadVarResponse(read, encodeValue(read.type, got.value));
      }
      const write = decodeWriteVar(buf);
      if (write) {
        const value = decodeValue(write.addr.type, write.data);
        await handle.write(write.addr, value);
        return encodeReadVarResponse(write.addr, write.data);
      }
      return undefined;
    },
  };
}

export async function cotpHandshake(host: string, port: number, rack: number, slot: number, timeoutMs: number): Promise<void> {
  await assertHostAllowed(host);
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new AdapterError("E_TIMEOUT", `S7 ISO-TCP handshake timed out after ${timeoutMs}ms`, { protocol: "s7" }));
    }, timeoutMs);
    socket.on("connect", () => socket.write(encodeCotpCr(rack, slot)));
    socket.on("data", (d) => {
      clearTimeout(timer);
      socket.destroy();
      if (isCotpCc(d)) resolve();
      else reject(new AdapterError("E_PROTOCOL", "S7 ISO-TCP did not return COTP CC", { protocol: "s7" }));
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(new AdapterError("E_PROTOCOL", err.message, { protocol: "s7" }));
    });
  });
}

export async function s7ReadTcp(
  host: string,
  port: number,
  addr: S7Address,
  timeoutMs: number,
  rack = 0,
  slot = 1,
): Promise<Buffer> {
  await assertHostAllowed(host);
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    let authed = false;
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new AdapterError("E_TIMEOUT", `S7 read timed out after ${timeoutMs}ms`, { protocol: "s7" }));
    }, timeoutMs);
    const fail = (err: Error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(err instanceof AdapterError ? err : new AdapterError("E_PROTOCOL", err.message, { protocol: "s7" }));
    };
    socket.on("connect", () => socket.write(encodeCotpCr(rack, slot)));
    socket.on("data", (d) => {
      if (!authed) {
        if (!isCotpCc(d)) return fail(new Error("expected COTP CC"));
        authed = true;
        socket.write(encodeReadVar(addr));
        return;
      }
      chunks.push(d);
      const data = decodeReadVarResponse(Buffer.concat(chunks));
      if (data) {
        clearTimeout(timer);
        socket.destroy();
        resolve(data);
      }
    });
    socket.on("error", fail);
  });
}

export function wrapWithTcp(local: S7Handle, config: Record<string, unknown>): S7Handle {
  const host = stringField(config, "host") ?? "127.0.0.1";
  const port = typeof config.port === "number" ? config.port : S7_PORT;
  const rack = typeof config.rack === "number" ? config.rack : 0;
  const slot = typeof config.slot === "number" ? config.slot : 1;
  const timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 1500;
  return {
    async read(addr) {
      const buf = await s7ReadTcp(host, port, addr, timeoutMs, rack, slot);
      return { address: fmtAddr(addr), value: decodeValue(addr.type, buf), type: addr.type };
    },
    write: (addr, value) => local.write(addr, value),
    listAreas: () => local.listAreas(),
    close: () => local.close(),
  };
}

export async function defaultS7Connect(config: Record<string, unknown>): Promise<S7Handle> {
  const sim = createS7Simulator(config);
  if (config.tcp === true) return wrapWithTcp(sim, config);
  return sim;
}

/**
 * Siemens S7: in-memory DB/M/I/Q plus optional ISO-TCP (port 102) COTP + S7comm Read Var.
 * No PUT/GET optimization, no TIA blocks, no S7-1200 optimized access.
 */
export class S7Adapter implements ProtocolAdapter {
  readonly protocol = "s7";
  private handle: S7Handle | undefined;
  private connected = false;
  private allowWrite = false;
  private tcp = false;

  constructor(
    readonly id: string,
    private readonly connectFn: S7ConnectFn = defaultS7Connect,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    this.allowWrite = allowWriteFrom(config);
    this.tcp = config.tcp === true;
    if (this.tcp) await assertHostAllowed(stringField(config, "host") ?? "127.0.0.1");
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
        name: "read",
        description: "Read DB/M/I/Q (address like DB1.DBW0, MW10, I0.0, Q0.0)",
        inputSchema: {
          type: "object",
          properties: {
            address: { type: "string" },
            area: { type: "string", enum: ["DB", "M", "I", "Q"] },
            db: { type: "integer" },
            byte: { type: "integer" },
            bit: { type: "integer" },
            type: { type: "string", enum: ["BIT", "BYTE", "WORD", "INT", "DWORD", "DINT", "REAL"] },
            count: { type: "integer", default: 1 },
          },
          additionalProperties: false,
        },
      },
      {
        name: "list_areas",
        description: "List local/mock PLC areas",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "write",
        description: "Write DB/M/I/Q (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: {
            address: { type: "string" },
            area: { type: "string" },
            db: { type: "integer" },
            byte: { type: "integer" },
            bit: { type: "integer" },
            type: { type: "string" },
            value: {},
          },
          required: ["value"],
          additionalProperties: false,
        },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const handle = this.handle!;
    if (toolName === "list_areas") {
      return { areas: await handle.listAreas(), transport: this.tcp ? "iso-tcp" : "memory" };
    }
    if (toolName === "read") {
      const addr = resolveAddr(args);
      const result = await handle.read(addr);
      return { ...result, transport: this.tcp ? "iso-tcp" : "memory", note: "S7comm Read Var subset. No optimized block access." };
    }
    if (toolName === "write") {
      assertCanWrite("s7", this.allowWrite);
      const addr = resolveAddr(args);
      return handle.write(addr, args.value);
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown S7 tool "${toolName}"`, { protocol: "s7" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return { ok: true, detail: `s7 transport=${this.tcp ? "iso-tcp" : "memory"} allowWrite=${this.allowWrite}` };
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_NOT_CONNECTED", "S7 adapter is not connected", { protocol: "s7" });
    }
  }
}

export { encodeCotpCr, encodeCotpCc, isCotpCc, parseAddress, S7_PORT, encodeReadVar, decodeReadVar };
