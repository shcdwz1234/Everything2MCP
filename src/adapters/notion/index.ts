import type { McpToolSchema } from "../../runtime/types.js";
import { AdapterError } from "../../runtime/errors.js";
import { listenJsonLoopback, NativeAppAdapter, tool } from "../native/runtime.js";

interface Page {
  id: string;
  title: string;
  parent?: string;
}

export class NotionAdapter extends NativeAppAdapter {
  readonly protocol = "notion";
  private pages: Page[] = [];

  protected async onConnect(): Promise<void> {
    this.pages = [
      { id: "pg-home", title: "Home" },
      { id: "pg-spec", title: "Partner protocol notes" },
    ];
  }

  protected async onDisconnect(): Promise<void> {
    this.pages = [];
  }

  async listTools(): Promise<McpToolSchema[]> {
    return [
      tool("search", "Notion search (readonly)", { properties: { query: { type: "string" } } }),
      tool("get_page", "Read a page by id", { properties: { id: { type: "string" } }, required: ["id"] }),
      tool("create_page", "Create page — requires allowWrite=true", {
        write: true,
        properties: { title: { type: "string" }, parent: { type: "string" } },
        required: ["title"],
      }),
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (toolName === "search") {
      if (!this.simulator && this.baseUrl) {
        return this.http("POST", "/v1/search", { query: args.query ?? "" });
      }
      const q = typeof args.query === "string" ? args.query.toLowerCase() : "";
      return { results: this.pages.filter((p) => !q || p.title.toLowerCase().includes(q) || p.id.includes(q)) };
    }
    if (toolName === "get_page") {
      const id = this.str(args, "id");
      if (!this.simulator && this.baseUrl) return this.http("GET", `/v1/pages/${encodeURIComponent(id)}`);
      const hit = this.pages.find((p) => p.id === id);
      if (!hit) throw new AdapterError("E_NOT_FOUND", `notion page ${id} missing`, { protocol: "notion" });
      return hit;
    }
    if (toolName === "create_page") {
      this.assertWrite();
      const title = this.str(args, "title");
      const parent = typeof args.parent === "string" ? args.parent : undefined;
      if (!this.simulator && this.baseUrl) {
        return this.http("POST", "/v1/pages", { parent: parent ? { page_id: parent } : {}, properties: { title } });
      }
      const row: Page = { id: `pg-${this.pages.length + 1}`, title, parent };
      this.pages.push(row);
      return { ok: true, page: row };
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown tool ${toolName}`, { protocol: this.protocol });
  }
}

export async function listenNotionLoopback(): Promise<{ port: number; close: () => Promise<void> }> {
  const pages: Page[] = [{ id: "pg-http", title: "Loopback" }];
  return listenJsonLoopback(async ({ method, pathname, body }) => {
    if (method === "POST" && pathname === "/v1/search") return { body: { results: pages } };
    const get = /^\/v1\/pages\/([^/]+)$/.exec(pathname);
    if (method === "GET" && get) {
      const hit = pages.find((p) => p.id === decodeURIComponent(get[1]!));
      if (!hit) return { status: 404, body: {} };
      return { body: hit };
    }
    if (method === "POST" && pathname === "/v1/pages") {
      const b = (body ?? {}) as Record<string, unknown>;
      const props = (b.properties ?? {}) as Record<string, unknown>;
      const row: Page = { id: `pg-new`, title: String(props.title ?? "untitled") };
      pages.push(row);
      return { body: row };
    }
    return { status: 404, body: {} };
  });
}
