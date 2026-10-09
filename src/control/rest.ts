import { PROTOCOL_CONFIG_HELP, canonicalProtocol, blacklistId, targetFromConfig, inferIngress } from "../catalog/index.js";
import { looksLikeReadRpc } from "../adapters/rpc-gate.js";
import { AdapterError, ERROR_CODE_HELP, ERROR_CODES, errorPayload } from "../runtime/errors.js";
import { invokeAudit, invokeAuditEvents, recordSecurityEvent } from "../runtime/metrics.js";
import { APP_NAME, APP_VERSION, type JsonObject, type McpToolSchema } from "../runtime/types.js";
import { knownProtocols } from "../runtime/bootstrap.js";
import { redactSecrets, SECRET_MASK } from "./redact.js";
import { MANAGEMENT_TOOL_NAMES, callManagementTool, managementToolSchemas, type ManagementContext } from "./tools.js";
import { layerOf } from "./layers.js";
import { allConfigSchemas, configSchemaFor, checkRequiredBySchema, missingRequiredFields } from "../catalog/config-schema.js";
import { hasProtocol, createAdapter } from "../runtime/bootstrap.js";
import { validateRegistration, assertNotBlacklisted } from "../catalog/index.js";
import { assertConfigTargetsAllowed } from "./policy.js";
import { capabilityBlacklistId } from "../catalog/blacklist.js";
import {
  assertPartnerToken,
  partnerHeartbeat,
  partnerInvokeInternal,
  partnerRegister,
  partnerSchemaPayload,
  partnerUnregister,
  readOrCreatePartnerToken,
  rotatePartnerToken,
} from "./partner.js";

