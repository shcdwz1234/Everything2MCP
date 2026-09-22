import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AdapterError } from "../../runtime/errors.js";
import { fetchSafe } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowWriteFrom } from "../sql/common.js";
import { requiredString, stringField } from "../helpers.js";

export interface EsHit {
  _index: string;
  _id: string;
  _source: Record<string, unknown>;
}

export interface ElasticsearchHandle {
  listIndices(): Promise<string[]>;
  describe(index: string): Promise<{ index: string; count: number; fields: string[] }>;
  search(index: string, query: Record<string, unknown>, size: number): Promise<EsHit[]>;
  indexDoc(index: string, id: string | undefined, body: Record<string, unknown>): Promise<{ _id: string }>;
  clusterHealth(): Promise<{ status: string; cluster_name: string }>;
  close(): Promise<void>;
}

export type ElasticsearchConnectFn = (config: Record<string, unknown>) => Promise<ElasticsearchHandle>;

export function createMemoryElasticsearch(): ElasticsearchHandle {
  const indices = new Map<string, EsHit[]>();
  let seq = 1;
  return {
    async listIndices() {
      return [...indices.keys()].sort();
    },
    async describe(index) {
      const docs = indices.get(index) ?? [];
      const fields = new Set<string>();
      for (const h of docs.slice(0, 20)) Object.keys(h._source).forEach((k) => fields.add(k));
      return { index, count: docs.length, fields: [...fields].sort() };
    },
    async search(index, query, size) {
      const docs = indices.get(index) ?? [];
      const term =
        query.term && typeof query.term === "object"
          ? (query.term as Record<string, unknown>)
          : query.match && typeof query.match === "object"
            ? (query.match as Record<string, unknown>)
            : {};
      const keys = Object.keys(term);
      const hits = keys.length
        ? docs.filter((h) => keys.every((k) => String(h._source[k]) === String(term[k])))
        : docs;
      return hits.slice(0, size);
    },
    async indexDoc(index, id, body) {
      const _id = id ?? `doc_${seq++}`;
      const hit: EsHit = { _index: index, _id, _source: { ...body } };
      const list = indices.get(index) ?? [];
      const existing = list.findIndex((h) => h._id === _id);
      if (existing >= 0) list[existing] = hit;
      else list.push(hit);
      indices.set(index, list);
      return { _id };
    },
    async clusterHealth() {
      return { status: "green", cluster_name: "e2mcp-sim" };
    },
    async close() {
      indices.clear();
    },
  };
}

async function httpElasticsearch(base: string, timeoutMs: number): Promise<ElasticsearchHandle> {
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
      throw new AdapterError("E_PROTOCOL", `elasticsearch ${method} ${path} ${res.status}: ${text.slice(0, 200)}`, {
        protocol: "elasticsearch",
      });
    }
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  };
  return {
    async listIndices() {
      const json = await request("GET", "/_cat/indices?format=json");
      const rows = Array.isArray(json) ? json : [];
      return rows
        .map((row) => {
          if (row && typeof row === "object") return String((row as { index?: string }).index ?? "");
          return "";
        })
        .filter(Boolean)
        .sort();
    },
    async describe(index) {
      const json = await request("GET", `/${encodeURIComponent(index)}`);
      const mappings = (json[index] as { mappings?: { properties?: Record<string, unknown> } } | undefined)?.mappings;
      const fields = mappings?.properties ? Object.keys(mappings.properties).sort() : [];
      const search = (await request("POST", `/${encodeURIComponent(index)}/_search`, { query: { match_all: {} }, size: 0 })) as {
        hits?: { total?: number | { value?: number } };
      };
      const total = search.hits?.total;
      const count = typeof total === "number" ? total : Number(total?.value ?? 0);
      return { index, count, fields };
    },
    async search(index, query, size) {
      const json = (await request("POST", `/${encodeURIComponent(index)}/_search`, { query, size })) as {
        hits?: { hits?: EsHit[] };
      };
      return json.hits?.hits ?? [];
    },
    async indexDoc(index, id, body) {
      const path = id
        ? `/${encodeURIComponent(index)}/_doc/${encodeURIComponent(id)}`
        : `/${encodeURIComponent(index)}/_doc`;
      const json = await request(id ? "PUT" : "POST", path, body);
      return { _id: String(json._id ?? id ?? "") };
    },
    async clusterHealth() {
      const json = await request("GET", "/_cluster/health");
      return {
        status: String(json.status ?? "unknown"),
        cluster_name: String(json.cluster_name ?? ""),
      };
    },
    async close() {
      /* stateless */
    },
  };
}

async function defaultConnect(config: Record<string, unknown>): Promise<ElasticsearchHandle> {
  const url = stringField(config, "url");
  if (config.simulator === true || !url) return createMemoryElasticsearch();
  const timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 4000;
  return httpElasticsearch(url, timeoutMs);
}

