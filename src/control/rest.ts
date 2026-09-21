import { PROTOCOL_CONFIG_HELP, canonicalProtocol, blacklistId, targetFromConfig } from "../catalog/index.js";
import { looksLikeReadRpc } from "../adapters/rpc-gate.js";
import { AdapterError, ERROR_CODE_HELP, ERROR_CODES, errorPayload } from "../runtime/errors.js";
import { invokeAudit, invokeAuditEvents } from "../runtime/metrics.js";
import { APP_NAME, APP_VERSION, type JsonObject, type McpToolSchema } from "../runtime/types.js";
import { knownProtocols } from "../runtime/bootstrap.js";
import { redactSecrets } from "./redact.js";
import { MANAGEMENT_TOOL_NAMES, callManagementTool, managementToolSchemas, type ManagementContext } from "./tools.js";
import { layerOf } from "./layers.js";

export interface RestRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  body?: unknown;
}

export interface RestResponse {
  status: number;
  body: unknown;
}

const MUTATING_MANAGEMENT = new Set([
  "mcp_add",
  "mcp_update",
  "mcp_remove",
  "mcp_add_from_discovery",
  "schema_import",
]);

/**
 * Console REST dispatcher. Reuses control/catalog (mcp_* / discovery_* / schema_import).
 * Transport only routes `/api/*` here — no copied registry logic.
 */
export async function handleConsoleRest(ctx: ManagementContext, req: RestRequest): Promise<RestResponse> {
  const consoleCtx: ManagementContext = {
    ...ctx,
    actor: { kind: "console", tokenPresent: true },
  };
  try {
    const raw = await dispatch(consoleCtx, req);
    return { status: raw.status, body: redactSecrets(raw.body) };
  } catch (err) {
    return errorResponse(err);
  }
}

