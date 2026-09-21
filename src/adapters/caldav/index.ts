import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AdapterError } from "../../runtime/errors.js";
import { fetchSafe } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";
import { requiredString, stringField } from "../helpers.js";

export interface CalEvent {
  href: string;
  uid: string;
  summary: string;
  ics: string;
  dtstart?: string;
  dtend?: string;
}

export interface CalReportOpts {
  filter?: string;
  start?: string;
  end?: string;
}

export interface CalDavHandle {
  propfind(path: string): Promise<Array<{ href: string; type: string }>>;
  report(path: string, filter?: string | CalReportOpts): Promise<CalEvent[]>;
  get(path: string): Promise<{ path: string; body: string }>;
  put(path: string, body: string): Promise<{ path: string; uid: string }>;
  delete(path: string): Promise<{ path: string; deleted: true }>;
  mkcalendar(path: string): Promise<{ path: string; created: true }>;
  freebusy?(start: string, end: string): Promise<Array<{ start: string; end: string; uid: string }>>;
  close(): Promise<void>;
}

export type CalDavConnectFn = (config: Record<string, unknown>) => Promise<CalDavHandle>;

const SAMPLE_ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//everything2mcp//caldav//EN",
  "BEGIN:VEVENT",
  "UID:evt-1",
  "DTSTART:20260922T100000Z",
  "DTEND:20260922T110000Z",
  "SUMMARY:Standup",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

export function parseIcsMeta(ics: string): { uid: string; summary: string; dtstart?: string; dtend?: string } {
  const uid = ics.match(/^UID:(.+)$/m)?.[1]?.trim() ?? "";
  const summary = ics.match(/^SUMMARY:(.+)$/m)?.[1]?.trim() ?? "";
  const dtstart = ics.match(/^DTSTART[^:]*:(.+)$/m)?.[1]?.trim();
  const dtend = ics.match(/^DTEND[^:]*:(.+)$/m)?.[1]?.trim();
  return { uid, summary, dtstart, dtend };
}

export function parseIcsDate(raw: string): number | undefined {
  const m = raw.trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?/);
  if (!m) {
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : undefined;
  }
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
}

function eventOverlaps(ics: string, start?: string, end?: string): boolean {
  if (!start && !end) return true;
  const meta = parseIcsMeta(ics);
  const evStart = meta.dtstart ? parseIcsDate(meta.dtstart) : undefined;
  const evEnd = meta.dtend ? parseIcsDate(meta.dtend) : evStart !== undefined ? evStart + 3600_000 : undefined;
  const winStart = start ? parseIcsDate(start) : undefined;
  const winEnd = end ? parseIcsDate(end) : undefined;
  if (evStart === undefined) return true;
  if (winEnd !== undefined && evStart >= winEnd) return false;
  if (winStart !== undefined && evEnd !== undefined && evEnd <= winStart) return false;
  if (winStart !== undefined && evEnd === undefined && evStart < winStart) return false;
  return true;
}

function asReportOpts(filter?: string | CalReportOpts): CalReportOpts {
  if (!filter) return {};
  if (typeof filter === "string") return { filter };
  return filter;
}

function norm(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return p.replace(/\/+/g, "/") || "/";
}

