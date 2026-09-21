import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AdapterError } from "../../runtime/errors.js";
import { fetchSafe } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";
import { requiredString, stringField } from "../helpers.js";

export interface CouchDoc {
  _id: string;
  _rev: string;
  [key: string]: unknown;
}

export interface CouchHandle {
  listDbs(): Promise<string[]>;
  allDocs(db: string): Promise<Array<{ id: string; key: string; value: { rev: string } }>>;
  get(db: string, id: string): Promise<CouchDoc>;
  put(db: string, id: string, doc: Record<string, unknown>): Promise<{ id: string; rev: string; ok: true }>;
  close(): Promise<void>;
}

export type CouchConnectFn = (config: Record<string, unknown>) => Promise<CouchHandle>;

export function createMemoryCouch(): CouchHandle {
  const dbs = new Map<string, Map<string, CouchDoc>>();
  let seq = 1;
  return {
    async listDbs() {
      return [...dbs.keys()].sort();
    },
    async allDocs(db) {
      const docs = dbs.get(db);
      if (!docs) return [];
      return [...docs.values()]
        .map((d) => ({ id: d._id, key: d._id, value: { rev: d._rev } }))
        .sort((a, b) => a.id.localeCompare(b.id));
    },
    async get(db, id) {
      const doc = dbs.get(db)?.get(id);
      if (!doc) throw new AdapterError("E_NOT_FOUND", `couchdb ${db}/${id} missing`, { protocol: "couchdb" });
      return { ...doc };
    },
    async put(db, id, body) {
      if (!dbs.has(db)) dbs.set(db, new Map());
      const rev = `1-${seq++}`;
      const stored: CouchDoc = { ...body, _id: id, _rev: rev };
      dbs.get(db)!.set(id, stored);
      return { id, rev, ok: true };
    },
    async close() {
      dbs.clear();
    },
  };
}

async function httpCouch(base: string, timeoutMs: number): Promise<CouchHandle> {
  const root = base.replace(/\/+$/, "");
  const request = async (method: string, path: string, body?: unknown) => {
    const res = await fetchSafe(`${root}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs,
    });
    const text = await res.text();
    if (res.status === 404) {
      throw new AdapterError("E_NOT_FOUND", `couchdb ${path} missing`, { protocol: "couchdb" });
    }
    if (res.status >= 400) {
      throw new AdapterError("E_PROTOCOL", `couchdb ${method} ${path} ${res.status}: ${text.slice(0, 200)}`, {
        protocol: "couchdb",
      });
    }
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  };
  return {
    async listDbs() {
      const json = await request("GET", "/_all_dbs");
      return Array.isArray(json) ? json.map(String) : [];
    },
    async allDocs(db) {
      const json = await request("GET", `/${encodeURIComponent(db)}/_all_docs`);
      const rows = Array.isArray(json.rows) ? json.rows : [];
      return rows
        .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object")
        .map((row) => ({
          id: String(row.id ?? ""),
          key: String(row.key ?? row.id ?? ""),
          value: { rev: String((row.value as { rev?: string } | undefined)?.rev ?? "") },
        }));
    },
    async get(db, id) {
      const json = await request("GET", `/${encodeURIComponent(db)}/${encodeURIComponent(id)}`);
      return json as CouchDoc;
    },
    async put(db, id, doc) {
      const json = await request("PUT", `/${encodeURIComponent(db)}/${encodeURIComponent(id)}`, { ...doc, _id: id });
      return { id: String(json.id ?? id), rev: String(json.rev ?? ""), ok: true };
    },
    async close() {
      /* stateless */
    },
  };
}

async function defaultConnect(config: Record<string, unknown>): Promise<CouchHandle> {
  const url = stringField(config, "url") ?? stringField(config, "endpoint");
  if (config.simulator === true || !url) return createMemoryCouch();
  const timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 4000;
  return httpCouch(url, timeoutMs);
}

export async function listenCouchLoopback(mem: CouchHandle = createMemoryCouch()): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const url = req.url ?? "/";
        const path = url.split("?")[0] ?? "/";
        res.setHeader("content-type", "application/json");
        try {
          if (req.method === "GET" && path === "/") {
            res.end(JSON.stringify({ couchdb: "Welcome", version: "3.3.3-e2mcp" }));
            return;
          }
          if (req.method === "GET" && path === "/_all_dbs") {
            res.end(JSON.stringify(await mem.listDbs()));
            return;
          }
          const all = /^\/([^/]+)\/_all_docs$/.exec(path);
          if (req.method === "GET" && all) {
            res.end(JSON.stringify({ rows: await mem.allDocs(decodeURIComponent(all[1]!)) }));
            return;
          }
          const doc = /^\/([^/]+)\/([^/]+)$/.exec(path);
          if (doc) {
            const db = decodeURIComponent(doc[1]!);
            const id = decodeURIComponent(doc[2]!);
            if (req.method === "GET") {
              res.end(JSON.stringify(await mem.get(db, id)));
              return;
            }
            if (req.method === "PUT") {
              const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
              res.statusCode = 201;
              res.end(JSON.stringify(await mem.put(db, id, body)));
              return;
            }
          }
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "not_found" }));
        } catch (err) {
          res.statusCode = err instanceof AdapterError && err.code === "E_NOT_FOUND" ? 404 : 500;
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as { port: number }).port, close: () => new Promise((r) => server.close(() => r())) };
}

/** CouchDB HTTP: _all_dbs / _all_docs / GET / PUT. Writes need allowWrite. */
export class CouchdbAdapter implements ProtocolAdapter {
  readonly protocol = "couchdb";
  private handle: CouchHandle | undefined;
  private connected = false;
  private allowWrite = false;

  constructor(
    readonly id: string,
    private readonly connectFn: CouchConnectFn = defaultConnect,
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
        name: "list_dbs",
        description: "GET /_all_dbs",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "all_docs",
        description: "GET /{db}/_all_docs",
        inputSchema: {
          type: "object",
          properties: { db: { type: "string" } },
          required: ["db"],
          additionalProperties: false,
        },
      },
      {
        name: "get",
        description: "GET /{db}/{id}",
        inputSchema: {
          type: "object",
          properties: { db: { type: "string" }, id: { type: "string" } },
          required: ["db", "id"],
          additionalProperties: false,
        },
      },
      {
        name: "put",
        description: "PUT /{db}/{id} (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: { db: { type: "string" }, id: { type: "string" }, document: { type: "object" } },
          required: ["db", "id", "document"],
          additionalProperties: false,
        },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const h = this.handle!;
    if (toolName === "list_dbs") return { dbs: await h.listDbs() };
    if (toolName === "all_docs") return { rows: await h.allDocs(requiredString(args, "db")) };
    if (toolName === "get") return h.get(requiredString(args, "db"), requiredString(args, "id"));
    if (toolName === "put") {
      assertCanWrite("couchdb", this.allowWrite);
      const document =
        args.document && typeof args.document === "object" && !Array.isArray(args.document)
          ? (args.document as Record<string, unknown>)
          : {};
      return h.put(requiredString(args, "db"), requiredString(args, "id"), document);
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown couchdb tool "${toolName}"`, { protocol: "couchdb" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return { ok: true, detail: `couchdb allowWrite=${this.allowWrite} (_all_docs/get/put)` };
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_NOT_CONNECTED", "couchdb adapter is not connected", { protocol: "couchdb" });
    }
  }
}