async function dispatch(ctx: ManagementContext, req: RestRequest): Promise<RestResponse> {
  const method = req.method.toUpperCase();
  const path = normalizeApiPath(req.pathname);
  const body = asObject(req.body);

  if (method === "GET" && path === "/api/health") {
    const health = await callManagementTool("mcp_health", { verbose: true }, ctx);
    return { status: 200, body: { ok: true, ...(health as object), console: { wave: "W3", ui: "/ui/" } } };
  }

  if (method === "GET" && path === "/api/settings") {
    return { status: 200, body: settingsPayload(ctx) };
  }

  if (method === "GET" && path === "/api/matrix") {
    return { status: 200, body: matrixPayload(ctx) };
  }

  if (method === "GET" && path === "/api/audit") {
    const rawLimit = Number(req.query.get("limit") ?? 50);
    const limit = Number.isFinite(rawLimit) ? rawLimit : 50;
    return {
      status: 200,
      body: {
        ok: true,
        counts: ctx.auditLog?.snapshot(limit).counts ?? invokeAudit(),
        events: ctx.auditLog?.snapshot(limit).events ?? invokeAuditEvents(limit),
        persisted: Boolean(ctx.auditLog),
        policy: { allowWriteDefault: false, cidrScanDefault: false },
        note: "Append-only dataDir/audit.jsonl (reload on start). In-memory ring is still process-local.",
      },
    };
  }

  if (method === "POST" && path === "/api/plan") {
    const goal = typeof body.goal === "string" ? body.goal : "";
    if (!goal.trim()) {
      throw new AdapterError("E_INVALID_ARGUMENT", 'Missing required string argument "goal"');
    }
    const planned = await callManagementTool("mcp_plan_bridge", body, ctx);
    return {
      status: 200,
      body: {
        ok: true,
        plan: planned,
        links: { discovery: "/ui/#/discovery", import: "/ui/#/import", adapters: "/ui/#/adapters/new" },
      },
    };
  }

  if (method === "GET" && path === "/api/errors") {
    return {
      status: 200,
      body: {
        ok: true,
        codes: ERROR_CODES.map((code) => ({ code, help: ERROR_CODE_HELP[code] })),
      },
    };
  }

  const ping = match(method, "POST", "/api/adapters/:id/ping", path);
  if (ping?.id) return pingAdapter(ctx, ping.id);

  const one = match(method, "GET", "/api/adapters/:id", path);
  if (one?.id) return getAdapter(ctx, one.id);

  if (method === "GET" && path === "/api/adapters") {
    return listAdapters(ctx);
  }

  if (method === "POST" && path === "/api/adapters") {
    const added = await callManagementTool("mcp_add", body, ctx);
    return { status: 201, body: { ...(added as object) } };
  }

  const put = match(method, "PUT", "/api/adapters/:id", path);
  if (put?.id) {
    const updated = await callManagementTool("mcp_update", { id: put.id, config: body.config ?? body }, ctx);
    return { status: 200, body: updated };
  }

  const del = match(method, "DELETE", "/api/adapters/:id", path);
  if (del?.id) {
    const removed = await callManagementTool("mcp_remove", { id: del.id }, ctx);
    return { status: 200, body: removed };
  }

  const invoke = match(method, "POST", "/api/tools/:name/invoke", path);
  if (invoke?.name) return invokeTool(ctx, invoke.name, body);

  const tool = match(method, "GET", "/api/tools/:name", path);
  if (tool?.name) {
    const explained = await callManagementTool("mcp_explain_tool", { name: tool.name }, ctx);
    return { status: 200, body: { ok: true, ...(explained as object) } };
  }

  if (method === "GET" && path === "/api/tools") {
    const layer = parseLayer(req.query.get("layer"));
    const listed = await callManagementTool(
      "mcp_list",
      { layer, verbose: req.query.get("verbose") === "true", audience: "console" },
      ctx,
    );
    return { status: 200, body: { ok: true, ...(listed as object) } };
  }

  if (method === "GET" && path === "/api/security") {
    return { status: 200, body: await securityPayload(ctx) };
  }

  if (method === "GET" && path === "/api/security/mode") {
    return { status: 200, body: { ok: true, mode: ctx.security.mode() } };
  }

  if ((method === "PUT" || method === "POST") && (path === "/api/security/mode" || path === "/api/security")) {
    const mode = typeof body.mode === "string" ? body.mode : "";
    if (body.confirm !== true) {
      throw new AdapterError("E_INVALID_ARGUMENT", "Mode change requires confirm:true", {
        details: { confirm: true },
      });
    }
    if (mode !== "safe" && mode !== "full") {
      throw new AdapterError("E_INVALID_ARGUMENT", "security.mode must be safe or full");
    }
    await ctx.security.setMode(mode, { actor: { kind: "console", tokenPresent: true } });
    return { status: 200, body: { ok: true, mode: ctx.security.mode(), modules: ctx.security.list() } };
  }

  if (method === "POST" && path === "/api/discovery/scan") {
    const scanned = await callManagementTool("discovery_scan_host", body, ctx);
    return { status: 200, body: { ok: true, ...(scanned as object) } };
  }

  if (method === "POST" && path === "/api/discovery/probe") {
    const probed = await callManagementTool("discovery_probe", body, ctx);
    return { status: 200, body: { ok: true, ...(probed as object) } };
  }

  if (method === "POST" && path === "/api/discovery/suggest") {
    const suggested = await callManagementTool("discovery_suggest", body, ctx);
    return { status: 200, body: { ok: true, ...(suggested as object) } };
  }

  if (method === "POST" && path === "/api/discovery/register") {
    const registered = await callManagementTool("mcp_add_from_discovery", body, ctx);
    return { status: 201, body: registered };
  }

  if (method === "POST" && path === "/api/import") {
    const imported = await callManagementTool("schema_import", body, ctx);
    return { status: 200, body: imported };
  }

  if (method === "GET" && path === "/api/blacklist") {
    const listed = await callManagementTool("mcp_blacklist_list", {}, ctx);
    return { status: 200, body: listed };
  }

  if (method === "POST" && path === "/api/blacklist") {
    const added = await callManagementTool("mcp_blacklist_add", body, ctx);
    return { status: 201, body: added };
  }

  const blOne = match(method, "GET", "/api/blacklist/:id", path);
  if (blOne?.id) {
    const listed = (await callManagementTool("mcp_blacklist_list", {}, ctx)) as { entries: Array<{ id: string }> };
    const entry = listed.entries.find((e) => e.id === blOne.id);
    if (!entry) throw new AdapterError("E_NOT_FOUND", `Unknown blacklist id: ${blOne.id}`, { details: { id: blOne.id } });
    return { status: 200, body: { ok: true, entry } };
  }

  const blDel = match(method, "DELETE", "/api/blacklist/:id", path);
  if (blDel?.id) {
    const removed = await callManagementTool("mcp_blacklist_remove", { id: blDel.id }, ctx);
    return { status: 200, body: removed };
  }

  throw new AdapterError("E_NOT_FOUND", `No route for ${method} ${path}`, {
    details: { method, path },
  });
}

