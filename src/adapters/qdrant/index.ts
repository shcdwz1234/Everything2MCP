import { AdapterError } from "../../runtime/errors.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowWriteFrom } from "../sql/common.js";
import { requiredString, stringField } from "../helpers.js";

export interface QdrantPoint {
  id: string | number;
  vector: number[];
  payload?: Record<string, unknown>;
}

export interface QdrantHandle {
  listCollections(): Promise<string[]>;
  describe(collection: string): Promise<{ collection: string; points: number; dim?: number }>;
  search(collection: string, vector: number[], limit: number): Promise<Array<QdrantPoint & { score: number }>>;
  upsert(collection: string, points: QdrantPoint[]): Promise<{ upserted: number }>;
  close(): Promise<void>;
}

export type QdrantConnectFn = (config: Record<string, unknown>) => Promise<QdrantHandle>;

function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

export function createMemoryQdrant(): QdrantHandle {
  const cols = new Map<string, QdrantPoint[]>();
  return {
    async listCollections() {
      return [...cols.keys()].sort();
    },
    async describe(collection) {
      const pts = cols.get(collection) ?? [];
      return { collection, points: pts.length, dim: pts[0]?.vector.length };
    },
    async search(collection, vector, limit) {
      const pts = cols.get(collection) ?? [];
      return pts
        .map((p) => ({ ...p, score: cosine(vector, p.vector) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    },
    async upsert(collection, points) {
      const list = cols.get(collection) ?? [];
      for (const p of points) {
        const i = list.findIndex((x) => String(x.id) === String(p.id));
        if (i >= 0) list[i] = p;
        else list.push(p);
      }
      cols.set(collection, list);
      return { upserted: points.length };
    },
    async close() {
      cols.clear();
    },
  };
}

async function defaultConnect(config: Record<string, unknown>): Promise<QdrantHandle> {
  const url = stringField(config, "url");
  if (config.simulator === true || !url) return createMemoryQdrant();
  throw new AdapterError(
    "E_UNSUPPORTED",
    "qdrant live HTTP path needs an injected connectFn. Use simulator:true in CI. chromadb is not registered (qdrant chosen as the vector engine).",
    { protocol: "qdrant" },
  );
}

/** Qdrant vector store. Cosine search in the simulator. Not ChromaDB. */
export class QdrantAdapter implements ProtocolAdapter {
  readonly protocol = "qdrant";
  private handle: QdrantHandle | undefined;
  private connected = false;
  private allowWrite = false;

  constructor(
    readonly id: string,
    private readonly connectFn: QdrantConnectFn = defaultConnect,
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
        name: "list_collections",
        description: "List vector collections",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "describe",
        description: "Point count and vector dim",
        inputSchema: {
          type: "object",
          properties: { collection: { type: "string" } },
          required: ["collection"],
          additionalProperties: false,
        },
      },
      {
        name: "search",
        description: "kNN search (cosine in the simulator)",
        inputSchema: {
          type: "object",
          properties: {
            collection: { type: "string" },
            vector: { type: "array", items: { type: "number" } },
            limit: { type: "integer", default: 5 },
          },
          required: ["collection", "vector"],
          additionalProperties: false,
        },
      },
      {
        name: "upsert",
        description: "Upsert points (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: {
            collection: { type: "string" },
            points: { type: "array" },
          },
          required: ["collection", "points"],
          additionalProperties: false,
        },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const handle = this.handle!;
    if (toolName === "list_collections") return { collections: await handle.listCollections() };
    if (toolName === "describe") return handle.describe(requiredString(args, "collection"));
    if (toolName === "search") {
      const vector = Array.isArray(args.vector) ? args.vector.map(Number) : [];
      const limit = typeof args.limit === "number" ? args.limit : 5;
      const hits = await handle.search(requiredString(args, "collection"), vector, limit);
      return { hits };
    }
    if (toolName === "upsert") {
      if (!this.allowWrite) {
        throw new AdapterError("E_UNSUPPORTED", "Write blocked (config.allowWrite=false)", { protocol: "qdrant" });
      }
      const points = Array.isArray(args.points) ? (args.points as QdrantPoint[]) : [];
      return handle.upsert(requiredString(args, "collection"), points);
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown qdrant tool "${toolName}"`, { protocol: "qdrant" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return { ok: true, detail: `qdrant allowWrite=${this.allowWrite} (not chromadb)` };
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_NOT_CONNECTED", "qdrant adapter is not connected", { protocol: "qdrant" });
    }
  }
}