export async function listenElasticsearchLoopback(mem: ElasticsearchHandle = createMemoryElasticsearch()): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const path = (req.url ?? "/").split("?")[0] ?? "/";
        res.setHeader("content-type", "application/json");
        try {
          if (req.method === "GET" && path === "/") {
            res.end(JSON.stringify({ name: "e2mcp", tagline: "You Know, for Search", version: { number: "8.0.0-e2mcp" } }));
            return;
          }
          if (req.method === "GET" && path === "/_cluster/health") {
            res.end(JSON.stringify(await mem.clusterHealth()));
            return;
          }
          if (req.method === "GET" && path.startsWith("/_cat/indices")) {
            const indices = await mem.listIndices();
            res.end(JSON.stringify(indices.map((index) => ({ index }))));
            return;
          }
          const mapping = /^\/([^/]+)$/.exec(path);
          if (req.method === "GET" && mapping && mapping[1] !== "_cat") {
            const index = decodeURIComponent(mapping[1]!);
            const d = await mem.describe(index);
            const properties: Record<string, { type: string }> = {};
            for (const f of d.fields) properties[f] = { type: "keyword" };
            res.end(JSON.stringify({ [index]: { mappings: { properties } } }));
            return;
          }
          const search = /^\/([^/]+)\/_search$/.exec(path);
          if (req.method === "POST" && search) {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
              query?: Record<string, unknown>;
              size?: number;
            };
            const hits = await mem.search(decodeURIComponent(search[1]!), body.query ?? {}, body.size ?? 10);
            res.end(JSON.stringify({ hits: { total: { value: hits.length }, hits } }));
            return;
          }
          const doc = /^\/([^/]+)\/_doc(?:\/([^/]+))?$/.exec(path);
          if ((req.method === "PUT" || req.method === "POST") && doc) {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
            const put = await mem.indexDoc(decodeURIComponent(doc[1]!), doc[2] ? decodeURIComponent(doc[2]) : undefined, body);
            res.statusCode = 201;
            res.end(JSON.stringify({ _id: put._id, result: "created" }));
            return;
          }
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "not_found" }));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as { port: number }).port, close: () => new Promise((r) => server.close(() => r())) };
}

/** Elasticsearch / OpenSearch document search. No cluster admin, no ingest pipelines. */
export class ElasticsearchAdapter implements ProtocolAdapter {
  readonly protocol: "elasticsearch" | "opensearch";
  private handle: ElasticsearchHandle | undefined;
  private connected = false;
  private allowWrite = false;

  constructor(
    readonly id: string,
    protocol: "elasticsearch" | "opensearch" = "elasticsearch",
    private readonly connectFn: ElasticsearchConnectFn = defaultConnect,
  ) {
    this.protocol = protocol;
  }

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
        name: "list_indices",
        description: "List indices (OpenSearch aliases: list_indices)",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "describe",
        description: "Index document count and sampled fields",
        inputSchema: {
          type: "object",
          properties: { index: { type: "string" } },
          required: ["index"],
          additionalProperties: false,
        },
      },
      {
        name: "search",
        description: "Search (term/match equality in the simulator; Query DSL subset)",
        inputSchema: {
          type: "object",
          properties: {
            index: { type: "string" },
            query: { type: "object" },
            size: { type: "integer", default: 10 },
          },
          required: ["index"],
          additionalProperties: false,
        },
      },
      {
        name: "index_doc",
        description: "Index a document (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: {
            index: { type: "string" },
            id: { type: "string" },
            document: { type: "object" },
          },
          required: ["index", "document"],
          additionalProperties: false,
        },
      },
      {
        name: "cluster_health",
        description: "GET /_cluster/health (OpenSearch compatible)",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const handle = this.handle!;
    if (toolName === "list_indices") return { indices: await handle.listIndices() };
    if (toolName === "describe") return handle.describe(requiredString(args, "index"));
    if (toolName === "search") {
      const query =
        args.query && typeof args.query === "object" && !Array.isArray(args.query)
          ? (args.query as Record<string, unknown>)
          : {};
      const size = typeof args.size === "number" ? args.size : 10;
      const hits = await handle.search(requiredString(args, "index"), query, size);
      return { hits: { total: hits.length, hits } };
    }
    if (toolName === "index_doc") {
      if (!this.allowWrite) {
        throw new AdapterError("E_UNSUPPORTED", "Write blocked (config.allowWrite=false)", { protocol: this.protocol });
      }
      const document =
        args.document && typeof args.document === "object" && !Array.isArray(args.document)
          ? (args.document as Record<string, unknown>)
          : {};
      const id = typeof args.id === "string" ? args.id : undefined;
      return handle.indexDoc(requiredString(args, "index"), id, document);
    }
    if (toolName === "cluster_health") return handle.clusterHealth();
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown ${this.protocol} tool "${toolName}"`, { protocol: this.protocol });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return {
      ok: true,
      detail: `${this.protocol} allowWrite=${this.allowWrite} (OpenSearch compatible)`,
    };
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_NOT_CONNECTED", `${this.protocol} adapter is not connected`, { protocol: this.protocol });
    }
  }
}
