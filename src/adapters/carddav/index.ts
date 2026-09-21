import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AdapterError } from "../../runtime/errors.js";
import { fetchSafe } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";
import { requiredString, stringField } from "../helpers.js";

export interface Card {
  href: string;
  uid: string;
  fn: string;
  vcf: string;
}

export interface CardDavHandle {
  propfind(path: string): Promise<Array<{ href: string; type: string }>>;
  report(path: string, filter?: string): Promise<Card[]>;
  get(path: string): Promise<{ path: string; body: string }>;
  put(path: string, body: string): Promise<{ path: string; uid: string }>;
  delete(path: string): Promise<{ path: string; deleted: true }>;
  mkcol(path: string): Promise<{ path: string; created: true }>;
  close(): Promise<void>;
}

export type CardDavConnectFn = (config: Record<string, unknown>) => Promise<CardDavHandle>;

const SAMPLE_VCF = ["BEGIN:VCARD", "VERSION:3.0", "UID:ada", "FN:Ada Lovelace", "EMAIL:ada@example.com", "END:VCARD", ""].join(
  "\r\n",
);

export function parseVcfMeta(vcf: string): { uid: string; fn: string } {
  const uid = vcf.match(/^UID:(.+)$/m)?.[1]?.trim() ?? "";
  const fn = vcf.match(/^FN:(.+)$/m)?.[1]?.trim() ?? "";
  return { uid, fn };
}

function norm(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return p.replace(/\/+/g, "/") || "/";
}