async function listAdapters(ctx: ManagementContext): Promise<RestResponse> {
  const listed = (await callManagementTool("mcp_list", { layer: "business", verbose: true, audience: "console" }, ctx)) as {
    adapters: Array<Record<string, unknown>>;
    protocols: string[];
  };
  const blocked = new Set((await ctx.blacklist.list()).map((e) => e.id));
  const adapters = listed.adapters.map((snap) => decorateAdapter(ctx, String(snap.id), snap, blocked));
  return { status: 200, body: { ok: true, adapters, protocols: listed.protocols } };
}

async function getAdapter(ctx: ManagementContext, id: string): Promise<RestResponse> {
  const listed = ctx.registry.list();
  const snap = listed.adapters.find((a) => a.id === id);
  if (!snap) {
    throw new AdapterError("E_NOT_FOUND", `Unknown registration id: ${id}`, { details: { id } });
  }
  const blocked = new Set((await ctx.blacklist.list()).map((e) => e.id));
  return { status: 200, body: { ok: true, adapter: decorateAdapter(ctx, id, snap, blocked) } };
}

function decorateAdapter(
  ctx: ManagementContext,
  id: string,
  snap: Record<string, unknown> | object,
  blocked?: Set<string>,
): Record<string, unknown> {
  const record = ctx.registry.getRecord(id);
  let blacklisted = false;
  if (record) {
    const target = targetFromConfig(record.protocol, record.config);
    if (target) {
      const key = blacklistId(target);
      blacklisted = blocked ? blocked.has(key) : false;
    }
  }
  return {
    ...snap,
    config: record?.config ?? {},
    createdAt: record?.createdAt,
    updatedAt: record?.updatedAt,
    allowWrite: record?.config.allowWrite === true,
    blacklisted,
  };
}

async function pingAdapter(ctx: ManagementContext, id: string): Promise<RestResponse> {
  const inst = ctx.registry.get(id);
  const record = ctx.registry.getRecord(id);
  if (!record) {
    throw new AdapterError("E_NOT_FOUND", `Unknown registration id: ${id}`, { details: { id } });
  }
  if (!inst) {
    return {
      status: 200,
      body: { ok: false, id, status: "restore_failed", health: { ok: false, detail: "not live" } },
    };
  }
  const health = inst.adapter.health ? await inst.adapter.health() : { ok: true };
  return { status: 200, body: { ok: health.ok, id, status: "live", health } };
}