export interface RestRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  body?: unknown;
  headers?: Record<string, string>;
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
  "capability_register",
  "capability_unregister",
  "capability_configure",
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
    const skipRedact = normalizeApiPath(req.pathname) === "/api/partner/v1/token";
    return { status: raw.status, body: skipRedact ? raw.body : redactSecrets(raw.body) };
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
    return { status: 200, body: { ok: true, ...(health as object), console: { wave: "X", ui: "/ui/", partner: true } } };
  }

  if (method === "GET" && path === "/api/settings") {
    return { status: 200, body: settingsPayload(ctx) };
  }

  if (method === "GET" && path === "/api/matrix") {
    return { status: 200, body: matrixPayload(ctx) };
  }

  if (method === "GET" && path === "/api/protocols") {
    return { status: 200, body: { ok: true, protocols: allConfigSchemas() } };
  }

  const protoOne = match(method, "GET", "/api/protocols/:id", path);
  if (protoOne) {
    return { status: 200, body: { ok: true, schema: protocolSchemaOrThrow(protoOne.id!) } };
  }

  const protoValidate = match(method, "POST", "/api/protocols/:id/validate", path);
  if (protoValidate) {
    return { status: 200, body: validateAgainstSchema(protoValidate.id!, asObject(body.config ?? body)) };
  }

  if (method === "POST" && path === "/api/adapters/test") {
    return { status: 200, body: await testConnection(ctx, body) };
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

  const toggle = match(method, "POST", "/api/adapters/:id/enabled", path) ?? match(method, "PUT", "/api/adapters/:id/enabled", path);
  if (toggle?.id) {
    return { status: 200, body: await setAdapterEnabled(ctx, toggle.id, body.enabled !== false) };
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
    consoleEvent(ctx, "capability.add", { adapterId: (added as { id?: string }).id, protocol: body.protocol });
    return { status: 201, body: { ...(added as object) } };
  }

  const put = match(method, "PUT", "/api/adapters/:id", path);
  if (put?.id) {
    const incoming = asObject(body.config ?? body);
    const existing = ctx.registry.getRecord(put.id)?.config ?? {};
    const updated = await callManagementTool("mcp_update", { id: put.id, config: unmaskConfig(existing, incoming) }, ctx);
    consoleEvent(ctx, "capability.update", { adapterId: put.id });
    return { status: 200, body: updated };
  }

  const del = match(method, "DELETE", "/api/adapters/:id", path);
  if (del?.id) {
    const removed = await callManagementTool("mcp_remove", { id: del.id }, ctx);
    consoleEvent(ctx, "capability.remove", { adapterId: del.id });
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

  if (method === "GET" && path === "/api/discovery/settings") {
    const d = requireAuto(ctx);
    await d.load();
    return { status: 200, body: { ok: true, settings: d.getSettings(), status: d.status(), scope: d.describe() } };
  }

  if ((method === "PUT" || method === "POST") && path === "/api/discovery/settings") {
    const d = requireAuto(ctx);
    const settings = await d.updateSettings(body as never);
    return { status: 200, body: { ok: true, settings, status: d.status() } };
  }

  if (method === "GET" && path === "/api/discovery/status") {
    const d = requireAuto(ctx);
    await d.load();
    return { status: 200, body: { ok: true, ...d.status() } };
  }

  if (method === "GET" && path === "/api/discovery/candidates") {
    const d = requireAuto(ctx);
    const all = await d.listCandidates();
    const include = req.query.get("status");
    const candidates = include === "all" ? all : all.filter((c) => c.status === (include ?? "new"));
    return { status: 200, body: { ok: true, candidates, counts: d.counts() } };
  }

  if (method === "POST" && path === "/api/discovery/run") {
    const d = requireAuto(ctx);
    const wait = body.wait !== false;
    if (!wait) {
      void d.run("manual").catch(() => undefined);
      return { status: 202, body: { ok: true, started: true, status: d.status() } };
    }
    const run = await d.run("manual");
    return { status: 200, body: { ok: true, run, counts: d.counts() } };
  }

  if (method === "GET" && path === "/api/discovery/runs") {
    const d = requireAuto(ctx);
    await d.load();
    const limit = Number(req.query.get("limit") ?? 20);
    return { status: 200, body: { ok: true, runs: d.listRuns(Number.isFinite(limit) ? limit : 20) } };
  }

  const candEnable = match(method, "POST", "/api/discovery/candidates/:id/enable", path);
  if (candEnable?.id) {
    const d = requireAuto(ctx);
    const result = await d.enable(candEnable.id, {
      name: typeof body.name === "string" ? body.name : undefined,
      config: body.config && typeof body.config === "object" && !Array.isArray(body.config) ? (body.config as JsonObject) : undefined,
      credentials:
        body.credentials && typeof body.credentials === "object" && !Array.isArray(body.credentials)
          ? (Object.fromEntries(Object.entries(body.credentials as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as Record<string, string>)
          : undefined,
    });
    return { status: 201, body: result };
  }

  const candDismiss = match(method, "POST", "/api/discovery/candidates/:id/dismiss", path);
  if (candDismiss?.id) {
    const d = requireAuto(ctx);
    return { status: 200, body: { ok: true, candidate: await d.dismiss(candDismiss.id) } };
  }

  const candRestore = match(method, "POST", "/api/discovery/candidates/:id/restore", path);
  if (candRestore?.id) {
    const d = requireAuto(ctx);
    return { status: 200, body: { ok: true, candidate: await d.restore(candRestore.id) } };
  }

  if (method === "GET" && path === "/api/activity") {
    return { status: 200, body: await activityPayload(ctx, Number(req.query.get("limit") ?? 100)) };
  }

  if (method === "GET" && path === "/api/overview") {
    return { status: 200, body: await overviewPayload(ctx) };
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
    const entry = (added as { entry?: { id?: string; kind?: string } }).entry;
    consoleEvent(ctx, "blacklist.add", { detail: entry?.id ?? "", blacklistKind: entry?.kind });
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
    consoleEvent(ctx, "blacklist.remove", { detail: blDel.id });
    return { status: 200, body: removed };
  }

  if (method === "POST" && path === "/api/environment/inventory") {
    const inv = await callManagementTool("environment_inventory", body, ctx);
    return { status: 200, body: { ok: true, ...(inv as object) } };
  }

  if (method === "POST" && path === "/api/capabilities/register") {
    const auto = body.auto === true;
    if (!auto && body.confirm !== true) {
      throw new AdapterError("E_INVALID_ARGUMENT", "Console hot-add requires confirm:true (or auto:true when Safe+readonly)", {
        details: { confirm: true },
      });
    }
    const registered = await callManagementTool("capability_register", body, ctx);
    return { status: 201, body: registered };
  }

  if (method === "POST" && path === "/api/capabilities/unregister") {
    if (body.confirm !== true) {
      throw new AdapterError("E_INVALID_ARGUMENT", "Console hot-delete requires confirm:true", {
        details: { confirm: true },
      });
    }
    const id = typeof body.id === "string" ? body.id : "";
    const removed = await callManagementTool("capability_unregister", { id }, ctx);
    return { status: 200, body: removed };
  }

  const capDel = match(method, "DELETE", "/api/capabilities/:id", path);
  if (capDel?.id) {
    const confirm = body.confirm === true || req.query.get("confirm") === "true";
    if (!confirm) {
      throw new AdapterError("E_INVALID_ARGUMENT", "Console hot-delete requires confirm:true", {
        details: { confirm: true },
      });
    }
    const removed = await callManagementTool("capability_unregister", { id: capDel.id }, ctx);
    return { status: 200, body: removed };
  }

  if (method === "POST" && path === "/api/capabilities/configure") {
    const configured = await callManagementTool("capability_configure", body, ctx);
    return { status: 200, body: configured };
  }

  if (method === "GET" && path === "/api/partner/v1/schema") {
    return { status: 200, body: partnerSchemaPayload() };
  }

  if (method === "GET" && path === "/api/partner/v1/token") {
    const token = await readOrCreatePartnerToken(ctx.config.dataDir);
    return {
      status: 200,
      body: {
        ok: true,
        token,
        header: "Authorization: Bearer <token> or X-Partner-Token",
        note: "Local partner token (dataDir/partner-token). Loopback control plane. Distinct from EVERYTHING2MCP_HTTP_TOKEN.",
      },
    };
  }

  if ((method === "POST" || method === "PUT") && path === "/api/partner/v1/token") {
    if (body.confirm !== true) {
      throw new AdapterError("E_INVALID_ARGUMENT", "Partner token rotate requires confirm:true", {
        details: { confirm: true },
      });
    }
    const token = await rotatePartnerToken(ctx.config.dataDir);
    return { status: 200, body: { ok: true, token, rotated: true } };
  }

  if (method === "GET" && path === "/api/partner/v1/connections") {
    const listed = await callManagementTool("partner_list", {}, ctx);
    return { status: 200, body: listed };
  }

  if (method === "POST" && path === "/api/compat/scan") {
    const scanned = await callManagementTool("compat_scan", body, ctx);
    return { status: 200, body: scanned };
  }

  if (method === "POST" && path === "/api/partner/v1/register") {
    await assertPartnerToken(ctx, req.headers);
    const registered = await partnerRegister(ctx, body);
    return { status: 201, body: registered };
  }

  if (method === "POST" && path === "/api/partner/v1/unregister") {
    await assertPartnerToken(ctx, req.headers);
    const removed = await partnerUnregister(ctx, body);
    return { status: 200, body: removed };
  }

  if (method === "POST" && path === "/api/partner/v1/heartbeat") {
    await assertPartnerToken(ctx, req.headers);
    return { status: 200, body: await partnerHeartbeat(ctx, body) };
  }

  if (method === "POST" && path === "/api/partner/v1/invoke") {
    await assertPartnerToken(ctx, req.headers);
    return { status: 200, body: await partnerInvokeInternal(ctx, body) };
  }

  throw new AdapterError("E_NOT_FOUND", `No route for ${method} ${path}`, {
    details: { method, path },
  });
}

/** Console-initiated changes show up in 活动 (secrets never included: ids only). */
function consoleEvent(ctx: ManagementContext, tool: string, extra: Record<string, unknown>): void {
  recordSecurityEvent({ ok: true, kind: "policy", tool, actor: "console", ...extra, dataDir: ctx.config.dataDir });
}

/** 当前能力 row toggle: off keeps the registration but unmounts it (no Agent tools). */
async function setAdapterEnabled(ctx: ManagementContext, id: string, enabled: boolean): Promise<Record<string, unknown>> {
  const rec = ctx.registry.getRecord(id);
  if (!rec) throw new AdapterError("E_NOT_FOUND", `Unknown registration id: ${id}`, { details: { id } });
  await ctx.security.assert({
    hook: enabled ? "register" : "unregister",
    actor: { kind: "console", tokenPresent: true },
    target: { protocol: rec.protocol, adapterId: id, config: rec.config },
    config: rec.config,
  });
  await ctx.registry.setEnabled(id, enabled);
  recordSecurityEvent({
    ok: true,
    kind: "policy",
    tool: enabled ? "capability.enable" : "capability.disable",
    adapterId: id,
    protocol: rec.protocol,
    detail: enabled ? "启用" : "停用 (registration kept)",
    dataDir: ctx.config.dataDir,
  });
  const blocked = new Set((await ctx.blacklist.list()).map((e) => e.id));
  const snap = ctx.registry.list().adapters.find((a) => a.id === id) ?? { id };
  return { ok: true, id, enabled, adapter: decorateAdapter(ctx, id, snap, blocked) };
}

/**
 * The console edits redacted configs. A value still equal to the mask means
 * "unchanged": restore the stored secret instead of persisting "••••".
 * Nested objects (auth: {...}) are merged the same way.
 */
export function unmaskConfig(existing: JsonObject, incoming: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (v === SECRET_MASK) {
      if (existing[k] !== undefined) out[k] = existing[k]!;
      continue;
    }
    const prev = existing[k];
    if (v && typeof v === "object" && !Array.isArray(v) && prev && typeof prev === "object" && !Array.isArray(prev)) {
      out[k] = unmaskConfig(prev as JsonObject, v as JsonObject);
      continue;
    }
    out[k] = v;
  }
  return out;
}

function requireAuto(ctx: ManagementContext) {
  if (!ctx.discovery) {
    throw new AdapterError("E_UNSUPPORTED", "Auto-discovery engine is not running in this process");
  }
  return ctx.discovery;
}

/** 活动 page: audit ring + discovery runs, newest first. */
async function activityPayload(ctx: ManagementContext, rawLimit: number): Promise<Record<string, unknown>> {
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, rawLimit)) : 100;
  const audit = ctx.auditLog?.snapshot(limit).events ?? invokeAuditEvents(limit);
  const runs = ctx.discovery ? (await ctx.discovery.load(), ctx.discovery.listRuns(20)) : [];
  const items: Array<Record<string, unknown>> = [
    // discovery.<trigger> audit lines duplicate the run records below; keep settings changes.
    ...audit
      .filter((e) => !(e.kind === "discovery" && runs.length && /^discovery\.(auto|manual|startup)$/.test(e.tool ?? "")))
      .map((e) => ({ type: e.kind === "discovery" ? "discovery" : e.kind ?? "invoke", ...e })),
    ...runs.map((r) => ({
      type: "discovery_run",
      at: r.finishedAt ?? r.startedAt,
      ok: r.ok,
      tool: `discovery.${r.trigger}`,
      detail: `hosts=${r.hostsScanned}/${r.hostsPlanned}${r.truncated ? " (capped)" : ""} found=${r.found} new=${r.newCount} offline=${r.offlineCount}`,
      run: r,
    })),
  ];
  items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const counts = ctx.auditLog?.snapshot(limit).counts ?? invokeAudit();
  return {
    ok: true,
    counts: { ...counts, errors: items.filter((i) => i.ok === false).length, discoveryRuns: runs.length },
    items: items.slice(0, limit),
  };
}

