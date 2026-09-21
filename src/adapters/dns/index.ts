import { createSocket } from "node:dgram";
import { AdapterError } from "../../runtime/errors.js";
import { assertHostAllowed } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { requiredString, stringField } from "../helpers.js";
import {
  DNS_TYPE_A,
  DNS_TYPE_PTR,
  DNS_TYPE_TXT,
  decodeDnsMessage,
  encodeDnsName,
  encodeDnsQuery,
} from "../../discovery/dnssd.js";

export const DNS_TYPE_AAAA = 28;

export type DnsRecordType = "A" | "AAAA" | "TXT" | "PTR";

const TYPE_NUM: Record<DnsRecordType, number> = {
  A: DNS_TYPE_A,
  AAAA: DNS_TYPE_AAAA,
  TXT: DNS_TYPE_TXT,
  PTR: DNS_TYPE_PTR,
};

export interface DnsAnswer {
  name: string;
  type: DnsRecordType | number;
  ttl: number;
  data: string;
}

export interface DnsHandle {
  query(name: string, type: DnsRecordType): Promise<{ answers: DnsAnswer[] }>;
  close(): Promise<void>;
}

export type DnsConnectFn = (config: Record<string, unknown>) => Promise<DnsHandle>;

function typeName(n: number): DnsRecordType | number {
  if (n === DNS_TYPE_A) return "A";
  if (n === DNS_TYPE_AAAA) return "AAAA";
  if (n === DNS_TYPE_TXT) return "TXT";
  if (n === DNS_TYPE_PTR) return "PTR";
  return n;
}

export function encodeDnsAResponse(qname: string, ip: string, id = 0x1234): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(1, 6);
  const q = Buffer.alloc(4);
  q.writeUInt16BE(DNS_TYPE_A, 0);
  q.writeUInt16BE(1, 2);
  const parts = ip.split(".").map((x) => Number(x) & 0xff);
  const rdata = Buffer.from(parts);
  const rrHead = Buffer.alloc(10);
  rrHead.writeUInt16BE(DNS_TYPE_A, 0);
  rrHead.writeUInt16BE(1, 2);
  rrHead.writeUInt32BE(60, 4);
  rrHead.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([header, encodeDnsName(qname), q, encodeDnsName(qname), rrHead, rdata]);
}

export function encodeDnsTxtResponse(qname: string, text: string, id = 0x1234): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(1, 6);
  const q = Buffer.alloc(4);
  q.writeUInt16BE(DNS_TYPE_TXT, 0);
  q.writeUInt16BE(1, 2);
  const raw = Buffer.from(text, "utf8");
  const rdata = Buffer.concat([Buffer.from([raw.length]), raw]);
  const rrHead = Buffer.alloc(10);
  rrHead.writeUInt16BE(DNS_TYPE_TXT, 0);
  rrHead.writeUInt16BE(1, 2);
  rrHead.writeUInt32BE(60, 4);
  rrHead.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([header, encodeDnsName(qname), q, encodeDnsName(qname), rrHead, rdata]);
}

export function createMemoryDns(seed: DnsAnswer[] = []): DnsHandle {
  const records = seed.length
    ? [...seed]
    : [
        { name: "example.test", type: "A" as const, ttl: 60, data: "127.0.0.1" },
        { name: "example.test", type: "TXT" as const, ttl: 60, data: "everything2mcp" },
      ];
  return {
    async query(name, type) {
      const want = name.replace(/\.$/, "").toLowerCase();
      const answers = records.filter(
        (r) => String(r.name).replace(/\.$/, "").toLowerCase() === want && r.type === type,
      );
      return { answers };
    },
    async close() {
      records.length = 0;
    },
  };
}

