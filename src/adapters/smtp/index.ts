import { createConnection, createServer, type Socket } from "node:net";
import { TLSSocket } from "node:tls";
import nodemailer from "nodemailer";
import { AdapterError } from "../../runtime/errors.js";
import { assertHostAllowed } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { requiredString, stringField } from "../helpers.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";

export interface SmtpMail {
  from?: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  text?: string;
  html?: string;
}

export interface SmtpTransporter {
  sendMail(mail: SmtpMail): Promise<{ messageId: string }>;
  noop?(): Promise<{ ok: true; banner?: string }>;
  close?(): Promise<void> | void;
}

export type SmtpConnectFn = (config: Record<string, unknown>) => Promise<SmtpTransporter>;

function asAddressList(value: unknown): string | string[] | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const list = value.filter((x): x is string => typeof x === "string" && Boolean(x.trim()));
    return list.length ? list : undefined;
  }
  return undefined;
}

class LineSock {
  private leftover = "";
  constructor(private socket: Socket) {
    this.socket.on("error", () => undefined);
  }
  attach(socket: Socket): void {
    this.socket = socket;
    this.leftover = "";
    this.socket.on("error", () => undefined);
  }
  write(line: string): void {
    this.socket.write(`${line}\r\n`);
  }
  async readLine(timeoutMs: number): Promise<string> {
    if (this.leftover.includes("\n")) {
      const i = this.leftover.indexOf("\n");
      const line = this.leftover.slice(0, i).replace(/\r$/, "");
      this.leftover = this.leftover.slice(i + 1);
      return line;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new AdapterError("E_TIMEOUT", "SMTP timeout", { protocol: "smtp" })), timeoutMs);
      const onData = (chunk: Buffer) => {
        this.leftover += chunk.toString("utf8");
        if (this.leftover.includes("\n")) {
          this.socket.off("data", onData);
          clearTimeout(timer);
          resolve(this.readLine(timeoutMs));
        }
      };
      this.socket.on("data", onData);
      this.socket.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
}

async function expectCode(io: LineSock, timeoutMs: number, code: string): Promise<string> {
  const line = await io.readLine(timeoutMs);
  if (!line.startsWith(code)) {
    throw new AdapterError("E_PROTOCOL", `SMTP expected ${code}, got ${line}`, { protocol: "smtp" });
  }
  return line;
}

async function rawSmtp(config: Record<string, unknown>): Promise<SmtpTransporter> {
  const host = stringField(config, "host") ?? "127.0.0.1";
  await assertHostAllowed(host);
  const port = typeof config.port === "number" ? config.port : 25;
  const timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 4000;
  const wantStarttls = config.starttls === true;
  const tls = (config.tls ?? {}) as { rejectUnauthorized?: boolean; key?: string; cert?: string };
  const socket = await new Promise<Socket>((resolve, reject) => {
    const s = createConnection({ host, port, timeout: timeoutMs }, () => resolve(s));
    s.once("error", reject);
  });
  const io = new LineSock(socket);
  const banner = await expectCode(io, timeoutMs, "220");
  const ehlo = async () => {
    io.write("EHLO e2mcp.local");
    let last = await io.readLine(timeoutMs);
    const lines = [last];
    while (last.startsWith("250-")) {
      last = await io.readLine(timeoutMs);
      lines.push(last);
    }
    if (!last.startsWith("250")) throw new AdapterError("E_PROTOCOL", `SMTP EHLO: ${last}`, { protocol: "smtp" });
    return lines;
  };
  let caps = await ehlo();
  if (wantStarttls) {
    if (!caps.some((l) => /STARTTLS/i.test(l))) {
      try {
        io.write("QUIT");
        await io.readLine(Math.min(timeoutMs, 500)).catch(() => undefined);
      } catch {
        /* ignore */
      }
      socket.destroy();
      throw new AdapterError("E_UNSUPPORTED", "SMTP server did not advertise STARTTLS", { protocol: "smtp" });
    }
    io.write("STARTTLS");
    await expectCode(io, timeoutMs, "220");
    const upgraded = await new Promise<TLSSocket>((resolve, reject) => {
      const timer = setTimeout(() => reject(new AdapterError("E_TIMEOUT", "SMTP STARTTLS handshake timeout", { protocol: "smtp" })), timeoutMs);
      const t = new TLSSocket(socket, { isServer: false, rejectUnauthorized: tls.rejectUnauthorized === true });
      t.once("secureConnect", () => {
        clearTimeout(timer);
        resolve(t);
      });
      t.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    io.attach(upgraded);
    caps = await ehlo();
  }
  return {
    async sendMail(mail) {
      const from = mail.from ?? "everything2mcp@localhost";
      const rcpt = Array.isArray(mail.to) ? mail.to : [mail.to];
      io.write(`MAIL FROM:<${from}>`);
      await expectCode(io, timeoutMs, "250");
      for (const to of rcpt) {
        io.write(`RCPT TO:<${to}>`);
        await expectCode(io, timeoutMs, "250");
      }
      io.write("DATA");
      await expectCode(io, timeoutMs, "354");
      const body = [`From: ${from}`, `To: ${rcpt.join(", ")}`, `Subject: ${mail.subject}`, "", mail.text ?? "", "."].join("\r\n");
      io.write(body);
      const done = await expectCode(io, timeoutMs, "250");
      const id = done.match(/<[^>]+>/)?.[0] ?? `<e2mcp@${host}>`;
      return { messageId: id };
    },
    async noop() {
      io.write("NOOP");
      await expectCode(io, timeoutMs, "250");
      return { ok: true as const, banner };
    },
    async close() {
      try {
        io.write("QUIT");
        await io.readLine(Math.min(timeoutMs, 500)).catch(() => undefined);
      } catch {
        /* ignore */
      }
      socket.destroy();
    },
  };
}

export async function listenSmtpLoopback(): Promise<{ port: number; close: () => Promise<void>; inbox: SmtpMail[] }> {
  const inbox: SmtpMail[] = [];
  const server = createServer((socket) => bindSmtpSession(socket, inbox, false));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as { port: number }).port, inbox, close: () => new Promise((r) => server.close(() => r())) };
}

