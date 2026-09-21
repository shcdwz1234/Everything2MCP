import { createConnection } from "node:net";
import { AdapterError } from "../../runtime/errors.js";
import { assertHostAllowed } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";
import { requiredString, stringField } from "../helpers.js";
import {
  decodeListIdentityReply,
  encodeListIdentityReply,
  encodeListIdentityRequest,
  ENIP_PORT,
  type EnipIdentity,
} from "./codec.js";

export interface EnipTag {
  name: string;
  type: string;
  value: unknown;
}

export interface EnipHandle {
  listIdentities(): Promise<EnipIdentity[]>;
  listTags(): Promise<EnipTag[]>;
  readTag(name: string): Promise<EnipTag>;
  writeTag(name: string, value: unknown): Promise<EnipTag>;
  close(): Promise<void>;
}

export type EnipConnectFn = (config: Record<string, unknown>) => Promise<EnipHandle>;

function defaultTags(config: Record<string, unknown>): EnipTag[] {
  if (Array.isArray(config.tags)) {
    return config.tags
      .filter((t): t is Record<string, unknown> => Boolean(t) && typeof t === "object")
      .map((t, i) => ({
        name: typeof t.name === "string" ? t.name : `Tag${i}`,
        type: typeof t.type === "string" ? t.type : "DINT",
        value: t.value ?? 0,
      }));
  }
  return [
    { name: "Heartbeat", type: "DINT", value: 1 },
    { name: "Running", type: "BOOL", value: true },
    { name: "Speed", type: "REAL", value: 12.5 },
  ];
}

export function createEnipSimulator(config: Record<string, unknown>): EnipHandle {
  const tags = defaultTags(config);
  const identity: EnipIdentity = {
    vendorId: typeof config.vendorId === "number" ? config.vendorId : 1,
    deviceType: typeof config.deviceType === "number" ? config.deviceType : 14,
    productCode: typeof config.productCode === "number" ? config.productCode : 54,
    revision: typeof config.revision === "string" ? config.revision : "1.1",
    serial: typeof config.serial === "number" ? config.serial : 0x00e2c100,
    productName: typeof config.productName === "string" ? config.productName : "e2mcp-enip-sim",
    ip: stringField(config, "host") ?? "127.0.0.1",
    port: typeof config.port === "number" ? config.port : ENIP_PORT,
  };
  return {
    async listIdentities() {
      return [identity];
    },
    async listTags() {
      return tags.map((t) => ({ ...t }));
    },
    async readTag(name) {
      const tag = tags.find((t) => t.name === name);
      if (!tag) throw new AdapterError("E_NOT_FOUND", `Unknown CIP tag "${name}"`, { protocol: "ethernetip" });
      return { ...tag };
    },
    async writeTag(name, value) {
      const tag = tags.find((t) => t.name === name);
      if (!tag) throw new AdapterError("E_NOT_FOUND", `Unknown CIP tag "${name}"`, { protocol: "ethernetip" });
      tag.value = value;
      return { ...tag };
    },
    async close() {
      /* memory */
    },
  };
}

export async function listIdentityTcp(host: string, port: number, timeoutMs: number): Promise<EnipIdentity> {
  await assertHostAllowed(host);
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new AdapterError("E_TIMEOUT", `EtherNet/IP List Identity timed out after ${timeoutMs}ms`, { protocol: "ethernetip" }));
    }, timeoutMs);
    const finish = (err?: Error, identity?: EnipIdentity) => {
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      if (err) reject(err instanceof AdapterError ? err : new AdapterError("E_PROTOCOL", err.message, { protocol: "ethernetip" }));
      else if (identity) resolve(identity);
      else reject(new AdapterError("E_PROTOCOL", "EtherNet/IP List Identity returned no identity", { protocol: "ethernetip" }));
    };
    socket.on("connect", () => socket.write(encodeListIdentityRequest()));
    socket.on("data", (d) => {
      chunks.push(d);
      const identity = decodeListIdentityReply(Buffer.concat(chunks));
      if (identity) finish(undefined, identity);
    });
    socket.on("error", (err) => finish(err));
    socket.on("end", () => {
      const identity = decodeListIdentityReply(Buffer.concat(chunks));
      finish(identity ? undefined : new Error("closed before List Identity reply"), identity);
    });
  });
}

export function wrapWithTcp(local: EnipHandle, config: Record<string, unknown>): EnipHandle {
  const host = stringField(config, "host") ?? "127.0.0.1";
  const port = typeof config.port === "number" ? config.port : ENIP_PORT;
  const timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 1500;
  return {
    async listIdentities() {
      const remote = await listIdentityTcp(host, port, timeoutMs);
      return [remote];
    },
    listTags: () => local.listTags(),
    readTag: (name) => local.readTag(name),
    writeTag: (name, value) => local.writeTag(name, value),
    close: () => local.close(),
  };
}

export async function defaultEnipConnect(config: Record<string, unknown>): Promise<EnipHandle> {
  const sim = createEnipSimulator(config);
  if (config.tcp === true) return wrapWithTcp(sim, config);
  return sim;
}

/**
 * EtherNet/IP / CIP adapter: in-memory tag table plus optional TCP List Identity.
 * No Forward Open, no implicit I/O, no CIP security.
 */
export class EthernetIpAdapter implements ProtocolAdapter {
  readonly protocol = "ethernetip";
  private handle: EnipHandle | undefined;
  private connected = false;
  private allowWrite = false;
  private tcp = false;

  constructor(
    readonly id: string,
    private readonly connectFn: EnipConnectFn = defaultEnipConnect,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    this.allowWrite = allowWriteFrom(config);
    this.tcp = config.tcp === true;
    if (this.tcp) {
      const host = stringField(config, "host") ?? "127.0.0.1";
      await assertHostAllowed(host);
    }
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
        name: "list_identities",
        description: this.tcp
          ? "CIP List Identity over TCP (encapsulation 0x0063); unicast only"
          : "List Identity from the in-memory device (set tcp:true for wire List Identity)",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "list_tags",
        description: "List symbolic tags in the local CIP tag table",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "read_tag",
        description: "Read a symbolic CIP tag from the local table (not a full CIP service)",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
      },
      {
        name: "write_tag",
        description: "Write a symbolic CIP tag (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" }, value: {} },
          required: ["name", "value"],
          additionalProperties: false,
        },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const handle = this.handle!;
    if (toolName === "list_identities") {
      const identities = await handle.listIdentities();
      return {
        identities,
        transport: this.tcp ? "tcp-unicast" : "memory",
        note: "CIP List Identity only. No Forward Open / Class 1 I/O / CIP Security.",
      };
    }
    if (toolName === "list_tags") {
      return { tags: await handle.listTags(), note: "Local tag table, not PLC program browse." };
    }
    if (toolName === "read_tag") {
      return handle.readTag(requiredString(args, "name"));
    }
    if (toolName === "write_tag") {
      assertCanWrite("ethernetip", this.allowWrite);
      return handle.writeTag(requiredString(args, "name"), args.value);
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown EtherNet/IP tool "${toolName}"`, { protocol: "ethernetip" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return { ok: true, detail: `ethernetip transport=${this.tcp ? "tcp" : "memory"} allowWrite=${this.allowWrite}` };
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_NOT_CONNECTED", "EtherNet/IP adapter is not connected", { protocol: "ethernetip" });
    }
  }
}

export { encodeListIdentityReply, encodeListIdentityRequest, decodeListIdentityReply, ENIP_PORT };