export function createMemoryCalDav(): CalDavHandle {
  const calendars = new Set<string>(["/calendars/user/default"]);
  const events = new Map<string, string>([["/calendars/user/default/evt-1.ics", SAMPLE_ICS]]);
  return {
    async propfind(path) {
      const root = norm(path).replace(/\/+$/, "") || "/";
      const out: Array<{ href: string; type: string }> = [];
      for (const c of calendars) {
        if (root === "/" || c === root || c.startsWith(`${root}/`)) out.push({ href: c, type: "calendar" });
      }
      for (const href of events.keys()) {
        if (root === "/" || href === root || href.startsWith(`${root}/`)) out.push({ href, type: "vevent" });
      }
      return out;
    },
    async report(path, filter) {
      const root = norm(path);
      const opts = asReportOpts(filter);
      const needle = (opts.filter ?? "").toLowerCase();
      const out: CalEvent[] = [];
      for (const [href, ics] of events) {
        if (root !== "/" && href !== root && !href.startsWith(root.endsWith("/") ? root : `${root}/`)) continue;
        const meta = parseIcsMeta(ics);
        if (needle && !ics.toLowerCase().includes(needle) && !meta.summary.toLowerCase().includes(needle)) continue;
        if (!eventOverlaps(ics, opts.start, opts.end)) continue;
        out.push({ href, uid: meta.uid, summary: meta.summary, ics, dtstart: meta.dtstart, dtend: meta.dtend });
      }
      return out;
    },
    async get(path) {
      const p = norm(path);
      const body = events.get(p);
      if (body === undefined) throw new AdapterError("E_NOT_FOUND", `No CalDAV resource ${p}`, { protocol: "caldav" });
      return { path: p, body };
    },
    async put(path, body) {
      const p = norm(path);
      events.set(p, body);
      return { path: p, uid: parseIcsMeta(body).uid };
    },
    async delete(path) {
      const p = norm(path);
      events.delete(p);
      calendars.delete(p);
      return { path: p, deleted: true as const };
    },
    async mkcalendar(path) {
      const p = norm(path).replace(/\/+$/, "") || "/";
      calendars.add(p);
      return { path: p, created: true as const };
    },
    async freebusy(start, end) {
      const evs = await this.report("/", { start, end });
      return evs
        .filter((e) => e.dtstart)
        .map((e) => ({ start: e.dtstart!, end: e.dtend ?? e.dtstart!, uid: e.uid }));
    },
    async close() {
      events.clear();
      calendars.clear();
    },
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function multistatus(items: Array<{ href: string; ics?: string; calendar?: boolean }>): string {
  const body = items
    .map((it) => {
      const rt = it.calendar
        ? `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>`
        : `<d:resourcetype/>`;
      const data = it.ics ? `<c:calendar-data>${escapeXml(it.ics)}</c:calendar-data>` : "";
      return `<d:response><d:href>${it.href}</d:href><d:propstat><d:prop>${rt}${data}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
    })
    .join("");
  return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${body}</d:multistatus>`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function listenCalDavLoopback(): Promise<{ port: number; close: () => Promise<void> }> {
  const mem = createMemoryCalDav();
  const server = createServer((req, res) => {
    void handleDav(req, res, mem);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    port: (server.address() as { port: number }).port,
    close: () =>
      new Promise((r) => {
        server.close(() => r());
        (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      }),
  };
}

async function handleDav(req: IncomingMessage, res: ServerResponse, mem: CalDavHandle): Promise<void> {
  const url = req.url ?? "/";
  const method = (req.method ?? "GET").toUpperCase();
  const send = (status: number, body: string, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/xml; charset=utf-8", ...headers });
    res.end(body);
  };
  if (method === "OPTIONS") {
    res.writeHead(200, {
      DAV: "1, 2, calendar-access, calendar-schedule",
      Allow: "OPTIONS, GET, PUT, DELETE, PROPFIND, REPORT, MKCALENDAR",
    });
    res.end();
    return;
  }
  try {
    if (method === "PROPFIND") {
      await readBody(req);
      const entries = await mem.propfind(url);
      send(207, multistatus(entries.map((e) => ({ href: e.href, calendar: e.type === "calendar" }))));
      return;
    }
    if (method === "REPORT") {
      const xml = await readBody(req);
      const filter = xml.match(/<[^>]*text-match[^>]*>([^<]+)</i)?.[1] ?? "";
      const start = xml.match(/time-range[^>]*start="([^"]+)"/i)?.[1];
      const end = xml.match(/time-range[^>]*end="([^"]+)"/i)?.[1];
      if (/free-busy-query|freebusy/i.test(xml) && mem.freebusy) {
        const busy = await mem.freebusy(start ?? "19700101T000000Z", end ?? "21000101T000000Z");
        send(207, `<?xml version="1.0"?><c:schedule-response xmlns:c="urn:ietf:params:xml:ns:caldav">${busy
          .map((b) => `<c:busy start="${b.start}" end="${b.end}" uid="${b.uid}"/>`)
          .join("")}</c:schedule-response>`);
        return;
      }
      const events = await mem.report(url, { filter, start, end });
      send(207, multistatus(events.map((e) => ({ href: e.href, ics: e.ics }))));
      return;
    }
    if (method === "GET") {
      const got = await mem.get(url);
      res.writeHead(200, { "content-type": "text/calendar" });
      res.end(got.body);
      return;
    }
    if (method === "PUT") {
      const body = await readBody(req);
      await mem.put(url, body);
      send(201, "", { "content-type": "text/plain" });
      return;
    }
    if (method === "DELETE") {
      await mem.delete(url);
      res.writeHead(204);
      res.end();
      return;
    }
    if (method === "MKCALENDAR") {
      await readBody(req);
      await mem.mkcalendar(url);
      send(201, "");
      return;
    }
    res.writeHead(405);
    res.end();
  } catch (err) {
    const code = err instanceof AdapterError && err.code === "E_NOT_FOUND" ? 404 : 500;
    res.writeHead(code);
    res.end(err instanceof Error ? err.message : String(err));
  }
}

async function httpHandle(base: string, timeoutMs: number): Promise<CalDavHandle> {
  const root = base.replace(/\/+$/, "");
  const req = async (method: string, path: string, body?: string, headers: Record<string, string> = {}) => {
    const url = path.startsWith("http") ? path : `${root}${norm(path)}`;
    const res = await fetchSafe(url, { method, body, headers, timeoutMs });
    const text = await res.text();
    if (res.status === 404) throw new AdapterError("E_NOT_FOUND", `CalDAV ${method} ${path} → 404`, { protocol: "caldav" });
    if (res.status >= 400) {
      throw new AdapterError("E_PROTOCOL", `CalDAV ${method} ${res.status}: ${text.slice(0, 200)}`, { protocol: "caldav" });
    }
    return { status: res.status, text };
  };
  return {
    async propfind(path) {
      const { text } = await req("PROPFIND", path, `<?xml version="1.0"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>`, {
        Depth: "1",
        "Content-Type": "application/xml",
      });
      const hrefs = [...text.matchAll(/<[^>]*href[^>]*>([^<]+)<\//gi)].map((m) => m[1]!.trim());
      return hrefs.map((href) => ({ href, type: /calendar/i.test(text) ? "calendar" : "resource" }));
    },
    async report(path, filter) {
      const opts = asReportOpts(filter);
      const range =
        opts.start || opts.end
          ? `<c:time-range${opts.start ? ` start="${opts.start}"` : ""}${opts.end ? ` end="${opts.end}"` : ""}/>`
          : "";
      const xml = `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data/></d:prop>${
        opts.filter || range
          ? `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">${opts.filter ? `<c:text-match>${opts.filter}</c:text-match>` : ""}${range}</c:comp-filter></c:comp-filter></c:filter>`
          : ""
      }</c:calendar-query>`;
      const { text } = await req("REPORT", path, xml, { Depth: "1", "Content-Type": "application/xml" });
      const blocks = [...text.matchAll(/<d:href>([^<]+)<\/d:href>[\s\S]*?<c:calendar-data>([\s\S]*?)<\/c:calendar-data>/gi)];
      return blocks.map((m) => {
        const ics = (m[2] ?? "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
        const meta = parseIcsMeta(ics);
        return { href: m[1]!.trim(), uid: meta.uid, summary: meta.summary, ics };
      });
    },
    async get(path) {
      const { text } = await req("GET", path);
      return { path: norm(path), body: text };
    },
    async put(path, body) {
      await req("PUT", path, body, { "Content-Type": "text/calendar" });
      return { path: norm(path), uid: parseIcsMeta(body).uid };
    },
    async delete(path) {
      await req("DELETE", path);
      return { path: norm(path), deleted: true as const };
    },
    async mkcalendar(path) {
      await req("MKCALENDAR", path, `<?xml version="1.0"?><c:mkcalendar xmlns:c="urn:ietf:params:xml:ns:caldav"/>`, {
        "Content-Type": "application/xml",
      });
      return { path: norm(path), created: true as const };
    },
    async freebusy(start, end) {
      const xml = `<?xml version="1.0"?><c:free-busy-query xmlns:c="urn:ietf:params:xml:ns:caldav"><c:time-range start="${start}" end="${end}"/></c:free-busy-query>`;
      const { text } = await req("REPORT", "/", xml, { Depth: "1", "Content-Type": "application/xml" });
      return [...text.matchAll(/busy start="([^"]+)" end="([^"]+)" uid="([^"]+)"/gi)].map((m) => ({
        start: m[1]!,
        end: m[2]!,
        uid: m[3]!,
      }));
    },
    async close() {
      /* stateless */
    },
  };
}

async function defaultConnect(config: Record<string, unknown>): Promise<CalDavHandle> {
  const url = stringField(config, "url") ?? stringField(config, "baseUrl");
  if (config.simulator === true || !url) return createMemoryCalDav();
  const timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 4000;
  return httpHandle(url, timeoutMs);
}

/** CalDAV RFC4791 subset: PROPFIND / REPORT calendar-query / GET / PUT / MKCALENDAR. Writes need allowWrite. */
export class CalDavAdapter implements ProtocolAdapter {
  readonly protocol = "caldav";
  private handle: CalDavHandle | undefined;
  private connected = false;
  private allowWrite = false;

  constructor(
    readonly id: string,
    private readonly connectFn: CalDavConnectFn = defaultConnect,
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
        name: "propfind",
        description: "PROPFIND calendar collections and events",
        inputSchema: { type: "object", properties: { path: { type: "string", default: "/" } }, additionalProperties: false },
      },
      {
        name: "report",
        description: "REPORT calendar-query (optional text filter)",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", default: "/" },
            filter: { type: "string" },
            start: { type: "string", description: "time-range start (ICS or ISO)" },
            end: { type: "string", description: "time-range end" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "freebusy",
        description: "free-busy-query subset (not full iTIP scheduling)",
        inputSchema: {
          type: "object",
          properties: { start: { type: "string" }, end: { type: "string" } },
          required: ["start", "end"],
          additionalProperties: false,
        },
      },
      {
        name: "schedule",
        description: "full iTIP scheduling is E_UNSUPPORTED",
        inputSchema: { type: "object", properties: { body: { type: "string" } }, additionalProperties: false },
      },
      {
        name: "get",
        description: "GET a calendar object (.ics)",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
      },
      {
        name: "put",
        description: "PUT a calendar object (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" }, body: { type: "string" } },
          required: ["path", "body"],
          additionalProperties: false,
        },
      },
      {
        name: "delete",
        description: "DELETE a calendar object (requires allowWrite=true)",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
      },
      {
        name: "mkcalendar",
        description: "MKCALENDAR (requires allowWrite=true)",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const h = this.handle!;
    const path = typeof args.path === "string" && args.path.trim() ? args.path : "/";
    if (toolName === "propfind") return { entries: await h.propfind(path) };
    if (toolName === "report") {
      return {
        events: await h.report(path, {
          filter: typeof args.filter === "string" ? args.filter : undefined,
          start: typeof args.start === "string" ? args.start : undefined,
          end: typeof args.end === "string" ? args.end : undefined,
        }),
      };
    }
    if (toolName === "freebusy") {
      if (!h.freebusy) throw new AdapterError("E_UNSUPPORTED", "CalDAV handle has no freebusy", { protocol: "caldav" });
      return { busy: await h.freebusy(requiredString(args, "start"), requiredString(args, "end")) };
    }
    if (toolName === "schedule") {
      throw new AdapterError("E_UNSUPPORTED", "CalDAV iTIP scheduling (REQUEST/REPLY) is not implemented; use freebusy", {
        protocol: "caldav",
      });
    }
    if (toolName === "get") return h.get(requiredString(args, "path"));
    if (toolName === "put") {
      assertCanWrite("caldav", this.allowWrite);
      return h.put(requiredString(args, "path"), requiredString(args, "body"));
    }
    if (toolName === "delete") {
      assertCanWrite("caldav", this.allowWrite);
      return h.delete(requiredString(args, "path"));
    }
    if (toolName === "mkcalendar") {
      assertCanWrite("caldav", this.allowWrite);
      return h.mkcalendar(requiredString(args, "path"));
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown tool: ${toolName}`, { protocol: "caldav" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected || !this.handle) return { ok: false, detail: "not connected" };
    try {
      await this.handle.propfind("/");
      return { ok: true, detail: "caldav rfc4791" };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_INVALID_CONFIG", "CalDAV adapter is not connected", { protocol: "caldav" });
    }
  }
}
