import { AdapterError } from "../../runtime/errors.js";
import { fetchSafe } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";
import { requiredString, stringField } from "../helpers.js";

export interface DavEntry {
  href: string;
  type: "file" | "collection";
  size?: number;
}

export interface WebDavHandle {
  propfind(path: string, depth: number): Promise<DavEntry[]>;
  get(path: string): Promise<{ path: string; body: string }>;
  put(path: string, body: string): Promise<{ path: string; size: number }>;
  delete(path: string): Promise<{ path: string; deleted: true }>;
  mkcol(path: string): Promise<{ path: string; created: true }>;
  close(): Promise<void>;
}

export type WebDavConnectFn = (config: Record<string, unknown>) => Promise<WebDavHandle>;

function norm(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return p.replace(/\/+/g, "/");
}

export function createMemoryWebDav(): WebDavHandle {
  const files = new Map<string, string>([["/", ""]]);
  const dirs = new Set<string>(["/"]);
  return {
    async propfind(path, depth) {
      const root = norm(path).replace(/\/+$/, "") || "/";
      const out: DavEntry[] = [];
      const prefix = root === "/" ? "/" : `${root}/`;
      if (dirs.has(root) || root === "/") out.push({ href: root === "/" ? "/" : root, type: "collection" });
      if (files.has(root) && root !== "/") out.push({ href: root, type: "file", size: files.get(root)!.length });
      if (depth <= 0) return out;
      for (const d of dirs) {
        if (d !== root && (root === "/" ? d !== "/" : d.startsWith(prefix))) {
          const rest = root === "/" ? d.slice(1) : d.slice(prefix.length);
          if (depth === 1 && rest.includes("/")) continue;
          out.push({ href: d, type: "collection" });
        }
      }
      for (const [p, body] of files) {
        if (p === "/") continue;
        if (root === "/" ? true : p.startsWith(prefix) || p === root) {
          if (p === root) continue;
          const rest = root === "/" ? p.slice(1) : p.slice(prefix.length);
          if (depth === 1 && rest.includes("/")) continue;
          out.push({ href: p, type: "file", size: body.length });
        }
      }
      return out;
    },
    async get(path) {
      const p = norm(path);
      const body = files.get(p);
      if (body === undefined) throw new AdapterError("E_NOT_FOUND", `No WebDAV resource ${p}`, { protocol: "webdav" });
      return { path: p, body };
    },
    async put(path, body) {
      const p = norm(path);
      files.set(p, body);
      return { path: p, size: body.length };
    },
    async delete(path) {
      const p = norm(path);
      files.delete(p);
      dirs.delete(p);
      return { path: p, deleted: true };
    },
    async mkcol(path) {
      const p = norm(path).replace(/\/+$/, "") || "/";
      dirs.add(p);
      return { path: p, created: true };
    },
    async close() {
      files.clear();
      dirs.clear();
    },
  };
}

async function httpHandle(base: string, timeoutMs: number): Promise<WebDavHandle> {
  const root = base.replace(/\/+$/, "");
  const req = async (method: string, path: string, body?: string, headers: Record<string, string> = {}) => {
    const url = path.startsWith("http") ? path : `${root}${norm(path)}`;
    const res = await fetchSafe(url, { method, body, headers, timeoutMs });
    const text = await res.text();
    if (res.status === 404) throw new AdapterError("E_NOT_FOUND", `WebDAV ${method} ${path} → 404`, { protocol: "webdav" });
    if (res.status >= 400) {
      throw new AdapterError("E_PROTOCOL", `WebDAV ${method} ${res.status}: ${text.slice(0, 200)}`, { protocol: "webdav" });
    }
    return { status: res.status, text, headers: res.headers };
  };
  return {
    async propfind(path, depth) {
      const { text } = await req("PROPFIND", path, `<?xml version="1.0"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>`, {
        Depth: String(depth),
        "Content-Type": "application/xml",
      });
      const hrefs = [...text.matchAll(/<[^>]*href[^>]*>([^<]+)<\//gi)].map((m) => m[1]!.trim());
      const collections = new Set(
        [...text.matchAll(/<[^>]*collection\s*\/>/gi)].length ? hrefs.filter((_, i, arr) => arr.length) : [],
      );
      if (!hrefs.length && /collection/i.test(text)) hrefs.push(norm(path));
      const entries: DavEntry[] = hrefs.length
        ? hrefs.map((href) => ({
            href,
            type: /\/$/.test(href) || collections.size ? "collection" : "file",
          }))
        : [{ href: norm(path), type: "collection" }];
      return entries;
    },
    async get(path) {
      const { text } = await req("GET", path);
      return { path: norm(path), body: text };
    },
    async put(path, body) {
      await req("PUT", path, body, { "Content-Type": "application/octet-stream" });
      return { path: norm(path), size: body.length };
    },
    async delete(path) {
      await req("DELETE", path);
      return { path: norm(path), deleted: true };
    },
    async mkcol(path) {
      await req("MKCOL", path);
      return { path: norm(path), created: true };
    },
    async close() {
      /* stateless */
    },
  };
}

async function defaultConnect(config: Record<string, unknown>): Promise<WebDavHandle> {
  const url = stringField(config, "url") ?? stringField(config, "baseUrl");
  if (config.simulator === true || !url) return createMemoryWebDav();
  const timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 4000;
  return httpHandle(url, timeoutMs);
}

/** WebDAV PROPFIND/GET/PUT/DELETE/MKCOL. Memory VFS or HTTP. Not CalDAV/CardDAV. */
export class WebDavAdapter implements ProtocolAdapter {
  readonly protocol = "webdav";
  private handle: WebDavHandle | undefined;
  private connected = false;
  private allowWrite = false;

  constructor(
    readonly id: string,
    private readonly connectFn: WebDavConnectFn = defaultConnect,
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
        description: "List collection members (Depth 0/1)",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string", default: "/" }, depth: { type: "integer", default: 1 } },
          additionalProperties: false,
        },
      },
      {
        name: "get",
        description: "GET a file body",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
      {
        name: "put",
        description: "PUT a file (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" }, body: { type: "string" } },
          required: ["path", "body"],
          additionalProperties: false,
        },
      },
      {
        name: "delete",
        description: "DELETE a resource (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
      {
        name: "mkcol",
        description: "MKCOL create a collection (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const h = this.handle!;
    if (toolName === "propfind") {
      const path = typeof args.path === "string" && args.path.trim() ? args.path : "/";
      const depth = typeof args.depth === "number" ? args.depth : 1;
      return { entries: await h.propfind(path, depth) };
    }
    if (toolName === "get") return h.get(requiredString(args, "path"));
    if (toolName === "put") {
      assertCanWrite("webdav", this.allowWrite);
      return h.put(requiredString(args, "path"), requiredString(args, "body"));
    }
    if (toolName === "delete") {
      assertCanWrite("webdav", this.allowWrite);
      return h.delete(requiredString(args, "path"));
    }
    if (toolName === "mkcol") {
      assertCanWrite("webdav", this.allowWrite);
      return h.mkcol(requiredString(args, "path"));
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown tool: ${toolName}`, { protocol: "webdav" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected || !this.handle) return { ok: false, detail: "not connected" };
    try {
      await this.handle.propfind("/", 0);
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_INVALID_CONFIG", "WebDAV adapter is not connected", { protocol: "webdav" });
    }
  }
}