/**
 * Summary strip for the 能力 page. Numbers match the three tabs:
 * current = registered capabilities, supported = protocol catalog + ready
 * discovered candidates, blacklist = all entries (target + capability + tool).
 */
async function overviewPayload(ctx: ManagementContext): Promise<Record<string, unknown>> {
  const snap = ctx.registry.list();
  const entries = await ctx.blacklist.list();
  const blocked = new Set(entries.map((e) => e.id));
  let blockedCaps = 0;
  let enabled = 0;
  let failing = 0;
  let disabled = 0;
  for (const a of snap.adapters) {
    const d = decorateAdapter(ctx, a.id, a, blocked);
    const off = (a.status as string) === "disabled" || d.disabled === true;
    if (d.blacklisted) blockedCaps += 1;
    else if (a.status === "live" && !off) enabled += 1;
    if (off) disabled += 1;
    else if (a.status !== "live") failing += 1;
  }
  const disc = ctx.discovery ? (await ctx.discovery.listCandidates(), ctx.discovery.counts()) : { discovered: 0, ready: 0, needsConfig: 0 };
  const schemas = allConfigSchemas();
  return {
    ok: true,
    current: { total: snap.adapters.length, enabled, disabled, blacklisted: blockedCaps, failing, tools: snap.tools.length },
    supported: { discovered: disc.discovered ?? 0, ready: disc.ready ?? 0, needsConfig: disc.needsConfig ?? 0, failed: (disc as { failed?: number }).failed ?? 0, types: schemas.length },
    blacklist: {
      total: entries.length,
      target: entries.filter((e) => (e.kind ?? "target") === "target").length,
      capability: entries.filter((e) => e.kind === "capability").length,
      tool: entries.filter((e) => e.kind === "tool").length,
    },
    discovery: ctx.discovery ? ctx.discovery.status() : { mode: "off" },
  };
}