export async function listenDnsLoopback(seed?: DnsAnswer[]): Promise<{ port: number; close: () => Promise<void> }> {
  const mem = createMemoryDns(seed);
  const socket = createSocket("udp4");
  socket.on("message", (msg, rinfo) => {
    const decoded = decodeDnsMessage(msg);
    const qname = decoded.answers[0]?.name;
    void (async () => {
      const id = msg.length >= 2 ? msg.readUInt16BE(0) : 0;
      let qtype = DNS_TYPE_A;
      let name = "example.test";
      try {
        let o = 12;
        const labels: string[] = [];
        while (o < msg.length && msg[o]) {
          const n = msg[o]!;
          labels.push(msg.subarray(o + 1, o + 1 + n).toString("utf8"));
          o += 1 + n;
        }
        o += 1;
        qtype = msg.readUInt16BE(o);
        name = labels.join(".") || "example.test";
      } catch {
        /* fall back */
      }
      const type = typeName(qtype);
      const q = typeof type === "string" ? type : "A";
      const { answers } = await mem.query(name, q);
      const first = answers[0];
      const body =
        q === "TXT"
          ? encodeDnsTxtResponse(name, first?.data ?? "", id)
          : encodeDnsAResponse(name, first?.data ?? "127.0.0.1", id);
      socket.send(body, rinfo.port, rinfo.address);
      void qname;
    })();
  });
  await new Promise<void>((r) => socket.bind(0, "127.0.0.1", () => r()));
  return {
    port: socket.address().port,
    close: () =>
      new Promise((r) => {
        socket.close(() => r());
      }),
  };
}

async function liveDns(config: Record<string, unknown>): Promise<DnsHandle> {
  const host = stringField(config, "host") ?? stringField(config, "server") ?? "127.0.0.1";
  await assertHostAllowed(host);
  const port = typeof config.port === "number" && config.port > 0 ? config.port : 53;
  const timeoutMs = typeof config.timeoutMs === "number" && config.timeoutMs > 0 ? config.timeoutMs : 1500;
  return {
    async query(name, type) {
      const q = encodeDnsQuery(name, TYPE_NUM[type], Math.floor(Math.random() * 0xffff));
      const reply = await new Promise<Buffer>((resolve, reject) => {
        const s = createSocket("udp4");
        const timer = setTimeout(() => {
          s.close();
          reject(new AdapterError("E_TIMEOUT", `DNS query timed out after ${timeoutMs}ms`, { protocol: "dns" }));
        }, timeoutMs);
        s.once("error", (err) => {
          clearTimeout(timer);
          s.close();
          reject(err);
        });
        s.once("message", (msg) => {
          clearTimeout(timer);
          s.close();
          resolve(Buffer.from(msg));
        });
        s.send(q, port, host);
      });
      const decoded = decodeDnsMessage(reply);
      return {
        answers: decoded.answers.map((a) => ({
          name: a.name,
          type: typeName(a.type),
          ttl: a.ttl,
          data: a.data,
        })),
      };
    },
    async close() {
      /* stateless */
    },
  };
}

async function defaultConnect(config: Record<string, unknown>): Promise<DnsHandle> {
  if (config.simulator === true || !stringField(config, "host")) return createMemoryDns();
  return liveDns(config);
}

/** Unicast DNS A/AAAA/TXT/PTR. No AXFR, no recursive LAN walk, no mDNS multicast. */
export class DnsAdapter implements ProtocolAdapter {
  readonly protocol = "dns";
  private handle: DnsHandle | undefined;
  private connected = false;
  private host = "";

  constructor(
    readonly id: string,
    private readonly connectFn: DnsConnectFn = defaultConnect,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    this.host = stringField(config, "host") ?? (config.simulator === true ? "memory" : "127.0.0.1");
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
        name: "query",
        description: "Unicast DNS query (A/AAAA/TXT/PTR). Not AXFR / mDNS multicast.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            type: { type: "string", default: "A", description: "A | AAAA | TXT | PTR" },
          },
          required: ["name"],
          additionalProperties: false,
        },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    if (toolName === "query") {
      const name = requiredString(args, "name");
      const raw = typeof args.type === "string" ? args.type.toUpperCase() : "A";
      if (raw !== "A" && raw !== "AAAA" && raw !== "TXT" && raw !== "PTR") {
        throw new AdapterError("E_UNSUPPORTED", `DNS type ${raw} is not implemented`, { protocol: "dns" });
      }
      return this.handle!.query(name, raw);
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown DNS tool "${toolName}"`, { protocol: "dns" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return { ok: true, detail: `dns host=${this.host} (unicast A/AAAA/TXT/PTR; no AXFR)` };
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_NOT_CONNECTED", "DNS adapter is not connected", { protocol: "dns" });
    }
  }
}
