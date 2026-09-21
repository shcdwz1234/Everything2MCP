import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AdapterError } from "../../runtime/errors.js";
import { fetchSafe } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";
import { requiredString, stringField } from "../helpers.js";

export interface SolrDoc {
  id: string;
  [key: string]: unknown;
}

export interface SolrHandle {
  listCores(): Promise<string[]>;
  select(core: string, q: string, rows: number): Promise<{ numFound: number; docs: SolrDoc[] }>;
  update(core: string, docs: SolrDoc[]): Promise<{ added: number }>;
  close(): Promise<void>;
}

export type SolrConnectFn = (config: Record<string, unknown>) => Promise<SolrHandle>;

function matchQuery(doc: SolrDoc, q: string): boolean {
  const query = q.trim();
  if (!query || query === "*:*" || query === "*") return true;
  const field = /^([A-Za-z0-9_]+):(.+)$/.exec(query);
  if (field) {
    const raw = field[2]!.replace(/^["']|["']$/g, "");
    return String(doc[field[1]!]) === raw;
  }
  return Object.values(doc).some((v) => String(v).toLowerCase().includes(query.toLowerCase()));
}

export function createMemorySolr(): SolrHandle {
  const cores = new Map<string, SolrDoc[]>();
  return {
    async listCores() {
      return [...cores.keys()].sort();
    },
    async select(core, q, rows) {
      const docs = (cores.get(core) ?? []).filter((d) => matchQuery(d, q));
      return { numFound: docs.length, docs: docs.slice(0, rows) };
    },
    async update(core, docs) {
      const list = cores.get(core) ?? [];
      for (const doc of docs) {
        const id = String(doc.id ?? `doc_${list.length + 1}`);
        const stored = { ...doc, id };
        const i = list.findIndex((d) => d.id === id);
        if (i >= 0) list[i] = stored;
        else list.push(stored);
      }
      cores.set(core, list);
      return { added: docs.length };
    },
    async close() {
      cores.clear();
    },
  };
}

async function httpSolr(base: string, timeoutMs: number): Promise<SolrHandle> {
  const root = base.replace(/\/+$/, "");
  const request = async (method: string, path: string, body?: unknown) => {
    const res = await fetchSafe(`${root}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs,
    });
    const text = await res.text();
    if (res.status >= 400) {
      throw new AdapterError("E_PROTOCOL", `solr ${method} ${path} ${res.status}: ${text.slice(0, 200)}`, {
        protocol: "solr",
      });
    }
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  };
  return {
    async listCores() {
      const json = await request("GET", "/solr/admin/cores?action=STATUS&wt=json");
      const status = json.status && typeof json.status === "object" ? (json.status as Record<string, unknown>) : {};
      return Object.keys(status).sort();
    },
    async select(core, q, rows) {
      const path = `/solr/${encodeURIComponent(core)}/select?q=${encodeURIComponent(q)}&rows=${rows}&wt=json`;
      const json = await request("GET", path);
      const response = (json.response as { numFound?: number; docs?: SolrDoc[] } | undefined) ?? {};
      return { numFound: Number(response.numFound ?? 0), docs: response.docs ?? [] };
    },
    async update(core, docs) {
      await request("POST", `/solr/${encodeURIComponent(core)}/update?commit=true&wt=json`, docs);
      return { added: docs.length };
    },
    async close() {
      /* stateless */
    },
  };
}

async function defaultConnect(config: Record<string, unknown>): Promise<SolrHandle> {
  const url = stringField(config, "url") ?? stringField(config, "endpoint");
  if (config.simulator === true || !url) return createMemorySolr();
  const timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 4000;
  return httpSolr(url, timeoutMs);
}

export async function listenSolrLoopback(mem: SolrHandle = createMemorySolr()): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const raw = req.url ?? "/";
        const [path, qs] = raw.split("?");
        const params = new URLSearchParams(qs ?? "");
        res.setHeader("content-type", "application/json");
        try {
          if (req.method === "GET" && (path === "/" || path === "/solr/" || path === "/solr/admin/info/system")) {
            res.end(JSON.stringify({ lucene: { solr_spec_version: "9.0.0-e2mcp" }, solr_home: "/e2mcp" }));
            return;
          }
          if (req.method === "GET" && path === "/solr/admin/cores") {
            const cores = await mem.listCores();
            const status: Record<string, { name: string }> = {};
            for (const name of cores) status[name] = { name };
            res.end(JSON.stringify({ status }));
            return;
          }
          const select = /^\/solr\/([^/]+)\/select$/.exec(path ?? "");
          if (req.method === "GET" && select) {
            const q = params.get("q") ?? "*:*";
            const rows = Number(params.get("rows") ?? 10);
            const hit = await mem.select(decodeURIComponent(select[1]!), q, rows);
            res.end(JSON.stringify({ response: { numFound: hit.numFound, docs: hit.docs } }));
            return;
          }
          const update = /^\/solr\/([^/]+)\/update$/.exec(path ?? "");
          if (req.method === "POST" && update) {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "[]") as unknown;
            const docs = Array.isArray(body)
              ? (body as SolrDoc[])
              : body && typeof body === "object" && "add" in (body as object)
                ? [((body as { add: { doc?: SolrDoc } }).add.doc ?? { id: "x" }) as SolrDoc]
                : [];
            await mem.update(decodeURIComponent(update[1]!), docs);
            res.end(JSON.stringify({ responseHeader: { status: 0 } }));
            return;
          }
          res.statusCode = 404;
          res.end(JSON.stringify({ error: { msg: "not found" } }));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: { msg: err instanceof Error ? err.message : String(err) } }));
        }
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as { port: number }).port, close: () => new Promise((r) => server.close(() => r())) };
}

/** Solr HTTP select/update. Memory or unsigned HTTP. Not SolrCloud collections admin. */
export class SolrAdapter implements ProtocolAdapter {
  readonly protocol = "solr";
  private handle: SolrHandle | undefined;
  private connected = false;
  private allowWrite = false;

  constructor(
    readonly id: string,
    private readonly connectFn: SolrConnectFn = defaultConnect,
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
        name: "list_cores",
        description: "GET /solr/admin/cores?action=STATUS",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "select",
        description: "GET /solr/{core}/select (q subset: *:* or field:value)",
        inputSchema: {
          type: "object",
          properties: { core: { type: "string" }, q: { type: "string", default: "*:*" }, rows: { type: "integer", default: 10 } },
          required: ["core"],
          additionalProperties: false,
        },
      },
      {
        name: "update",
        description: "POST /solr/{core}/update (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: { core: { type: "string" }, documents: { type: "array" } },
          required: ["core", "documents"],
          additionalProperties: false,
        },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const h = this.handle!;
    if (toolName === "list_cores") return { cores: await h.listCores() };
    if (toolName === "select") {
      const q = typeof args.q === "string" && args.q.trim() ? args.q : "*:*";
      const rows = typeof args.rows === "number" ? args.rows : 10;
      return h.select(requiredString(args, "core"), q, rows);
    }
    if (toolName === "update") {
      assertCanWrite("solr", this.allowWrite);
      const documents = Array.isArray(args.documents) ? (args.documents as SolrDoc[]) : [];
      return h.update(requiredString(args, "core"), documents);
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown solr tool "${toolName}"`, { protocol: "solr" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return { ok: true, detail: `solr allowWrite=${this.allowWrite} (select/update HTTP; not SolrCloud admin)` };
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_NOT_CONNECTED", "solr adapter is not connected", { protocol: "solr" });
    }
  }
}