function protocolSchemaOrThrow(id: string) {
  if (!hasProtocol(id)) {
    throw new AdapterError("E_UNKNOWN_PROTOCOL", `Unknown protocol: ${id}`, { details: { protocol: id } });
  }
  return configSchemaFor(id);
}

/** Pure schema + validateProtocolConfig check. Never connects. */
function validateAgainstSchema(id: string, config: JsonObject): Record<string, unknown> {
  const schema = protocolSchemaOrThrow(id);
  const missing = missingRequiredFields(id, config).map((f) => f.key);
  let error: string | undefined = checkRequiredBySchema(id, config);
  if (!error) {
    try {
      validateRegistration(id, "probe", config);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
  return { ok: !error, protocol: schema.protocol, missing, error };
}

/**
 * Wizard "测试连接": same gates as mcp_add (validate, SSRF target check,
 * security register hook, blacklist) then connect + listTools on a throwaway
 * adapter instance. Nothing is persisted or exposed to the Agent.
 */
async function testConnection(ctx: ManagementContext, body: JsonObject): Promise<Record<string, unknown>> {
  const protocol = typeof body.protocol === "string" ? body.protocol : "";
  if (!protocol) throw new AdapterError("E_INVALID_ARGUMENT", "protocol is required");
  protocolSchemaOrThrow(protocol);
  const config = asObject(body.config);
  const name = typeof body.name === "string" && body.name ? body.name : "test";
  validateRegistration(protocol, name, config);
  await assertConfigTargetsAllowed(config);
  await ctx.security.assert({
    hook: "register",
    actor: { kind: "console", tokenPresent: true },
    target: { protocol, config },
    config,
  });
  await assertNotBlacklisted(ctx.blacklist, protocol, config);
  const adapter = createAdapter(canonicalProtocol(protocol), `${canonicalProtocol(protocol)}:__test__`);
  const started = Date.now();
  const limit = typeof config.timeoutMs === "number" && config.timeoutMs > 0 ? Math.min(config.timeoutMs, 15_000) : 8_000;
  try {
    const tools = await withDeadline(
      (async () => {
        await adapter.connect(config);
        return adapter.listTools();
      })(),
      limit,
    );
    const health = adapter.health ? await withDeadline(adapter.health(), limit).catch((e) => ({ ok: false, detail: String(e) })) : { ok: true };
    return {
      ok: health.ok !== false,
      protocol: canonicalProtocol(protocol),
      latencyMs: Date.now() - started,
      toolCount: tools.length,
      tools: tools.slice(0, 50).map((t) => t.name),
      health,
    };
  } catch (err) {
    const payload = errorPayload(err);
    return { ok: false, protocol: canonicalProtocol(protocol), latencyMs: Date.now() - started, error: payload };
  } finally {
    await adapter.disconnect().catch(() => undefined);
  }
}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new AdapterError("E_TIMEOUT", `Timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function listAdapters(ctx: ManagementContext): Promise<RestResponse> {
  const listed = (await callManagementTool("mcp_list", { layer: "business", verbose: true, audience: "console" }, ctx)) as {
    adapters: Array<Record<string, unknown>>;
    protocols: string[];
  };
  const blocked = new Set((await ctx.blacklist.list()).map((e) => e.id));
  await ctx.discovery?.load();
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
  let blacklistKind: "target" | "capability" | undefined;
  let blacklistRef: string | undefined;
  if (record) {
    const target = targetFromConfig(record.protocol, record.config);
    if (target) {
      const key = blacklistId(target);
      if (blocked?.has(key)) {
        blacklisted = true;
        blacklistKind = "target";
        blacklistRef = key;
      }
    }
    const capKey = capabilityBlacklistId(id);
    if (!blacklisted && blocked?.has(capKey)) {
      blacklisted = true;
      blacklistKind = "capability";
      blacklistRef = capKey;
    }
  }
  const ingress = record ? inferIngress(record.protocol, record.config) : undefined;
  // 来源 column: discovery candidate → 自动发现, partner ingress → 伙伴, otherwise 手动.
  const source = ctx.discovery?.registeredIds().has(id) ? "discovery" : ingress === "partner" ? "partner" : "manual";
  // 地址 column: host:port only (never the raw URL, which may carry credentials).
  const tgt = record ? targetFromConfig(record.protocol, record.config) : undefined;
  const address = tgt?.host ? (tgt.port ? `${tgt.host}:${tgt.port}` : tgt.host) : undefined;
  const cfg = record?.config ?? {};
  const opsRaw = Array.isArray(cfg.operations) ? cfg.operations : [];
  const operations =
    ingress === "partner"
      ? opsRaw
          .filter((op): op is Record<string, unknown> => Boolean(op) && typeof op === "object" && !Array.isArray(op))
          .map((op) => {
            const name = typeof op.name === "string" ? op.name : "";
            const snapName = typeof (snap as { name?: unknown }).name === "string" ? (snap as { name: string }).name : id;
            const cap = typeof cfg.capability_id === "string" ? cfg.capability_id : snapName;
            return {
              name,
              description: typeof op.description === "string" ? op.description : name,
              risk: op.risk === "write" || op.risk === "desktop" ? op.risk : "readonly",
              tool: name ? `partner.${cap}.${name}` : undefined,
            };
          })
          .filter((op) => op.name)
      : undefined;
  const invokeUrl =
    typeof cfg.invokeUrl === "string"
      ? cfg.invokeUrl
      : cfg.invoke && typeof cfg.invoke === "object" && !Array.isArray(cfg.invoke) && typeof (cfg.invoke as JsonObject).url === "string"
        ? String((cfg.invoke as JsonObject).url)
        : undefined;
  return {
    ...snap,
    config: cfg,
    createdAt: record?.createdAt,
    updatedAt: record?.updatedAt,
    allowWrite: record?.config.allowWrite === true,
    disabled: record?.disabled === true,
    ingress,
    source,
    address: address ?? (invokeUrl ? invokeUrl.replace(/^https?:\/\//i, "").replace(/\/.*$/, "") : undefined),
    displayName: typeof cfg.display_name === "string" ? cfg.display_name : undefined,
    invokeUrl,
    operations,
    blacklisted,
    blacklistKind,
    blacklistId: blacklistRef,
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
    discovery: { ...ctx.config.discovery, mode: ctx.discovery?.getSettings().mode ?? "off", auto: ctx.discovery?.status() },
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
      wave: "X",
      ui: "/ui/",
      redesign: true,
      autoDiscovery: Boolean(ctx.discovery),
      discovery: true,
      import: true,
      plan: true,
      audit: true,
      partner: true,
      compat: true,
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
        title: configSchemaFor(canonical).title,
        pack: configSchemaFor(canonical).pack,
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