async function invokeTool(ctx: ManagementContext, name: string, body: JsonObject): Promise<RestResponse> {
  if (MANAGEMENT_TOOL_NAMES.has(name)) {
    throw new AdapterError(
      "E_UNSUPPORTED",
      `Management tool ${name} is not try-invoked from the console. Use the dedicated /api routes.`,
      { details: { name, layer: "management" } },
    );
  }
  const found = ctx.registry.lookupTool(name);
  if (!found) {
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown tool: ${name}`, { details: { tool: name } });
  }
  const write = isWriteTool(found.schema, found.localName);
  const args = asObject(body.arguments ?? body.args ?? body);
  const confirm = body.confirm === true;
  if (write && !confirm) {
    throw new AdapterError(
      "E_INVALID_ARGUMENT",
      "Write invoke requires confirm:true in the console. Writes stay gated by config.allowWrite.",
      { details: { tool: name, write: true, allowWriteDefault: false } },
    );
  }
  const rec = ctx.registry.getRecord(found.adapterId);
  await ctx.security.assert({
    hook: "invoke",
    actor: { kind: "console", tokenPresent: true },
    challengeSatisfied: confirm,
    tool: { name, layer: "business", write, adapterId: found.adapterId, protocol: found.protocol },
    target: rec ? { protocol: rec.protocol, adapterId: rec.id, config: rec.config } : undefined,
  });
  const result = await ctx.registry.invoke(name, stripInvokeMeta(args));
  return {
    status: 200,
    body: {
      ok: true,
      name,
      write,
      confirmed: write ? true : undefined,
      result,
    },
  };
}

function stripInvokeMeta(args: JsonObject): JsonObject {
  const { confirm: _c, arguments: _a, args: _args, ...rest } = args;
  return rest;
}

export function isWriteTool(schema: McpToolSchema | undefined, localName: string): boolean {
  if (schema?.annotations?.readOnlyHint === true) return false;
  if (schema?.annotations?.readOnlyHint === false) return true;
  if (schema?.annotations?.destructiveHint === true) return true;
  if (schema && MUTATING_MANAGEMENT.has(schema.name)) return true;
  return !looksLikeReadRpc(localName || schema?.name || "");
}

function settingsPayload(ctx: ManagementContext): unknown {
  const t = ctx.config.transport;
  return {
    ok: true,
    app: APP_NAME,
    version: APP_VERSION,
    dataDir: ctx.config.dataDir,
    discovery: ctx.config.discovery,
    transport: {
      kind: t.kind,
      host: t.host,
      port: t.port,
      mcpPath: t.mcpPath,
      ssePath: t.ssePath,
      messagesPath: t.messagesPath,
      tokenConfigured: Boolean(t.token),
      tokenHeader: t.tokenHeader,
    },
    policy: { allowWriteDefault: false, cidrScanDefault: false, fullDoesNotEnableWrite: true },
    rateLimit: ctx.config.rateLimit,
    security: { mode: ctx.security.mode(), modules: ctx.security.list() },
    protocols: knownProtocols(),
    protocolHelp: PROTOCOL_CONFIG_HELP,
    layers: ["business", "management", "all"],
    console: {
      wave: "W3",
      ui: "/ui/",
      discovery: true,
      import: true,
      plan: true,
      audit: true,
      tryInvoke: "read-only default",
      blacklist: true,
      security: true,
    },
  };
}

async function securityPayload(ctx: ManagementContext): Promise<unknown> {
  return {
    ok: true,
    mode: ctx.security.mode(),
    modules: ctx.security.list(),
    policy: {
      allowWriteDefault: false,
      cidrScanDefault: false,
      blacklistInFull: true,
      fullDoesNotEnableWrite: true,
    },
    integrity: {
      ...(await ctx.security.integritySnapshot()),
      note: "SHA-256 of security.json / blacklist.json / registrations.json. HMAC-SHA256 when EVERYTHING2MCP_INTEGRITY_KEY or dataDir/.integrity-key is set (ledger MAC rejects tampering).",
    },
    rateLimit: ctx.config.rateLimit,
    note: "Mode is not an MCP tool. CIDR is never allowed. builtin-blacklist runs in Full. Full skips plane allow-write and rate-limit only; adapters still assertCanWrite (default false).",
  };
}

function matrixPayload(ctx: ManagementContext): unknown {
  const snapshot = ctx.registry.list();
  const byProto = new Map<string, number>();
  for (const a of snapshot.adapters) {
    byProto.set(a.protocol, (byProto.get(a.protocol) ?? 0) + 1);
  }
  const protocols = knownProtocols()
    .map((id) => {
      const canonical = canonicalProtocol(id);
      return {
        id,
        canonical,
        help: PROTOCOL_CONFIG_HELP[canonical] ?? PROTOCOL_CONFIG_HELP[id] ?? "",
        registered: byProto.get(canonical) ?? byProto.get(id) ?? 0,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    ok: true,
    policy: { allowWriteDefault: false, cidrScanDefault: false },
    counts: { protocols: protocols.length, adapters: snapshot.adapters.length, tools: snapshot.tools.length },
    protocols,
  };
}

function parseLayer(value: string | null): "business" | "management" | "all" {
  if (value === "management" || value === "all" || value === "business") return value;
  return "business";
}

function asObject(value: unknown): JsonObject {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new AdapterError("E_INVALID_ARGUMENT", "JSON object body required");
  }
  return value as JsonObject;
}

function normalizeApiPath(pathname: string): string {
  if (!pathname) return "/";
  const withSlash = pathname.startsWith("/") ? pathname : `/${pathname}`;
  if (withSlash.length > 1 && withSlash.endsWith("/")) return withSlash.slice(0, -1);
  return withSlash;
}

function match(
  method: string,
  wantMethod: string,
  pattern: string,
  pathname: string,
): Record<string, string> | undefined {
  if (method !== wantMethod) return undefined;
  const pp = pattern.split("/").filter(Boolean);
  const ap = pathname.split("/").filter(Boolean);
  if (pp.length !== ap.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < pp.length; i++) {
    const p = pp[i]!;
    const a = ap[i]!;
    if (p.startsWith(":")) {
      params[p.slice(1)] = decodeURIComponent(a);
    } else if (p !== a) {
      return undefined;
    }
  }
  return params;
}

function errorResponse(err: unknown): RestResponse {
  const payload = errorPayload(err);
  const status =
    payload.code === "E_AUTH"
      ? 401
      : payload.code === "E_NOT_FOUND" || payload.code === "E_UNKNOWN_TOOL"
        ? 404
        : payload.code === "E_CONFLICT"
          ? 409
          : payload.code === "E_INVALID_ARGUMENT" || payload.code === "E_INVALID_CONFIG" || payload.code === "E_UNKNOWN_PROTOCOL"
            ? 400
            : payload.code === "E_UNSUPPORTED" || payload.code === "E_BLACKLISTED"
              ? 403
              : 500;
  return { status, body: payload };
}

export { layerOf };
