import { applyAuthHeaders, applyAuthQuery, headersFromConfig, parseAuth } from "../../runtime/auth.js";
import { loadJsonOrYaml } from "../../runtime/load.js";
import type { AdapterHealth, AuthConfig, McpJsonSchema, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";

interface MappedOp {
  localName: string;
  method: string;
  path: string;
  description: string;
  parameters: Array<{ name: string; in: string; required: boolean }>;
  hasBody: boolean;
  inputSchema: McpJsonSchema;
}

export class OpenApiAdapter implements ProtocolAdapter {
  readonly protocol = "openapi";
  private spec: Record<string, unknown> | undefined;
  private baseUrl = "";
  private headers: Record<string, string> = {};
  private auth: AuthConfig | undefined;
  private timeoutMs = 30_000;
  private ops = new Map<string, MappedOp>();
  private connected = false;
  private allowWrite = false;

  constructor(readonly id: string) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    const specSource = stringField(config, "spec") ?? stringField(config, "specUrl") ?? stringField(config, "specPath");
    if (!specSource) {
      throw new Error("OpenAPI adapter requires config.spec (file path or URL)");
    }
    const loaded = await loadJsonOrYaml(specSource);
    this.spec = asObject(loaded.value, "OpenAPI document");
    this.baseUrl = stringField(config, "baseUrl") ?? inferBaseUrl(this.spec, loaded.href);
    this.headers = headersFromConfig(config);
    this.auth = parseAuth(config);
    this.timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 30_000;
    this.ops = mapOperations(this.spec);
    this.allowWrite = allowWriteFrom(config);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.spec = undefined;
    this.ops.clear();
    this.connected = false;
  }

  async listTools(): Promise<McpToolSchema[]> {
    this.assertConnected();
    return [...this.ops.values()].map((op) => ({
      name: op.localName,
      description: op.description,
      inputSchema: op.inputSchema,
    }));
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const op = this.ops.get(toolName);
    if (!op) throw new Error(`Unknown OpenAPI operation "${toolName}"`);
    if (isUnsafeHttp(op.method)) assertCanWrite("openapi", this.allowWrite);
    if (!this.baseUrl) {
      throw new Error("No baseUrl configured (set config.baseUrl or provide spec.servers)");
    }

    let path = op.path;
    const url = new URL(this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`);
    const headers: Record<string, string> = { ...this.headers };
    applyAuthHeaders(headers, this.auth);

    for (const param of op.parameters) {
      const value = args[param.name];
      if (value === undefined || value === null) {
        if (param.required) throw new Error(`Missing required parameter "${param.name}"`);
        continue;
      }
      const encoded = encodeURIComponent(String(value));
      if (param.in === "path") {
        path = path.replace(`{${param.name}}`, encoded);
      } else if (param.in === "query") {
        url.searchParams.append(param.name, String(value));
      } else if (param.in === "header") {
        headers[param.name] = String(value);
      }
    }
    applyAuthQuery(url, this.auth);

    const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${normalizedPath}`.replace(/\/{2,}/g, "/");
    if (!url.pathname.startsWith("/")) url.pathname = `/${url.pathname}`;

    let body: string | undefined;
    if (op.hasBody && args.body !== undefined) {
      headers["content-type"] = headers["content-type"] ?? "application/json";
      body = typeof args.body === "string" ? args.body : JSON.stringify(args.body);
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { method: op.method, headers, body, signal: ac.signal });
      const text = await res.text();
      let data: unknown = text;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      return {
        status: res.status,
        ok: res.ok,
        headers: Object.fromEntries(res.headers.entries()),
        data,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return {
      ok: true,
      detail: `operations=${this.ops.size} baseUrl=${this.baseUrl || "(none)"} allowWrite=${this.allowWrite}`,
    };
  }

  private assertConnected(): void {
    if (!this.connected || !this.spec) throw new Error("OpenAPI adapter is not connected");
  }
}

function isUnsafeHttp(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

function stringField(config: Record<string, unknown>, key: string): string | undefined {
  const v = config[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function inferBaseUrl(spec: Record<string, unknown>, href?: string): string {
  const fromConfig = "";
  const servers = spec.servers;
  if (Array.isArray(servers) && servers[0] && typeof servers[0] === "object") {
    const url = (servers[0] as { url?: unknown }).url;
    if (typeof url === "string" && url) {
      if (/^https?:\/\//i.test(url)) return url;
      if (href) {
        try {
          return new URL(url, href).toString();
        } catch {
          /* fall through */
        }
      }
    }
  }
  if (typeof spec.swagger === "string") {
    const host = typeof spec.host === "string" ? spec.host : undefined;
    const basePath = typeof spec.basePath === "string" ? spec.basePath : "";
    const schemes = Array.isArray(spec.schemes) ? spec.schemes : ["https"];
    const scheme = typeof schemes[0] === "string" ? schemes[0] : "https";
    if (host) return `${scheme}://${host}${basePath}`;
  }
  if (href) {
    try {
      return new URL(href).origin;
    } catch {
      return fromConfig;
    }
  }
  return fromConfig;
}

export function mapOperations(spec: Record<string, unknown>): Map<string, MappedOp> {
  const paths = asObject(spec.paths ?? {}, "paths");
  const ops = new Map<string, MappedOp>();
  const used = new Set<string>();
  for (const [path, item] of Object.entries(paths)) {
    if (!item || typeof item !== "object") continue;
    const pathItem = item as Record<string, unknown>;
    const sharedParams = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    for (const method of ["get", "post", "put", "patch", "delete", "head", "options"]) {
      const op = pathItem[method];
      if (!op || typeof op !== "object") continue;
      const operation = op as Record<string, unknown>;
      const rawName =
        (typeof operation.operationId === "string" && operation.operationId) ||
        `${method}_${path}`;
      const localName = uniqueName(sanitizeName(rawName), used);
      used.add(localName);
      const params = [...sharedParams, ...(Array.isArray(operation.parameters) ? operation.parameters : [])];
      const mappedParams: MappedOp["parameters"] = [];
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const raw of params) {
        const p = resolveRef(spec, raw);
        if (!p || typeof p !== "object") continue;
        const param = p as Record<string, unknown>;
        const name = typeof param.name === "string" ? param.name : undefined;
        const loc = typeof param.in === "string" ? param.in : "";
        if (!name || loc === "cookie") continue;
        if (loc === "body") {
          properties.body = derefSchema(spec, param.schema) ?? { type: "object" };
          if (param.required) required.push("body");
          continue;
        }
        mappedParams.push({ name, in: loc, required: Boolean(param.required) });
        properties[name] = param.schema
          ? derefSchema(spec, param.schema)
          : { type: typeof param.type === "string" ? param.type : "string" };
        if (param.required) required.push(name);
      }

      let hasBody = false;
      if (operation.requestBody && typeof operation.requestBody === "object") {
        const body = resolveRef(spec, operation.requestBody) as Record<string, unknown>;
        const content = (body.content ?? {}) as Record<string, unknown>;
        const json =
          (content["application/json"] as Record<string, unknown> | undefined) ??
          (Object.values(content)[0] as Record<string, unknown> | undefined);
        properties.body = json?.schema ? derefSchema(spec, json.schema) : { type: "object" };
        hasBody = true;
        if (body.required) required.push("body");
      } else if (properties.body) {
        hasBody = true;
      }

      const summary = typeof operation.summary === "string" ? operation.summary : "";
      const description = typeof operation.description === "string" ? operation.description : summary;
      ops.set(localName, {
        localName,
        method: method.toUpperCase(),
        path,
        description: description || `${method.toUpperCase()} ${path}`,
        parameters: mappedParams.filter((p) => p.in !== "body"),
        hasBody,
        inputSchema: {
          type: "object",
          properties,
          required: [...new Set(required)],
          additionalProperties: false,
        },
      });
    }
  }
  return ops;
}

function sanitizeName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_.-]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "op";
}

function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}_${i}`)) i += 1;
  return `${base}_${i}`;
}

function resolveRef(spec: Record<string, unknown>, value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const ref = (value as { $ref?: unknown }).$ref;
  if (typeof ref !== "string") return value;
  const resolved = lookupRef(spec, ref);
  if (!resolved || typeof resolved !== "object") return value;
  const rest = { ...(value as Record<string, unknown>) };
  delete rest.$ref;
  return { ...(resolved as Record<string, unknown>), ...rest };
}

function lookupRef(spec: Record<string, unknown>, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let cur: unknown = spec;
  for (const part of ref.slice(2).split("/").map(decodePointer)) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function decodePointer(part: string): string {
  return part.replaceAll("~1", "/").replaceAll("~0", "~");
}

function derefSchema(spec: Record<string, unknown>, schema: unknown, depth = 0): Record<string, unknown> {
  if (!schema || typeof schema !== "object") return { type: "string" };
  if (depth > 10) return { type: "object" };
  const resolved = resolveRef(spec, schema) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...resolved };
  delete out.$ref;
  if (out.properties && typeof out.properties === "object") {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(out.properties as Record<string, unknown>)) {
      props[k] = derefSchema(spec, v, depth + 1);
    }
    out.properties = props;
  }
  if (out.items) out.items = derefSchema(spec, out.items, depth + 1);
  if (Array.isArray(out.allOf)) {
    out.allOf = (out.allOf as unknown[]).map((s) => derefSchema(spec, s, depth + 1));
  }
  return out;
}
