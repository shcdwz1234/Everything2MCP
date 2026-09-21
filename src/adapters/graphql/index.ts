import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { AdapterError } from "../../runtime/errors.js";
import { headersFromConfig } from "../../runtime/auth.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { payloadToString, requiredString, stringField } from "../helpers.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";
import { graphqlDocumentLooksLikeWrite } from "../rpc-gate.js";

interface GqlField {
  name: string;
  description?: string;
}

export interface GqlSubEvent {
  data: unknown;
}

/** graphql-ws (graphql-transport-ws) loopback: connection_init → subscribe → next/complete. */
export async function listenGraphqlWs(): Promise<{
  port: number;
  publish: (field: string, data: unknown) => void;
  close: () => Promise<void>;
}> {
  const waiters = new Map<string, Array<(data: unknown) => void>>();
  const http = createServer();
  const wss = new WebSocketServer({
    server: http,
    path: "/graphql",
    handleProtocols: () => "graphql-transport-ws",
  });
  wss.on("connection", (socket) => {
    socket.on("message", (raw) => {
      let msg: { type?: string; id?: string; payload?: { query?: string } };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === "connection_init") {
        socket.send(JSON.stringify({ type: "connection_ack" }));
        return;
      }
      if (msg.type === "subscribe" && msg.id) {
        const q = msg.payload?.query ?? "";
        const field = q.match(/\{\s*([A-Za-z_][A-Za-z0-9_]*)/)?.[1] ?? "tick";
        const id = msg.id;
        const list = waiters.get(field) ?? [];
        list.push((data) => {
          socket.send(JSON.stringify({ id, type: "next", payload: { data: { [field]: data } } }));
          socket.send(JSON.stringify({ id, type: "complete" }));
        });
        waiters.set(field, list);
      }
    });
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  return {
    port: (http.address() as { port: number }).port,
    publish(field, data) {
      const list = waiters.get(field) ?? [];
      waiters.set(field, []);
      for (const fn of list) fn(data);
    },
    close: () =>
      new Promise((r) => {
        wss.close();
        http.close(() => r());
      }),
  };
}

async function graphqlWsSubscribeOnce(url: string, query: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, "graphql-transport-ws");
    const timer = setTimeout(() => {
      ws.close();
      reject(new AdapterError("E_TIMEOUT", "GraphQL subscription timed out", { protocol: "graphql" }));
    }, timeoutMs);
    const fail = (err: unknown) => {
      clearTimeout(timer);
      ws.close();
      reject(err);
    };
    ws.on("error", fail);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "connection_init" }));
    });
    ws.on("message", (raw) => {
      let msg: { type?: string; payload?: unknown };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === "connection_ack") {
        ws.send(JSON.stringify({ id: "1", type: "subscribe", payload: { query } }));
        return;
      }
      if (msg.type === "next") {
        clearTimeout(timer);
        ws.close();
        resolve(msg.payload);
        return;
      }
      if (msg.type === "error") {
        fail(new AdapterError("E_PROTOCOL", "GraphQL subscription error", { protocol: "graphql", details: { payload: msg.payload } }));
      }
    });
  });
}

/**
 * GraphQL HTTP adapter: query/mutation POST to a URL.
 * Optional graphql-ws subscribe_once (config.wsUrl or simulator).
 * Optional introspection adds Query_* / Mutation_* tools.
 */
export class GraphqlAdapter implements ProtocolAdapter {
  readonly protocol = "graphql";
  private url = "";
  private wsUrl = "";
  private headers: Record<string, string> = {};
  private connected = false;
  private queryFields: GqlField[] = [];
  private mutationFields: GqlField[] = [];
  private allowWrite = false;
  private simulator = false;
  private memoryEvents: Array<{ field: string; data: unknown }> = [];

