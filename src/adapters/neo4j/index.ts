import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AdapterError } from "../../runtime/errors.js";
import { fetchSafe } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowWriteFrom } from "../sql/common.js";
import { requiredString, stringField } from "../helpers.js";

export interface Neo4jNode {
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
}

export interface Neo4jHandle {
  listLabels(): Promise<string[]>;
  describe(label: string): Promise<{ label: string; count: number; properties: string[] }>;
  cypher(statement: string, params: Record<string, unknown>): Promise<{ records: unknown[] }>;
  close(): Promise<void>;
}

export type Neo4jConnectFn = (config: Record<string, unknown>) => Promise<Neo4jHandle>;

export function createMemoryNeo4j(): Neo4jHandle {
  const nodes: Neo4jNode[] = [];
  let seq = 1;
  return {
    async listLabels() {
      return [...new Set(nodes.flatMap((n) => n.labels))].sort();
    },
    async describe(label) {
      const hit = nodes.filter((n) => n.labels.includes(label));
      const properties = new Set<string>();
      for (const n of hit) Object.keys(n.properties).forEach((k) => properties.add(k));
      return { label, count: hit.length, properties: [...properties].sort() };
    },
    async cypher(statement, params) {
      const s = statement.trim();
      const create = /^CREATE\s+\((\w+):(\w+)\s*\{([^}]*)\}\)\s*$/i.exec(s);
      if (create) {
        const props: Record<string, unknown> = { ...params };
        for (const part of create[3]!.split(",")) {
          const [k, v] = part.split(":").map((x) => x.trim());
          if (k) props[k] = v?.replace(/^\$/, "") ? params[v!.replace(/^\$/, "")] ?? unquote(v ?? "") : null;
        }
        const node: Neo4jNode = { id: `n${seq++}`, labels: [create[2]!], properties: props };
        nodes.push(node);
        return { records: [{ n: node }] };
      }
      const match = /^MATCH\s+\((\w+):(\w+)\)\s+RETURN\s+\1\s*$/i.exec(s);
      if (match) {
        const label = match[2]!;
        return { records: nodes.filter((n) => n.labels.includes(label)).map((n) => ({ n })) };
      }
      if (/^RETURN\s+1\b/i.test(s)) return { records: [{ value: 1 }] };
      if (/^CALL\s+db\.labels\(\)/i.test(s) || /^SHOW\s+LABELS/i.test(s)) {
        const labels = [...new Set(nodes.flatMap((n) => n.labels))].sort();
        return { records: labels.map((label) => ({ label })) };
      }
      throw new AdapterError(
        "E_UNSUPPORTED",
        "neo4j simulator understands CREATE (n:Label {…}), MATCH (n:Label) RETURN n, CALL db.labels()",
        { protocol: "neo4j" },
      );
    },
    async close() {
      nodes.length = 0;
    },
  };
}

