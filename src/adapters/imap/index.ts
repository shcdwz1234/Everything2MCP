import { createConnection, createServer, type Socket } from "node:net";
import { AdapterError } from "../../runtime/errors.js";
import { assertHostAllowed } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";
import { requiredString, stringField } from "../helpers.js";

export interface ImapMessage {
  uid: number;
  mailbox: string;
  flags: string[];
  raw: string;
}

export interface ImapHandle {
  listMailboxes(): Promise<string[]>;
  select(mailbox: string): Promise<{ mailbox: string; exists: number }>;
  fetch(mailbox: string, uid: number): Promise<ImapMessage>;
  search(mailbox: string, query: string): Promise<number[]>;
  append(mailbox: string, raw: string): Promise<{ uid: number }>;
  storeDeleted(mailbox: string, uid: number): Promise<{ uid: number; flags: string[] }>;
  expunge(mailbox: string): Promise<{ expunged: number }>;
  close(): Promise<void>;
}

export type ImapConnectFn = (config: Record<string, unknown>) => Promise<ImapHandle>;

export function createMemoryImap(): ImapHandle {
  const boxes = new Map<string, ImapMessage[]>([
    ["INBOX", [{ uid: 1, mailbox: "INBOX", flags: [], raw: "From: a@b\r\nSubject: hi\r\n\r\nhello imap" }]],
  ]);
  let nextUid = 2;
  const box = (name: string) => {
    const list = boxes.get(name);
    if (!list) throw new AdapterError("E_NOT_FOUND", `Unknown mailbox ${name}`, { protocol: "imap" });
    return list;
  };
  return {
    async listMailboxes() {
      return [...boxes.keys()].sort();
    },
    async select(mailbox) {
      const list = box(mailbox);
      return { mailbox, exists: list.length };
    },
    async fetch(mailbox, uid) {
      const hit = box(mailbox).find((m) => m.uid === uid);
      if (!hit) throw new AdapterError("E_NOT_FOUND", `No IMAP uid ${uid}`, { protocol: "imap" });
      return { ...hit, flags: [...hit.flags] };
    },
    async search(mailbox, query) {
      const list = box(mailbox);
      const q = query.toUpperCase();
      return list
        .filter((m) => (q.includes("UNSEEN") ? !m.flags.includes("\\Seen") : true))
        .map((m) => m.uid);
    },
    async append(mailbox, raw) {
      const list = boxes.get(mailbox) ?? [];
      const msg: ImapMessage = { uid: nextUid++, mailbox, flags: [], raw };
      list.push(msg);
      boxes.set(mailbox, list);
      return { uid: msg.uid };
    },
    async storeDeleted(mailbox, uid) {
      const hit = box(mailbox).find((m) => m.uid === uid);
      if (!hit) throw new AdapterError("E_NOT_FOUND", `No IMAP uid ${uid}`, { protocol: "imap" });
      if (!hit.flags.includes("\\Deleted")) hit.flags.push("\\Deleted");
      return { uid, flags: [...hit.flags] };
    },
    async expunge(mailbox) {
      const list = box(mailbox);
      const before = list.length;
      boxes.set(mailbox, list.filter((m) => !m.flags.includes("\\Deleted")));
      return { expunged: before - (boxes.get(mailbox)?.length ?? 0) };
    },
    async close() {
      boxes.clear();
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
          reject(new AdapterError("E_TIMEOUT", "IMAP timeout", { protocol: "imap" }));
        }, timeoutMs),
      };
    });
  }
}

