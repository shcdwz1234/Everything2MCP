import { createSocket, type Socket } from "node:dgram";
import { AdapterError } from "../../runtime/errors.js";
import { assertHostAllowed } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";
import { requiredString, stringField } from "../helpers.js";
import {
  PDU_GET,
  PDU_GET_NEXT,
  PDU_RESPONSE,
  PDU_SET,
  SYS_DESCR,
  compareOid,
  decodeSnmp,
  defaultMib,
  encodeSnmpV2c,
  nextOid,
  type SnmpMessage,
  type SnmpVarbind,
} from "./codec.js";

export interface SnmpHandle {
  get(oid: string): Promise<SnmpVarbind>;
  getNext(oid: string): Promise<SnmpVarbind | undefined>;
  walk(oid: string, max: number): Promise<SnmpVarbind[]>;
  set(oid: string, value: string): Promise<SnmpVarbind>;
  close(): Promise<void>;
}

export type SnmpConnectFn = (config: Record<string, unknown>) => Promise<SnmpHandle>;

export function createMemorySnmp(seed?: Map<string, SnmpVarbind>): SnmpHandle {
  const mib = seed ?? defaultMib();
  const sorted = () => [...mib.keys()].sort(compareOid);
  return {
    async get(oid) {
      const hit = mib.get(oid);
      if (!hit) throw new AdapterError("E_NOT_FOUND", `Unknown OID ${oid}`, { protocol: "snmp" });
      return { ...hit };
    },
    async getNext(oid) {
      const key = nextOid(sorted(), oid);
      return key ? { ...mib.get(key)! } : undefined;
    },
    async walk(oid, max) {
      const out: SnmpVarbind[] = [];
      let cursor = oid;
      for (let i = 0; i < max; i += 1) {
        const key = nextOid(sorted(), cursor);
        if (!key) break;
        out.push({ ...mib.get(key)! });
        cursor = key;
      }
      return out;
    },
    async set(oid, value) {
      const next: SnmpVarbind = { oid, type: "octet", value };
      mib.set(oid, next);
      return { ...next };
    },
    async close() {
      /* memory */
    },
  };
}

function udpHandle(host: string, port: number, community: string, timeoutMs: number): SnmpHandle {
  let requestId = 1;
  const exchange = async (pduType: number, oid: string, value?: SnmpVarbind): Promise<SnmpMessage> => {
    await assertHostAllowed(host);
    const id = requestId++;
    const packet = encodeSnmpV2c({
      community,
      pduType,
      requestId: id,
      errorStatus: 0,
      errorIndex: 0,
      varbinds: [value ?? { oid, type: "null", value: "" }],
    });
    const reply = await new Promise<Buffer>((resolve, reject) => {
      const socket: Socket = createSocket("udp4");
      const timer = setTimeout(() => {
        socket.close();
        reject(new AdapterError("E_TIMEOUT", `SNMP timeout ${host}:${port}`, { protocol: "snmp" }));
      }, timeoutMs);
      socket.once("message", (msg) => {
        clearTimeout(timer);
        socket.close();
        resolve(msg);
      });
      socket.once("error", (err) => {
        clearTimeout(timer);
        socket.close();
        reject(err);
      });
      socket.send(packet, port, host);
    });
    return decodeSnmp(reply);
  };
  return {
    async get(oid) {
      const msg = await exchange(PDU_GET, oid);
      if (msg.errorStatus) throw new AdapterError("E_PROTOCOL", `SNMP error-status ${msg.errorStatus}`, { protocol: "snmp" });
      const vb = msg.varbinds[0];
      if (!vb || vb.type === "null") throw new AdapterError("E_NOT_FOUND", `No such OID ${oid}`, { protocol: "snmp" });
      return vb;
    },
    async getNext(oid) {
      const msg = await exchange(PDU_GET_NEXT, oid);
      const vb = msg.varbinds[0];
      if (!vb || vb.type === "null") return undefined;
      return vb;
    },
    async walk(oid, max) {
      const out: SnmpVarbind[] = [];
      let cursor = oid;
      for (let i = 0; i < max; i += 1) {
        const vb = await this.getNext(cursor);
        if (!vb) break;
        out.push(vb);
        cursor = vb.oid;
      }
      return out;
    },
    async set(oid, value) {
      const msg = await exchange(PDU_SET, oid, { oid, type: "octet", value });
      if (msg.errorStatus) throw new AdapterError("E_PROTOCOL", `SNMP set error-status ${msg.errorStatus}`, { protocol: "snmp" });
      return msg.varbinds[0] ?? { oid, type: "octet", value };
    },
    async close() {
      /* stateless UDP */
    },
  };
}