function unquote(v: string): unknown {
  const s = v.trim();
  if (/^'.*'$/.test(s) || /^".*"$/.test(s)) return s.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function isWriteCypher(statement: string): boolean {
  return /\b(CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP|LOAD)\b/i.test(statement);
}

async function httpNeo4j(base: string, timeoutMs: number, database = "neo4j"): Promise<Neo4jHandle> {
  const root = base.replace(/\/+$/, "");
  const commit = async (statement: string, params: Record<string, unknown> = {}) => {
    const res = await fetchSafe(`${root}/db/${encodeURIComponent(database)}/tx/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ statements: [{ statement, parameters: params }] }),
      timeoutMs,
    });
    const text = await res.text();
    if (res.status >= 400) {
      throw new AdapterError("E_PROTOCOL", `neo4j HTTP ${res.status}: ${text.slice(0, 200)}`, { protocol: "neo4j" });
    }
    const json = JSON.parse(text || "{}") as {
      results?: Array<{ columns?: string[]; data?: Array<{ row?: unknown[] }> }>;
      errors?: Array<{ message?: string }>;
    };
    if (json.errors?.length) {
      throw new AdapterError("E_PROTOCOL", json.errors[0]?.message ?? "neo4j tx error", { protocol: "neo4j" });
    }
    const first = json.results?.[0];
    const columns = first?.columns ?? [];
    const records = (first?.data ?? []).map((item) => {
      const row = item.row ?? [];
      if (columns.length === 1) return { [columns[0]!]: row[0] };
      const obj: Record<string, unknown> = {};
      columns.forEach((c, i) => {
        obj[c] = row[i];
      });
      return obj;
    });
    return { records };
  };
  return {
    async listLabels() {
      const r = await commit("CALL db.labels()");
      return r.records.map((rec) => String((rec as { label?: unknown }).label ?? Object.values(rec)[0] ?? "")).filter(Boolean);
    },
    async describe(label) {
      const r = await commit(`MATCH (n:${label}) RETURN n`);
      const properties = new Set<string>();
      for (const rec of r.records) {
        const n = (rec as { n?: { properties?: Record<string, unknown> } }).n;
        if (n?.properties) Object.keys(n.properties).forEach((k) => properties.add(k));
      }
      return { label, count: r.records.length, properties: [...properties].sort() };
    },
    async cypher(statement, params) {
      return commit(statement, params);
    },
    async close() {
      /* stateless */
    },
  };
}

async function defaultConnect(config: Record<string, unknown>): Promise<Neo4jHandle> {
  const url = stringField(config, "url");
  if (config.simulator === true || !url) return createMemoryNeo4j();
  if (/^https?:\/\//i.test(url)) {
    const timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 4000;
    const database = stringField(config, "database") ?? "neo4j";
    return httpNeo4j(url, timeoutMs, database);
  }
  throw new AdapterError(
    "E_UNSUPPORTED",
    "neo4j live Bolt path needs an injected connectFn. Use http(s) transactional URL or simulator:true.",
    { protocol: "neo4j" },
  );
}

export async function listenNeo4jHttpLoopback(mem: Neo4jHandle = createMemoryNeo4j()): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const path = req.url ?? "/";
        res.setHeader("content-type", "application/json");
        try {
          if (req.method === "GET" && (path === "/" || path === "/db/data/")) {
            res.end(
              JSON.stringify({
                neo4j_version: "5.0.0-e2mcp",
                transaction: "http://127.0.0.1/db/{databaseName}/tx",
                bolt_direct: "bolt://127.0.0.1:7687",
              }),
            );
            return;
          }
          if (req.method === "POST" && /\/db\/[^/]+\/tx\/commit$/.test(path)) {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
              statements?: Array<{ statement?: string; parameters?: Record<string, unknown> }>;
            };
            const results = [];
            for (const st of body.statements ?? []) {
              const r = await mem.cypher(st.statement ?? "RETURN 1", st.parameters ?? {});
              const columns = r.records[0] ? Object.keys(r.records[0] as object) : [];
              results.push({
                columns,
                data: r.records.map((rec) => ({
                  row: columns.map((c) => (rec as Record<string, unknown>)[c]),
                })),
              });
            }
            res.end(JSON.stringify({ results, errors: [] }));
            return;
          }
          res.statusCode = 404;
          res.end(JSON.stringify({ errors: [{ message: "not found" }] }));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ errors: [{ message: err instanceof Error ? err.message : String(err) }] }));
        }
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as { port: number }).port, close: () => new Promise((r) => server.close(() => r())) };
}

/** Neo4j graph. CI: in-memory CREATE/MATCH. No full Cypher. */
export class Neo4jAdapter implements ProtocolAdapter {
  readonly protocol = "neo4j";
  private handle: Neo4jHandle | undefined;
  private connected = false;
  private allowWrite = false;

  constructor(
    readonly id: string,
    private readonly connectFn: Neo4jConnectFn = defaultConnect,
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
        name: "list_labels",
        description: "List node labels (equivalent of list_tables)",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "describe",
        description: "Count nodes and sample properties for a label",
        inputSchema: {
          type: "object",
          properties: { label: { type: "string" } },
          required: ["label"],
          additionalProperties: false,
        },
      },
      {
        name: "cypher",
        description: "Run Cypher (writes require allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: { statement: { type: "string" }, params: { type: "object" } },
          required: ["statement"],
          additionalProperties: false,
        },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const handle = this.handle!;
    if (toolName === "list_labels") return { labels: await handle.listLabels() };
    if (toolName === "describe") return handle.describe(requiredString(args, "label"));
    if (toolName === "cypher") {
      const statement = requiredString(args, "statement");
      if (isWriteCypher(statement) && !this.allowWrite) {
        throw new AdapterError("E_UNSUPPORTED", "Write blocked (config.allowWrite=false)", { protocol: "neo4j" });
      }
      const params =
        args.params && typeof args.params === "object" && !Array.isArray(args.params)
          ? (args.params as Record<string, unknown>)
          : {};
      return handle.cypher(statement, params);
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown neo4j tool "${toolName}"`, { protocol: "neo4j" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return { ok: true, detail: `neo4j allowWrite=${this.allowWrite} (Cypher subset)` };
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_NOT_CONNECTED", "neo4j adapter is not connected", { protocol: "neo4j" });
    }
  }
}