async function liveImap(config: Record<string, unknown>): Promise<ImapHandle> {
  const host = stringField(config, "host") ?? stringField(config, "url")?.replace(/^imaps?:\/\//i, "").split(":")[0];
  if (!host) throw new AdapterError("E_INVALID_CONFIG", "IMAP adapter requires config.host", { protocol: "imap" });
  await assertHostAllowed(host);
  const port = typeof config.port === "number" ? config.port : 143;
  const timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 4000;
  const user = stringField(config, "user") ?? stringField(config, "username") ?? "anonymous";
  const pass = stringField(config, "password") ?? stringField(config, "pass") ?? "";
  const socket = await new Promise<Socket>((resolve, reject) => {
    const s = createConnection({ host, port, timeout: timeoutMs }, () => resolve(s));
    s.once("error", reject);
  });
  const io = new LineSock(socket);
  const greet = await io.readLine(timeoutMs);
  if (!/^\*\s+OK/i.test(greet)) throw new AdapterError("E_PROTOCOL", `IMAP greeting: ${greet}`, { protocol: "imap" });
  let tag = 1;
  const cmd = async (line: string, until = "OK") => {
    const t = `A${tag++}`;
    io.write(`${t} ${line}`);
    const lines: string[] = [];
    for (;;) {
      const got = await io.readLine(timeoutMs);
      lines.push(got);
      if (got.startsWith(`${t} `)) {
        if (!got.includes(until) && !/ OK /i.test(got)) {
          throw new AdapterError("E_PROTOCOL", `IMAP ${line}: ${got}`, { protocol: "imap" });
        }
        return lines;
      }
    }
  };
  await cmd(`LOGIN ${user} ${pass}`);
  return {
    async listMailboxes() {
      const lines = await cmd(`LIST "" "*"`);
      return lines
        .filter((l) => /^\*\s+LIST/i.test(l))
        .map((l) => l.match(/"([^"]+)"\s*$/)?.[1] ?? l.split(/\s+/).pop() ?? "")
        .filter(Boolean);
    },
    async select(mailbox) {
      const lines = await cmd(`SELECT ${mailbox}`);
      const exists = Number(lines.find((l) => /EXISTS/i.test(l))?.match(/(\d+)\s+EXISTS/i)?.[1] ?? 0);
      return { mailbox, exists };
    },
    async fetch(mailbox, uid) {
      await cmd(`SELECT ${mailbox}`);
      const lines = await cmd(`UID FETCH ${uid} BODY.PEEK[]`);
      const raw = lines.filter((l) => !l.startsWith("A") && !l.startsWith("*")).join("\n") || lines.join("\n");
      return { uid, mailbox, flags: [], raw };
    },
    async search(mailbox, query) {
      await cmd(`SELECT ${mailbox}`);
      const lines = await cmd(`UID SEARCH ${query || "ALL"}`);
      const star = lines.find((l) => /^\*\s+SEARCH/i.test(l)) ?? "";
      return star
        .replace(/^\*\s+SEARCH/i, "")
        .trim()
        .split(/\s+/)
        .map(Number)
        .filter((n) => n > 0);
    },
    async append(mailbox, raw) {
      const t = `A${tag++}`;
      io.write(`${t} APPEND ${mailbox} {${Buffer.byteLength(raw)}}`);
      const ready = await io.readLine(timeoutMs);
      if (!ready.startsWith("+")) throw new AdapterError("E_PROTOCOL", `IMAP APPEND: ${ready}`, { protocol: "imap" });
      socket.write(`${raw}\r\n`);
      const done = await io.readLine(timeoutMs);
      if (!/ OK /i.test(done)) throw new AdapterError("E_PROTOCOL", `IMAP APPEND done: ${done}`, { protocol: "imap" });
      return { uid: nextFrom(done) };
    },
    async storeDeleted(mailbox, uid) {
      await cmd(`SELECT ${mailbox}`);
      await cmd(`UID STORE ${uid} +FLAGS (\\Deleted)`);
      return { uid, flags: ["\\Deleted"] };
    },
    async expunge(mailbox) {
      await cmd(`SELECT ${mailbox}`);
      const lines = await cmd("EXPUNGE");
      return { expunged: lines.filter((l) => /EXPUNGE/i.test(l) && l.startsWith("*")).length };
    },
    async close() {
      try {
        await cmd("LOGOUT");
      } catch {
        /* ignore */
      }
      socket.destroy();
    },
  };
}

function nextFrom(line: string): number {
  return Number(line.match(/APPENDUID\s+\d+\s+(\d+)/i)?.[1] ?? line.match(/UID\s+(\d+)/i)?.[1] ?? 0);
}

async function defaultConnect(config: Record<string, unknown>): Promise<ImapHandle> {
  const host = stringField(config, "host") ?? stringField(config, "url");
  if (config.simulator === true || !host) return createMemoryImap();
  return liveImap(config);
}

/** Minimal IMAP loopback for hermetic tests. */
export async function listenImapLoopback(): Promise<{ port: number; close: () => Promise<void> }> {
  const mem = createMemoryImap();
  const server = createServer((socket) => {
    let buf = Buffer.alloc(0);
    let selected = "INBOX";
    let pending: { tag: string; mailbox: string; size: number } | undefined;
    socket.write("* OK IMAP4rev1 e2mcp ready\r\n");
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const takeLine = (): string | undefined => {
        const idx = buf.indexOf(0x0a);
        if (idx < 0) return undefined;
        const line = buf.subarray(0, idx).toString("utf8").replace(/\r$/, "");
        buf = buf.subarray(idx + 1);
        return line;
      };
      void (async () => {
        for (;;) {
          if (pending) {
            if (buf.length < pending.size) return;
            const raw = buf.subarray(0, pending.size).toString("utf8");
            buf = buf.subarray(pending.size);
            if (buf[0] === 0x0d) buf = buf.subarray(1);
            if (buf[0] === 0x0a) buf = buf.subarray(1);
            const { tag, mailbox } = pending;
            pending = undefined;
            const appended = await mem.append(mailbox, raw);
            socket.write(`${tag} OK [APPENDUID 1 ${appended.uid}] APPEND\r\n`);
            continue;
          }
          const line = takeLine();
          if (line === undefined) return;
          const m = line.match(/^(\S+)\s+(\S+)\s*(.*)$/);
          if (!m) continue;
          const [, tag, cmd, rest] = m;
          const c = cmd!.toUpperCase();
          const ok = (msg = "completed") => socket.write(`${tag} OK ${msg}\r\n`);
          if (c === "LOGIN") ok("LOGIN");
          else if (c === "LIST") {
            for (const name of await mem.listMailboxes()) socket.write(`* LIST () "/" "${name}"\r\n`);
            ok("LIST");
          } else if (c === "SELECT") {
            selected = rest!.replace(/"/g, "") || "INBOX";
            const s = await mem.select(selected);
            socket.write(`* ${s.exists} EXISTS\r\n`);
            ok("SELECT");
          } else if (c === "APPEND") {
            const box = rest!.replace(/\{.*$/, "").replace(/"/g, "").trim() || "INBOX";
            const size = Number(rest!.match(/\{(\d+)\}/)?.[1] ?? 0);
            pending = { tag: tag!, mailbox: box, size };
            socket.write("+ Ready\r\n");
          } else if (c === "UID" && /^FETCH/i.test(rest ?? "")) {
            const uid = Number(rest!.match(/(\d+)/)?.[1] ?? 0);
            const msg = await mem.fetch(selected, uid);
            socket.write(`* 1 FETCH (UID ${uid} BODY[] {${Buffer.byteLength(msg.raw)}}\r\n${msg.raw})\r\n`);
            ok("FETCH");
          } else if (c === "UID" && /^SEARCH/i.test(rest ?? "")) {
            const ids = await mem.search(selected, rest!.replace(/^SEARCH\s+/i, ""));
            socket.write(`* SEARCH ${ids.join(" ")}\r\n`);
            ok("SEARCH");
          } else if (c === "UID" && /^STORE/i.test(rest ?? "")) {
            const uid = Number(rest!.match(/(\d+)/)?.[1] ?? 0);
            await mem.storeDeleted(selected, uid);
            ok("STORE");
          } else if (c === "EXPUNGE") {
            await mem.expunge(selected);
            ok("EXPUNGE");
          } else if (c === "LOGOUT") {
            socket.write("* BYE\r\n");
            ok("LOGOUT");
            socket.end();
          } else ok(c);
        }
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { port, close: () => new Promise((r) => server.close(() => r())) };
}

/** IMAP4rev1 read path. APPEND / STORE+EXPUNGE require allowWrite. Not IDLE/QRESYNC/IMAPS-only. */
export class ImapAdapter implements ProtocolAdapter {
  readonly protocol = "imap";
  private handle: ImapHandle | undefined;
  private connected = false;
  private allowWrite = false;

  constructor(
    readonly id: string,
    private readonly connectFn: ImapConnectFn = defaultConnect,
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
        name: "list_mailboxes",
        description: "LIST mailboxes (read)",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "select",
        description: "SELECT a mailbox",
        inputSchema: {
          type: "object",
          properties: { mailbox: { type: "string", default: "INBOX" } },
          additionalProperties: false,
        },
      },
      {
        name: "fetch",
        description: "UID FETCH BODY.PEEK (read; not SMTP send)",
        inputSchema: {
          type: "object",
          properties: { mailbox: { type: "string", default: "INBOX" }, uid: { type: "integer" } },
          required: ["uid"],
          additionalProperties: false,
        },
      },
      {
        name: "search",
        description: "UID SEARCH (ALL / UNSEEN)",
        inputSchema: {
          type: "object",
          properties: { mailbox: { type: "string", default: "INBOX" }, query: { type: "string", default: "ALL" } },
          additionalProperties: false,
        },
      },
      {
        name: "append",
        description: "APPEND a raw message (requires allowWrite=true; not SMTP)",
        inputSchema: {
          type: "object",
          properties: { mailbox: { type: "string", default: "INBOX" }, raw: { type: "string" } },
          required: ["raw"],
          additionalProperties: false,
        },
      },
      {
        name: "store_delete",
        description: "UID STORE +FLAGS \\Deleted (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: { mailbox: { type: "string", default: "INBOX" }, uid: { type: "integer" } },
          required: ["uid"],
          additionalProperties: false,
        },
      },
      {
        name: "expunge",
        description: "EXPUNGE deleted messages (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: { mailbox: { type: "string", default: "INBOX" } },
          additionalProperties: false,
        },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const h = this.handle!;
    const mailbox = typeof args.mailbox === "string" && args.mailbox.trim() ? args.mailbox : "INBOX";
    if (toolName === "list_mailboxes") return { mailboxes: await h.listMailboxes() };
    if (toolName === "select") return h.select(mailbox);
    if (toolName === "fetch") return h.fetch(mailbox, Number(args.uid));
    if (toolName === "search") return { uids: await h.search(mailbox, typeof args.query === "string" ? args.query : "ALL") };
    if (toolName === "append") {
      assertCanWrite("imap", this.allowWrite);
      return h.append(mailbox, requiredString(args, "raw"));
    }
    if (toolName === "store_delete") {
      assertCanWrite("imap", this.allowWrite);
      return h.storeDeleted(mailbox, Number(args.uid));
    }
    if (toolName === "expunge") {
      assertCanWrite("imap", this.allowWrite);
      return h.expunge(mailbox);
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown tool: ${toolName}`, { protocol: "imap" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected || !this.handle) return { ok: false, detail: "not connected" };
    try {
      await this.handle.listMailboxes();
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_INVALID_CONFIG", "IMAP adapter is not connected", { protocol: "imap" });
    }
  }
}