async function defaultConnect(config: Record<string, unknown>): Promise<SnmpHandle> {
  const host = stringField(config, "host") ?? stringField(config, "url")?.replace(/^snmp:\/\//i, "").split(":")[0];
  if (config.simulator === true || !host) return createMemorySnmp();
  const port = typeof config.port === "number" ? config.port : 161;
  const community = stringField(config, "community") ?? "public";
  const timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 2000;
  return udpHandle(host, port, community, timeoutMs);
}

/** SNMPv2c Get/GetNext/walk/Set. Memory MIB or UDP 161. Not v3/USM. */
export class SnmpAdapter implements ProtocolAdapter {
  readonly protocol = "snmp";
  private handle: SnmpHandle | undefined;
  private connected = false;
  private allowWrite = false;
  private community = "public";

  constructor(
    readonly id: string,
    private readonly connectFn: SnmpConnectFn = defaultConnect,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    this.allowWrite = allowWriteFrom(config);
    this.community = stringField(config, "community") ?? "public";
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
        description: "SNMPv2c GetRequest",
        inputSchema: {
          type: "object",
          properties: { oid: { type: "string", description: "Dotted OID, e.g. 1.3.6.1.2.1.1.1.0" } },
          required: ["oid"],
          additionalProperties: false,
        },
      },
      {
        name: "get_next",
        description: "SNMPv2c GetNextRequest",
        inputSchema: {
          type: "object",
          properties: { oid: { type: "string" } },
          required: ["oid"],
          additionalProperties: false,
        },
      },
      {
        name: "walk",
        description: "Bounded GetNext walk (max 32)",
        inputSchema: {
          type: "object",
          properties: { oid: { type: "string", default: "1.3" }, max: { type: "integer", default: 32 } },
          additionalProperties: false,
        },
      },
      {
        name: "set",
        description: "SNMPv2c SetRequest (octet string; requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: { oid: { type: "string" }, value: { type: "string" } },
          required: ["oid", "value"],
          additionalProperties: false,
        },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const h = this.handle!;
    if (toolName === "get") return h.get(requiredString(args, "oid"));
    if (toolName === "get_next") {
      const vb = await h.getNext(requiredString(args, "oid"));
      if (!vb) throw new AdapterError("E_NOT_FOUND", "End of MIB", { protocol: "snmp" });
      return vb;
    }
    if (toolName === "walk") {
      const oid = typeof args.oid === "string" && args.oid.trim() ? args.oid.trim() : "1.3";
      const max = typeof args.max === "number" && args.max > 0 ? Math.min(args.max, 32) : 32;
      return { varbinds: await h.walk(oid, max) };
    }
    if (toolName === "set") {
      assertCanWrite("snmp", this.allowWrite);
      return h.set(requiredString(args, "oid"), requiredString(args, "value"));
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown tool: ${toolName}`, { protocol: "snmp" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected || !this.handle) return { ok: false, detail: "not connected" };
    try {
      await this.handle.get(SYS_DESCR);
      return { ok: true, detail: `community=${this.community}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_INVALID_CONFIG", "SNMP adapter is not connected", { protocol: "snmp" });
    }
  }
}

export { decodeSnmp, encodeGet, encodeSnmpV2c, PDU_GET, PDU_RESPONSE, SYS_DESCR } from "./codec.js";