export async function listenSmtpStarttlsLoopback(key: string, cert: string): Promise<{
  port: number;
  close: () => Promise<void>;
  inbox: SmtpMail[];
}> {
  const inbox: SmtpMail[] = [];
  const server = createServer((socket) => bindSmtpSession(socket, inbox, true, key, cert));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as { port: number }).port, inbox, close: () => new Promise((r) => server.close(() => r())) };
}

function bindSmtpSession(socket: Socket, inbox: SmtpMail[], offerStarttls: boolean, key?: string, cert?: string): void {
  socket.on("error", () => undefined);
  let io: Socket = socket;
  let mailFrom = "";
  const rcpt: string[] = [];
  let dataMode = false;
  let dataBuf = "";
  const send = (line: string) => io.write(`${line}\r\n`);
  send("220 e2mcp SMTP ready");
  const onLine = (line: string) => {
    if (dataMode) {
      if (line === ".") {
        dataMode = false;
        const subject = dataBuf.match(/^Subject:\s*(.+)$/im)?.[1] ?? "";
        const text = dataBuf.split(/\r?\n\r?\n/).slice(1).join("\n");
        inbox.push({ from: mailFrom, to: [...rcpt], subject, text });
        send("250 2.0.0 Ok: queued as <loop@e2mcp>");
        return;
      }
      dataBuf += `${line}\r\n`;
      return;
    }
    const cmd = line.split(/\s+/)[0]?.toUpperCase() ?? "";
    if (cmd === "EHLO" || cmd === "HELO") {
      send("250-e2mcp");
      if (offerStarttls) send("250-STARTTLS");
      send("250 OK");
    } else if (cmd === "STARTTLS" && offerStarttls && key && cert) {
      send("220 Go ahead");
      io.removeAllListeners("data");
      const tls = new TLSSocket(io, { isServer: true, key, cert });
      io = tls;
      dataBuf = "";
      dataMode = false;
      attach();
    } else if (cmd === "MAIL") {
      mailFrom = line.match(/<([^>]+)>/)?.[1] ?? "";
      send("250 OK");
    } else if (cmd === "RCPT") {
      const to = line.match(/<([^>]+)>/)?.[1];
      if (to) rcpt.push(to);
      send("250 OK");
    } else if (cmd === "DATA") {
      dataMode = true;
      dataBuf = "";
      send("354 End data with <CR><LF>.<CR><LF>");
    } else if (cmd === "NOOP") send("250 OK");
    else if (cmd === "QUIT") {
      send("221 Bye");
      io.end();
    } else send("250 OK");
  };
  let buf = "";
  const attach = () => {
    buf = "";
    io.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        onLine(line);
      }
    });
  };
  attach();
}