  constructor(readonly id: string) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    const url = stringField(config, "url") ?? stringField(config, "endpoint");
    this.simulator = config.simulator === true;
    if (!url && !this.simulator && !stringField(config, "wsUrl")) {
      throw new Error("GraphQL adapter requires config.url");
    }
    this.url = url ?? "memory://";
    this.wsUrl = stringField(config, "wsUrl") ?? "";
    this.headers = headersFromConfig(config, { "content-type": "application/json" });
    this.allowWrite = allowWriteFrom(config);
    this.connected = true;
    this.memoryEvents = [];
    const sdl = stringField(config, "sdl") ?? stringField(config, "schema");
    if (sdl) {
      const parsed = parseGraphqlSdl(sdl);
      this.queryFields = parsed.queries;
      this.mutationFields = parsed.mutations;
    }
    const introspect = config.introspect !== false && !sdl;
    if (introspect) {
      try {
        await this.runIntrospection();
      } catch {
        this.queryFields = [];
        this.mutationFields = [];
      }
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.queryFields = [];
    this.mutationFields = [];
  }

  async listTools(): Promise<McpToolSchema[]> {
    this.assertConnected();
    const tools: McpToolSchema[] = [
      {
        name: "query",
        description: "Run a GraphQL query document against the endpoint",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            variables: { type: "object", additionalProperties: true },
            operationName: { type: "string" },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      {
        name: "mutate",
        description: "Run a GraphQL mutation document (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: {
            mutation: { type: "string" },
            query: { type: "string", description: "Alias for mutation document" },
            variables: { type: "object", additionalProperties: true },
            operationName: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "introspect",
        description: "Run GraphQL introspection and refresh Query_*/Mutation_* tools on next list",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "subscribe_once",
        description: "graphql-ws subscribe (one next). Needs wsUrl, or simulator memory bus.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            timeoutMs: { type: "integer", default: 1500 },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      {
        name: "publish_event",
        description: "Push a simulator subscription event (requires allowWrite=true; memory only)",
        inputSchema: {
          type: "object",
          properties: { field: { type: "string" }, data: {} },
          required: ["field"],
          additionalProperties: false,
        },
      },
    ];
    for (const f of this.queryFields) {
      tools.push(fieldTool("Query", f));
    }
    for (const f of this.mutationFields) {
      tools.push(fieldTool("Mutation", f));
    }
    return tools;
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    if (toolName === "query") {
      const doc = requiredString(args, "query");
      if (graphqlDocumentLooksLikeWrite(doc)) assertCanWrite("graphql", this.allowWrite);
      return this.gql(doc, args.variables, args.operationName);
    }
    if (toolName === "mutate") {
      assertCanWrite("graphql", this.allowWrite);
      const doc =
        (typeof args.mutation === "string" && args.mutation) ||
        (typeof args.query === "string" && args.query) ||
        "";
      if (!doc) throw new Error("Missing required string \"mutation\"");
      return this.gql(doc, args.variables, args.operationName);
    }
    if (toolName === "publish_event") {
      assertCanWrite("graphql", this.allowWrite);
      if (!this.simulator) {
        throw new AdapterError("E_UNSUPPORTED", "publish_event is simulator-only", { protocol: "graphql" });
      }
      const field = requiredString(args, "field");
      this.memoryEvents.push({ field, data: args.data });
      return { ok: true, field };
    }
    if (toolName === "subscribe_once") {
      const query = requiredString(args, "query");
      const ms = typeof args.timeoutMs === "number" && args.timeoutMs > 0 ? args.timeoutMs : 1500;
      const field = query.match(/\{\s*([A-Za-z_][A-Za-z0-9_]*)/)?.[1] ?? "";
      if (this.simulator) {
        const hit = this.memoryEvents.find((e) => !field || e.field === field);
        if (hit) return { data: { [hit.field]: hit.data } };
        return new Promise((resolve, reject) => {
          const started = Date.now();
          const timer = setInterval(() => {
            const ev = this.memoryEvents.find((e) => !field || e.field === field);
            if (ev) {
              clearInterval(timer);
              resolve({ data: { [ev.field]: ev.data } });
            } else if (Date.now() - started >= ms) {
              clearInterval(timer);
              reject(new AdapterError("E_TIMEOUT", "GraphQL subscription timed out", { protocol: "graphql" }));
            }
          }, 15);
        });
      }
      if (!this.wsUrl) {
        throw new AdapterError("E_UNSUPPORTED", "GraphQL subscription needs config.wsUrl (graphql-ws)", {
          protocol: "graphql",
        });
      }
      return graphqlWsSubscribeOnce(this.wsUrl, query, ms);
    }
    if (toolName === "introspect") {
      await this.runIntrospection();
      return {
        queries: this.queryFields.map((f) => f.name),
        mutations: this.mutationFields.map((f) => f.name),
      };
    }
    if (toolName.startsWith("Query_")) {
      return this.invokeField("query", toolName.slice("Query_".length), args);
    }
    if (toolName.startsWith("Mutation_")) {
      assertCanWrite("graphql", this.allowWrite);
      return this.invokeField("mutation", toolName.slice("Mutation_".length), args);
    }
    throw new Error(`Unknown GraphQL tool "${toolName}"`);
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return {
      ok: true,
      detail: `url=${this.url} ws=${this.wsUrl || (this.simulator ? "memory" : "none")} queries=${this.queryFields.length} mutations=${this.mutationFields.length} allowWrite=${this.allowWrite}`,
    };
  }

  private async invokeField(
    kind: "query" | "mutation",
    field: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const fieldArgs =
      args.args && typeof args.args === "object" && !Array.isArray(args.args)
        ? (args.args as Record<string, unknown>)
        : Object.fromEntries(
            Object.entries(args).filter(([k]) => k !== "args" && k !== "selection" && k !== "variables"),
          );
    const selection = typeof args.selection === "string" && args.selection.trim() ? args.selection : "__typename";
    const argList = graphqlArgs(fieldArgs);
    const doc = `${kind} { ${field}${argList} { ${selection} } }`;
    return this.gql(doc, args.variables);
  }

  private async runIntrospection(): Promise<void> {
    const result = (await this.gql(INTROSPECTION)) as {
      data?: {
        __schema?: {
          queryType?: { fields?: GqlField[] };
          mutationType?: { fields?: GqlField[] };
        };
      };
    };
    const schema = result.data?.__schema;
    this.queryFields = (schema?.queryType?.fields ?? []).filter((f) => f.name && !f.name.startsWith("__"));
    this.mutationFields = (schema?.mutationType?.fields ?? []).filter((f) => f.name && !f.name.startsWith("__"));
  }

  private async gql(query: string, variables?: unknown, operationName?: unknown): Promise<unknown> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        query,
        variables: variables && typeof variables === "object" ? variables : undefined,
        operationName: typeof operationName === "string" ? operationName : undefined,
      }),
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { status: res.status, data: text };
    }
  }

  private assertConnected(): void {
    if (!this.connected) throw new Error("GraphQL adapter is not connected");
  }
}