export function createMemoryCardDav(): CardDavHandle {
  const books = new Set<string>(["/addressbooks/user/default"]);
  const cards = new Map<string, string>([["/addressbooks/user/default/ada.vcf", SAMPLE_VCF]]);
  return {
    async propfind(path) {
      const root = norm(path).replace(/\/+$/, "") || "/";
      const out: Array<{ href: string; type: string }> = [];
      for (const c of books) {
        if (root === "/" || c === root || c.startsWith(`${root}/`)) out.push({ href: c, type: "addressbook" });
      }
      for (const href of cards.keys()) {
        if (root === "/" || href === root || href.startsWith(`${root}/`)) out.push({ href, type: "vcard" });
      }
      return out;
    },
    async report(path, filter) {
      const root = norm(path);
      const needle = (filter ?? "").toLowerCase();
      const out: Card[] = [];
      for (const [href, vcf] of cards) {
        if (root !== "/" && href !== root && !href.startsWith(root.endsWith("/") ? root : `${root}/`)) continue;
        const meta = parseVcfMeta(vcf);
        if (needle && !vcf.toLowerCase().includes(needle) && !meta.fn.toLowerCase().includes(needle)) continue;
        out.push({ href, uid: meta.uid, fn: meta.fn, vcf });
      }
      return out;
    },
    async get(path) {
      const p = norm(path);
      const body = cards.get(p);
      if (body === undefined) throw new AdapterError("E_NOT_FOUND", `No CardDAV resource ${p}`, { protocol: "carddav" });
      return { path: p, body };
    },
    async put(path, body) {
      const p = norm(path);
      cards.set(p, body);
      return { path: p, uid: parseVcfMeta(body).uid };
    },
    async delete(path) {
      const p = norm(path);
      cards.delete(p);
      books.delete(p);
      return { path: p, deleted: true as const };
    },
    async mkcol(path) {
      const p = norm(path).replace(/\/+$/, "") || "/";
      books.add(p);
      return { path: p, created: true as const };
    },
    async close() {
      cards.clear();
      books.clear();
    },
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function multistatus(items: Array<{ href: string; vcf?: string; addressbook?: boolean }>): string {
  const body = items
    .map((it) => {
      const rt = it.addressbook
        ? `<d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>`
        : `<d:resourcetype/>`;
      const data = it.vcf ? `<card:address-data>${escapeXml(it.vcf)}</card:address-data>` : "";
      return `<d:response><d:href>${it.href}</d:href><d:propstat><d:prop>${rt}${data}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
    })
    .join("");
  return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">${body}</d:multistatus>`;
}

export async function listenCardDavLoopback(): Promise<{ port: number; close: () => Promise<void> }> {
  const mem = createMemoryCardDav();
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

async function handleDav(req: IncomingMessage, res: ServerResponse, mem: CardDavHandle): Promise<void> {
  const url = req.url ?? "/";
  const method = (req.method ?? "GET").toUpperCase();
  const send = (status: number, body: string, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/xml; charset=utf-8", ...headers });
    res.end(body);
  };
  if (method === "OPTIONS") {
    res.writeHead(200, {
      DAV: "1, 2, addressbook",
      Allow: "OPTIONS, GET, PUT, DELETE, PROPFIND, REPORT, MKCOL",
    });
    res.end();
    return;
  }
  try {
    if (method === "PROPFIND") {
      await readBody(req);
      const entries = await mem.propfind(url);
      send(207, multistatus(entries.map((e) => ({ href: e.href, addressbook: e.type === "addressbook" }))));
      return;
    }
    if (method === "REPORT") {
      const xml = await readBody(req);
      const filter = xml.match(/<[^>]*text-match[^>]*>([^<]+)</i)?.[1] ?? "";
      const found = await mem.report(url, filter);
      send(207, multistatus(found.map((e) => ({ href: e.href, vcf: e.vcf }))));
      return;
    }
    if (method === "GET") {
      const got = await mem.get(url);
      res.writeHead(200, { "content-type": "text/vcard" });
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
    if (method === "MKCOL") {
      await readBody(req);
      await mem.mkcol(url);
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

async function httpHandle(base: string, timeoutMs: number): Promise<CardDavHandle> {
  const root = base.replace(/\/+$/, "");
  const req = async (method: string, path: string, body?: string, headers: Record<string, string> = {}) => {
    const url = path.startsWith("http") ? path : `${root}${norm(path)}`;
    const res = await fetchSafe(url, { method, body, headers, timeoutMs });
    const text = await res.text();
    if (res.status === 404) throw new AdapterError("E_NOT_FOUND", `CardDAV ${method} ${path} → 404`, { protocol: "carddav" });
    if (res.status >= 400) {
      throw new AdapterError("E_PROTOCOL", `CardDAV ${method} ${res.status}: ${text.slice(0, 200)}`, { protocol: "carddav" });
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
      return hrefs.map((href) => ({ href, type: /addressbook/i.test(text) ? "addressbook" : "resource" }));
    },
    async report(path, filter) {
      const xml = `<?xml version="1.0"?><card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><card:address-data/></d:prop>${
        filter ? `<card:filter><card:prop-filter name="FN"><card:text-match>${filter}</card:text-match></card:prop-filter></card:filter>` : ""
      }</card:addressbook-query>`;
      const { text } = await req("REPORT", path, xml, { Depth: "1", "Content-Type": "application/xml" });
      const blocks = [...text.matchAll(/<d:href>([^<]+)<\/d:href>[\s\S]*?<card:address-data>([\s\S]*?)<\/card:address-data>/gi)];
      return blocks.map((m) => {
        const vcf = (m[2] ?? "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
        const meta = parseVcfMeta(vcf);
        return { href: m[1]!.trim(), uid: meta.uid, fn: meta.fn, vcf };
      });
    },
    async get(path) {
      const { text } = await req("GET", path);
      return { path: norm(path), body: text };
    },
    async put(path, body) {
      await req("PUT", path, body, { "Content-Type": "text/vcard" });
      return { path: norm(path), uid: parseVcfMeta(body).uid };
    },
    async delete(path) {
      await req("DELETE", path);
      return { path: norm(path), deleted: true as const };
    },
    async mkcol(path) {
      await req("MKCOL", path);
      return { path: norm(path), created: true as const };
    },
    async close() {
      /* stateless */
    },
  };
}

async function defaultConnect(config: Record<string, unknown>): Promise<CardDavHandle> {
  const url = stringField(config, "url") ?? stringField(config, "baseUrl");
  if (config.simulator === true || !url) return createMemoryCardDav();
  const timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 4000;
  return httpHandle(url, timeoutMs);
}

/** CardDAV RFC6352 subset: PROPFIND / REPORT addressbook-query / GET / PUT. Writes need allowWrite. */
export class CardDavAdapter implements ProtocolAdapter {
  readonly protocol = "carddav";
  private handle: CardDavHandle | undefined;
  private connected = false;
  private allowWrite = false;

  constructor(
    readonly id: string,
    private readonly connectFn: CardDavConnectFn = defaultConnect,
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
        description: "PROPFIND addressbooks and vCards",
        inputSchema: { type: "object", properties: { path: { type: "string", default: "/" } }, additionalProperties: false },
      },
      {
        name: "report",
        description: "REPORT addressbook-query (optional text filter)",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string", default: "/" }, filter: { type: "string" } },
          additionalProperties: false,
        },
      },
      {
        name: "get",
        description: "GET a vCard",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
      },
      {
        name: "put",
        description: "PUT a vCard (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" }, body: { type: "string" } },
          required: ["path", "body"],
          additionalProperties: false,
        },
      },
      {
        name: "delete",
        description: "DELETE a vCard (requires allowWrite=true)",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
      },
      {
        name: "mkcol",
        description: "MKCOL addressbook (requires allowWrite=true)",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const h = this.handle!;
    const path = typeof args.path === "string" && args.path.trim() ? args.path : "/";
    if (toolName === "propfind") return { entries: await h.propfind(path) };
    if (toolName === "report") return { cards: await h.report(path, typeof args.filter === "string" ? args.filter : undefined) };
    if (toolName === "get") return h.get(requiredString(args, "path"));
    if (toolName === "put") {
      assertCanWrite("carddav", this.allowWrite);
      return h.put(requiredString(args, "path"), requiredString(args, "body"));
    }
    if (toolName === "delete") {
      assertCanWrite("carddav", this.allowWrite);
      return h.delete(requiredString(args, "path"));
    }
    if (toolName === "mkcol") {
      assertCanWrite("carddav", this.allowWrite);
      return h.mkcol(requiredString(args, "path"));
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown tool: ${toolName}`, { protocol: "carddav" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected || !this.handle) return { ok: false, detail: "not connected" };
    try {
      await this.handle.propfind("/");
      return { ok: true, detail: "carddav rfc6352" };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_INVALID_CONFIG", "CardDAV adapter is not connected", { protocol: "carddav" });
    }
  }
}