async function defaultConnect(config: Record<string, unknown>): Promise<SmtpTransporter> {
  const host = stringField(config, "host") ?? "127.0.0.1";
  if (config.raw === true) return rawSmtp(config);
  const port = typeof config.port === "number" ? config.port : 587;
  const starttls = config.starttls !== false && config.secure !== true;
  const user = stringField(config, "user") ?? stringField(config, "username");
  const pass = stringField(config, "password") ?? stringField(config, "pass");
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: config.secure === true,
    requireTLS: starttls,
    auth: user ? { user, pass: pass ?? "" } : undefined,
    tls: { rejectUnauthorized: config.rejectUnauthorized === true },
  });
  return {
    async sendMail(mail) {
      const info = await transporter.sendMail(mail);
      return { messageId: String(info.messageId ?? "") };
    },
    async noop() {
      return { ok: true, banner: host };
    },
    close() {
      transporter.close();
    },
  };
}

export class SmtpAdapter implements ProtocolAdapter {
  readonly protocol = "smtp";
  private transporter: SmtpTransporter | undefined;
  private connected = false;
  private host = "";
  private from = "";
  private starttls = true;
  private allowWrite = false;

  constructor(
    readonly id: string,
    private readonly connectFn: SmtpConnectFn = defaultConnect,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    const host = stringField(config, "host") ?? stringField(config, "url");
    if (!host) throw new Error("SMTP adapter requires config.host");
    this.host = host.replace(/^smtps?:\/\//i, "");
    this.from = stringField(config, "from") ?? "everything2mcp@localhost";
    this.starttls = config.starttls !== false && config.secure !== true;
    this.allowWrite = allowWriteFrom(config);
    this.transporter = await this.connectFn({ ...config, host: this.host });
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.transporter?.close) await this.transporter.close();
    this.transporter = undefined;
    this.connected = false;
  }

  async listTools(): Promise<McpToolSchema[]> {
    this.assertConnected();
    return [
      {
        name: "send_mail",
        description: "Send an email (to / subject / body). Requires allowWrite=true.",
        inputSchema: {
          type: "object",
          properties: {
            to: { description: "Recipient address or list" },
            subject: { type: "string" },
            body: { type: "string", description: "Plain-text body" },
            html: { type: "string" },
            from: { type: "string" },
            cc: {},
            bcc: {},
            starttls: { type: "boolean", description: "Override session STARTTLS for this send (recorded only)" },
          },
          required: ["to", "subject"],
          additionalProperties: false,
        },
      },
      {
        name: "noop",
        description: "SMTP NOOP / session health (read; not IMAP/POP3)",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    if (toolName === "noop") {
      if (this.transporter?.noop) return this.transporter.noop();
      return { ok: true, banner: this.host };
    }
    if (toolName !== "send_mail") throw new Error(`Unknown SMTP tool "${toolName}"`);
    assertCanWrite("smtp", this.allowWrite);
    const to = asAddressList(args.to);
    if (!to) throw new Error('Missing required "to"');
    const subject = requiredString(args, "subject");
    const text = typeof args.body === "string" ? args.body : typeof args.text === "string" ? args.text : "";
    const html = typeof args.html === "string" ? args.html : undefined;
    if (!text && !html) throw new Error("send_mail requires body or html");
    const from = typeof args.from === "string" && args.from.trim() ? args.from.trim() : this.from;
    const starttls = typeof args.starttls === "boolean" ? args.starttls : this.starttls;
    const info = await this.transporter!.sendMail({
      from,
      to,
      cc: asAddressList(args.cc),
      bcc: asAddressList(args.bcc),
      subject,
      text: text || undefined,
      html,
    });
    return { ok: true, messageId: info.messageId, from, to, starttls };
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return { ok: true, detail: `host=${this.host} starttls=${this.starttls} allowWrite=${this.allowWrite}` };
  }

  private assertConnected(): void {
    if (!this.connected || !this.transporter) throw new Error("SMTP adapter is not connected");
  }
}