function fieldTool(kind: "Query" | "Mutation", field: GqlField): McpToolSchema {
  return {
    name: `${kind}_${sanitize(field.name)}`,
    description: field.description || `${kind} field ${field.name}`,
    inputSchema: {
      type: "object",
      properties: {
        args: { type: "object", additionalProperties: true },
        selection: { type: "string", description: "Selection set inside the field, default __typename" },
        variables: { type: "object", additionalProperties: true },
      },
      additionalProperties: true,
    },
  };
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

function graphqlArgs(obj: Record<string, unknown>): string {
  const parts = Object.entries(obj).map(([k, v]) => `${k}: ${payloadToString(v)}`);
  return parts.length ? `(${parts.join(", ")})` : "";
}

function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export function parseGraphqlSdl(sdl: string): { queries: GqlField[]; mutations: GqlField[] } {
  return {
    queries: fieldsOf(sdl, "Query"),
    mutations: fieldsOf(sdl, "Mutation"),
  };
}

function fieldsOf(sdl: string, typeName: string): GqlField[] {
  const block = sdl.match(new RegExp(`type\\s+${typeName}\\s*\\{([^}]*)\\}`, "i"));
  if (!block?.[1]) return [];
  const fields: GqlField[] = [];
  for (const line of block[1].split(/\n|;/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*[(:]/);
    if (m?.[1] && !m[1].startsWith("__")) fields.push({ name: m[1] });
  }
  return fields;
}

const INTROSPECTION = `{
  __schema {
    queryType { fields { name description } }
    mutationType { fields { name description } }
  }
}`;
