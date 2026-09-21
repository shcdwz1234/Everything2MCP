import { createConnection, createServer, type Socket } from "node:net";
import { AdapterError } from "../../runtime/errors.js";
import { assertHostAllowed } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { requiredString, stringField } from "../helpers.js";

export interface WhoisHandle {
  query(name: string): Promise<{ query: string; text: string }>;
  close(): Promise<void>;
}

export type WhoisConnectFn = (config: Record<string, unknown>) => Promise<WhoisHandle>;

export function createMemoryWhois(seed?: Record<string, string>): WhoisHandle {
  const records = new Map<string, string>(
    Object.entries(seed ?? {
      "example.test": "Domain Name: EXAMPLE.TEST\nRegistrar: e2mcp\nWhois Server: whois.example.test\n",
    }),
  );
  return {
    async query(name) {
      const key = name.trim().toLowerCase();
      const text = records.get(key);
      if (text) return { query: name, text };
      return { query: name, text: `No match for "${name}".\n` };
    },
    async close() {
      records.clear();
    },
  };
}

async function liveWhois(config: Record<string, unknown>): Promise<WhoisHandle> {
  const host = stringField(config, "host") ?? stringField(config, "url")?.replace(/^whois:\/\//i, "").split(":")[0];
  if (!host) throw new AdapterError("E_INVALID_CONFIG", "whois adapter requires config.host", { protocol: "whois" });
  await assertHostAllowed(host);
  const port = typeof config.port === "number" ? config.port : 43;
  const timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 4000;
  return {
    async query(name) {
      const socket = await new Promise<Socket>((resolve, reject) => {
        const s = createConnection({ host, port, timeout: timeoutMs }, () => resolve(s));
        s.once("error", reject);
      });
      const text = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new AdapterError("E_TIMEOUT", "whois timeout", { protocol: "whois" }));
        }, timeoutMs);
        socket.on("data", (d) => chunks.push(d));
        socket.on("end", () => {
          clearTimeout(timer);
          resolve(Buffer.concat(chunks).toString("utf8"));
        });
        socket.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        socket.write(`${name}\r\n`);
      });
      return { query: name, text };
    },
    async close() {
      /* per-query sockets */
    },
  };
}

async function defaultConnect(config: Record<string, unknown>): Promise<WhoisHandle> {
  const host = stringField(config, "host") ?? stringField(config, "url");
  if (config.simulator === true || !host) return createMemoryWhois();
  return liveWhois(config);
}

export async function listenWhoisLoopback(
  records?: Record<string, string>,
): Promise<{ port: number; close: () => Promise<void> }> {
  const mem = createMemoryWhois(records);
  const server = createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      if (!buf.includes("\n")) return;
      const query = buf.split(/\r?\n/)[0]?.trim() ?? "";
      void mem.query(query).then((r) => {
        socket.write(r.text);
        socket.end();
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as { port: number }).port, close: () => new Promise((r) => server.close(() => r())) };
}

/** Whois TCP 43. Query only; no writes. Memory or live loopback. */
export class WhoisAdapter implements ProtocolAdapter {
  readonly protocol = "whois";
  private handle: WhoisHandle | undefined;
  private connected = false;

  constructor(
    readonly id: string,
    private readonly connectFn: WhoisConnectFn = defaultConnect,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
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
        description: "WHOIS query over TCP 43 (read-only)",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    if (toolName === "query") return this.handle!.query(requiredString(args, "name"));
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown whois tool "${toolName}"`, { protocol: "whois" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return { ok: true, detail: "whois TCP 43 query (read-only)" };
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_NOT_CONNECTED", "whois adapter is not connected", { protocol: "whois" });
    }
  }
}
