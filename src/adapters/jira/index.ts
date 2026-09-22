import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AdapterError } from "../../runtime/errors.js";
import { fetchSafe } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { requiredString, stringField } from "../helpers.js";

export interface JiraIssue {
  key: string;
  fields: { summary: string; status?: { name: string } };
}

export interface JiraHandle {
  myself(): Promise<{ accountId: string; displayName: string }>;
  search(jql: string, maxResults: number): Promise<JiraIssue[]>;
  getIssue(key: string): Promise<JiraIssue>;
  close(): Promise<void>;
}

export type JiraConnectFn = (config: Record<string, unknown>) => Promise<JiraHandle>;

export function createMemoryJira(): JiraHandle {
  const issues: JiraIssue[] = [
    { key: "E2M-1", fields: { summary: "Hot-add pipeline", status: { name: "Done" } } },
    { key: "E2M-2", fields: { summary: "SMB MVP", status: { name: "In Progress" } } },
  ];
  return {
    async myself() {
      return { accountId: "sim", displayName: "E2MCP Simulator" };
    },
    async search(jql, maxResults) {
      const q = jql.toLowerCase();
      return issues.filter((i) => !q || i.key.toLowerCase().includes(q) || i.fields.summary.toLowerCase().includes(q)).slice(0, maxResults);
    },
    async getIssue(key) {
      const hit = issues.find((i) => i.key === key);
      if (!hit) throw new AdapterError("E_NOT_FOUND", `jira ${key} missing`, { protocol: "jira" });
      return hit;
    },
    async close() {
      issues.length = 0;
    },
  };
}

async function httpJira(base: string, timeoutMs: number, token?: string): Promise<JiraHandle> {
  const root = base.replace(/\/+$/, "");
  const request = async (path: string) => {
    const headers: Record<string, string> = { accept: "application/json" };
    if (token) headers.authorization = token.includes(":") ? `Basic ${Buffer.from(token).toString("base64")}` : `Bearer ${token}`;
    const res = await fetchSafe(`${root}${path}`, { method: "GET", headers, timeoutMs });
    const text = await res.text();
    if (res.status === 404) throw new AdapterError("E_NOT_FOUND", `jira ${path} missing`, { protocol: "jira" });
    if (res.status >= 400) {
      throw new AdapterError("E_PROTOCOL", `jira GET ${path} ${res.status}: ${text.slice(0, 200)}`, { protocol: "jira" });
    }
    return text ? JSON.parse(text) : {};
  };
  return {
    async myself() {
      return request("/rest/api/2/myself") as Promise<{ accountId: string; displayName: string }>;
    },
    async search(jql, maxResults) {
      const json = (await request(
        `/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&fields=summary,status`,
      )) as { issues?: JiraIssue[] };
      return json.issues ?? [];
    },
    async getIssue(key) {
      return request(`/rest/api/2/issue/${encodeURIComponent(key)}?fields=summary,status`) as Promise<JiraIssue>;
    },
    async close() {
      /* http */
    },
  };
}

/** Jira REST read subset. Writes (create/transition) are not implemented. */
export class JiraAdapter implements ProtocolAdapter {
  readonly protocol = "jira";
  private handle: JiraHandle | undefined;

  constructor(
    readonly id: string,
    private readonly connectFn: JiraConnectFn = defaultConnect,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    this.handle = await this.connectFn(config);
  }

  async disconnect(): Promise<void> {
    await this.handle?.close();
    this.handle = undefined;
  }

  async listTools(): Promise<McpToolSchema[]> {
    return [
      {
        name: "myself",
        description: "GET /rest/api/2/myself",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
      },
      {
        name: "search",
        description: "GET /rest/api/2/search (JQL). Read-only.",
        inputSchema: {
          type: "object",
          properties: { jql: { type: "string" }, maxResults: { type: "integer", default: 20 } },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: "get_issue",
        description: "GET /rest/api/2/issue/{key}",
        inputSchema: {
          type: "object",
          properties: { key: { type: "string" } },
          required: ["key"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.handle) throw new AdapterError("E_NOT_CONNECTED", "jira not connected", { protocol: this.protocol });
    if (toolName === "myself") return this.handle.myself();
    if (toolName === "search") {
      const jql = typeof args.jql === "string" ? args.jql : "";
      const max = typeof args.maxResults === "number" && args.maxResults > 0 ? Math.min(args.maxResults, 50) : 20;
      return { issues: await this.handle.search(jql, max) };
    }
    if (toolName === "get_issue") return this.handle.getIssue(requiredString(args, "key"));
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown tool ${toolName}`, { protocol: this.protocol });
  }

  async health(): Promise<AdapterHealth> {
    return { ok: Boolean(this.handle), detail: "read-only" };
  }
}

async function defaultConnect(config: Record<string, unknown>): Promise<JiraHandle> {
  const url = stringField(config, "url");
  if (config.simulator === true || !url) return createMemoryJira();
  const timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 4000;
  return httpJira(url, timeoutMs, stringField(config, "token") ?? stringField(config, "auth"));
}

export async function listenJiraLoopback(mem: JiraHandle = createMemoryJira()): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      res.setHeader("content-type", "application/json");
      try {
        if (url.pathname === "/rest/api/2/myself") {
          res.end(JSON.stringify(await mem.myself()));
          return;
        }
        if (url.pathname === "/rest/api/2/search") {
          const issues = await mem.search(url.searchParams.get("jql") ?? "", Number(url.searchParams.get("maxResults") ?? 20));
          res.end(JSON.stringify({ issues }));
          return;
        }
        const one = /^\/rest\/api\/2\/issue\/([^/]+)$/.exec(url.pathname);
        if (one) {
          res.end(JSON.stringify(await mem.getIssue(decodeURIComponent(one[1]!))));
          return;
        }
        res.statusCode = 404;
        res.end("{}");
      } catch (err) {
        res.statusCode = err instanceof AdapterError && err.code === "E_NOT_FOUND" ? 404 : 500;
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    })();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as { port: number }).port, close: () => new Promise((r) => server.close(() => r())) };
}
