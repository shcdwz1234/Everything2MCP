import { AdapterError } from "../../runtime/errors.js";
import { assertHostAllowed } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowWriteFrom } from "../sql/common.js";
import { requiredString, stringField } from "../helpers.js";
import { liveMongoWire, type MongoDoc, type MongoHandle } from "./wire.js";

export type { MongoDoc, MongoHandle };

export type MongoConnectFn = (config: Record<string, unknown>) => Promise<MongoHandle>;

export function createMemoryMongo(seed?: Record<string, unknown>): MongoHandle {
  const cols = new Map<string, MongoDoc[]>();
  let seq = 1;
  if (seed?.collections && typeof seed.collections === "object") {
    for (const [name, docs] of Object.entries(seed.collections as Record<string, unknown>)) {
      cols.set(name, Array.isArray(docs) ? (docs as MongoDoc[]).map((d) => ({ ...d })) : []);
    }
  }
  return {
    async listCollections() {
      return [...cols.keys()].sort();
    },
    async describe(collection) {
      const docs = cols.get(collection) ?? [];
      const fields = new Set<string>();
      for (const d of docs.slice(0, 20)) Object.keys(d).forEach((k) => fields.add(k));
      return { collection, fields: [...fields].sort(), count: docs.length };
    },
    async find(collection, filter, limit) {
      const docs = cols.get(collection) ?? [];
      const keys = Object.keys(filter);
      const matched = docs.filter((d) => keys.every((k) => d[k] === filter[k]));
      return matched.slice(0, limit).map((d) => ({ ...d }));
    },
    async insertOne(collection, doc) {
      const id = typeof doc._id === "string" ? doc._id : `obj_${seq++}`;
      const stored = { ...doc, _id: id };
      const list = cols.get(collection) ?? [];
      list.push(stored);
      cols.set(collection, list);
      return { insertedId: id };
    },
    async close() {
      cols.clear();
    },
  };
}

async function defaultConnect(config: Record<string, unknown>): Promise<MongoHandle> {
  const url = stringField(config, "url");
  if (config.simulator === true || !url) return createMemoryMongo(config);
  const host = url.replace(/^mongodb:\/\//i, "").split("/")[0]?.split(":")[0];
  if (host) await assertHostAllowed(host);
  return liveMongoWire(config);
}

export { encodeBson, decodeBson, encodeOpMsg, decodeOpMsg, listenMongoOpMsg, OP_MSG } from "./wire.js";

/** MongoDB. Memory catalog or OP_MSG subset (hello/find/insert/listCollections). No aggregation. */
export class MongodbAdapter implements ProtocolAdapter {
  readonly protocol = "mongodb";
  private handle: MongoHandle | undefined;
  private connected = false;
  private allowWrite = false;

  constructor(
    readonly id: string,
    private readonly connectFn: MongoConnectFn = defaultConnect,
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
        description: "List collection names",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "describe",
        description: "Sample field names and document count",
        inputSchema: {
          type: "object",
          properties: { collection: { type: "string" } },
          required: ["collection"],
          additionalProperties: false,
        },
      },
      {
        name: "find",
        description: "Equality-filter find (no aggregation)",
        inputSchema: {
          type: "object",
          properties: {
            collection: { type: "string" },
            filter: { type: "object" },
            limit: { type: "integer", default: 50 },
          },
          required: ["collection"],
          additionalProperties: false,
        },
      },
      {
        name: "insert_one",
        description: "Insert a document (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: { collection: { type: "string" }, document: { type: "object" } },
          required: ["collection", "document"],
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
    if (toolName === "find") {
      const filter =
        args.filter && typeof args.filter === "object" && !Array.isArray(args.filter)
          ? (args.filter as Record<string, unknown>)
          : {};
      const limit = typeof args.limit === "number" ? args.limit : 50;
      const docs = await handle.find(requiredString(args, "collection"), filter, limit);
      return { count: docs.length, documents: docs };
    }
    if (toolName === "insert_one") {
      if (!this.allowWrite) {
        throw new AdapterError("E_UNSUPPORTED", "Write blocked (config.allowWrite=false)", { protocol: "mongodb" });
      }
      const document =
        args.document && typeof args.document === "object" && !Array.isArray(args.document)
          ? (args.document as MongoDoc)
          : {};
      return handle.insertOne(requiredString(args, "collection"), document);
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown mongodb tool "${toolName}"`, { protocol: "mongodb" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return { ok: true, detail: `mongodb allowWrite=${this.allowWrite} (no aggregation)` };
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_NOT_CONNECTED", "mongodb adapter is not connected", { protocol: "mongodb" });
    }
  }
}
