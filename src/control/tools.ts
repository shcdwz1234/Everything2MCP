import {
  PROTOCOL_CONFIG_HELP,
  canonicalProtocol,
  validateProtocolConfig,
  validateRegistration,
} from "../catalog/index.js";
import { assertNotBlacklisted, type BlacklistStore } from "../catalog/blacklist.js";
import type { ToolRegistry } from "../catalog/registry.js";
import { importSchema } from "../discovery/import.js";
import { planBridge, type BridgePlan } from "../discovery/plan.js";
import { probeHost } from "../discovery/probe.js";
import { scanHost } from "../discovery/scan.js";
import { suggestFromCandidates, type SuggestedRegistration } from "../discovery/suggest.js";
import { knownProtocols } from "../runtime/bootstrap.js";
import { AdapterError } from "../runtime/errors.js";
import type { AuditLog } from "../runtime/audit-log.js";
import { invokeAudit } from "../runtime/metrics.js";
import { APP_NAME, APP_VERSION, type AppConfig, type JsonObject, type McpToolSchema } from "../runtime/types.js";
import { withLayer } from "./layers.js";
import { allowRegistration, assertConfigTargetsAllowed, assertProbeTarget } from "./policy.js";
import { defaultActor, type PolicyContext, type SecurityPlane } from "./security/index.js";

export interface ManagementContext {
  registry: ToolRegistry;
  config: AppConfig;
  blacklist: BlacklistStore;
  security: SecurityPlane;
  auditLog?: AuditLog;
  /** MCP tools/call is mcp-stdio. Console REST must set console. Missing → agent. */
  actor?: PolicyContext["actor"];
}

function actorOf(ctx: ManagementContext): PolicyContext["actor"] {
  return ctx.actor ?? defaultActor("mcp-stdio");
}

/** Operator view only when the caller is the console, not an Agent spoofing audience=console. */
function wantsConsoleView(ctx: ManagementContext, requested?: unknown): boolean {
  return actorOf(ctx).kind === "console" && requested === "console";
}

function filterAdaptersForVisible<T extends { tools: string[]; toolCount?: number }>(
  adapters: T[],
  visible: Set<string>,
): T[] {
  return adapters.map((a) => {
    const tools = a.tools.filter((n) => visible.has(n));
    return { ...a, tools, toolCount: tools.length };
  });
}

export function managementToolSchemas(config: AppConfig): McpToolSchema[] {
  const tools: McpToolSchema[] = [
    {
      name: "mcp_list",
      description:
        "List tools by layer: management (mcp_*/discovery_*) vs business (protocol.name.op). Default layer=business so agents are not flooded.",
      inputSchema: {
        type: "object",
        properties: {
          verbose: { type: "boolean", description: "Include per-adapter health checks", default: false },
          layer: {
            type: "string",
            enum: ["business", "management", "all"],
            default: "business",
            description: "business = registered adapter tools; management = catalog/discovery; all = both",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "mcp_add",
      description:
        "Dynamically register a protocol endpoint. Tools appear immediately as namespaced MCP tools (protocol.name.operation).",
      inputSchema: {
        type: "object",
        properties: {
          protocol: {
            type: "string",
            description: `Adapter protocol. Built-in: ${knownProtocols().join(", ")}`,
          },
          name: { type: "string", description: "Logical name used in tool prefixes and registration id" },
          config: {
            type: "object",
            additionalProperties: true,
            description:
              `Protocol-specific config. ${Object.entries(PROTOCOL_CONFIG_HELP)
                .map(([k, v]) => `${k}: ${v}`)
                .join(". ")}`,
          },
        },
        required: ["protocol", "name", "config"],
        additionalProperties: false,
      },
    },
    {
      name: "mcp_update",
      description: "Update an existing registration's config and reconnect/reload its tools",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Registration id from mcp_list (protocol:name)" },
          config: { type: "object", additionalProperties: true },
        },
        required: ["id", "config"],
        additionalProperties: false,
      },
    },
    {
      name: "mcp_remove",
      description: "Disconnect an adapter and unregister its tools",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
    {
      name: "mcp_query_by_protocol",
      description: "Filter live adapters and tools by protocol type",
      inputSchema: {
        type: "object",
        properties: {
          protocol: { type: "string" },
        },
        required: ["protocol"],
        additionalProperties: false,
      },
    },
    {
      name: "mcp_health",
      description: "Process + adapter health snapshot for agents (live/restore_failed, tool counts)",
      inputSchema: {
        type: "object",
        properties: {
          verbose: { type: "boolean", default: true },
        },
        additionalProperties: false,
      },
    },
    {
      name: "mcp_explain_tool",
      description: "Explain a namespaced MCP tool: adapter, protocol, local operation, input schema",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Full tool name, e.g. openapi.widgets.getWidget" },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
    {
      name: "mcp_plan_bridge",
      description:
        "Turn a natural-language goal into recommended protocols, example configs, and next MCP tool calls. Does not scan by itself.",
      inputSchema: {
        type: "object",
        properties: {
          goal: { type: "string", description: "What the agent wants to connect or automate" },
          host: { type: "string", description: "Optional single hostname/IP to include in the plan" },
        },
        required: ["goal"],
        additionalProperties: false,
      },
    },
    {
      name: "mcp_add_from_discovery",
      description: "Register an adapter from a discovery_suggest payload (protocol + name + config + confidence)",
      inputSchema: {
        type: "object",
        properties: {
          suggestion: { type: "object", additionalProperties: true },
          protocol: { type: "string" },
          name: { type: "string" },
          config: { type: "object", additionalProperties: true },
        },
        additionalProperties: false,
      },
    },
    {
      name: "schema_import",
      description:
        "Import OpenAPI, WSDL, proto, GraphQL SDL, or AsyncAPI from a URL or file (OpenAPI servers[] become config.baseUrl). OData / JSON:API / tRPC / Connect-RPC are import-first: export OpenAPI (or pass gRPC target for Connect proto).",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string", description: "File path or http(s) URL" },
          kind: {
            type: "string",
            enum: ["openapi", "wsdl", "proto", "graphql", "asyncapi", "odata", "jsonapi", "trpc", "connectrpc"],
            description: "Force schema kind; otherwise auto-detect. odata/jsonapi/trpc/connectrpc are import-first.",
          },
          name: { type: "string" },
          register: { type: "boolean", default: true },
          target: { type: "string", description: "gRPC host:port when importing a .proto" },
          url: { type: "string", description: "GraphQL HTTP endpoint when importing SDL" },
          config: { type: "object", additionalProperties: true, description: "Extra adapter config merged in" },
        },
        required: ["source"],
        additionalProperties: false,
      },
    },
    {
      name: "mcp_blacklist_list",
      description:
        "List operator blacklist entries. Match key is canonical protocol + host + port (or normalized url). See docs/BLACKLIST.md.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "mcp_blacklist_add",
      description:
        "Add a protocol+host+port (or network url) to the blacklist. Blocks mcp_add, discovery one-click register, and invoke on matching adapters.",
      inputSchema: {
        type: "object",
        properties: {
          protocol: { type: "string" },
          host: { type: "string" },
          port: { type: "integer" },
          url: { type: "string", description: "Network URL; file paths are ignored" },
          reason: { type: "string" },
        },
        required: ["protocol"],
        additionalProperties: false,
      },
    },
    {
      name: "mcp_blacklist_remove",
      description: "Remove a blacklist entry by id (protocol|host|port)",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
    {
      name: "discovery_suggest",
      description:
        "Map probe/scan candidates to one-click mcp_add drafts (protocol, name, config, confidence). Pass candidates or a host to scan first.",
      inputSchema: {
        type: "object",
        properties: {
          host: { type: "string" },
          port: { type: "integer" },
          https: { type: "boolean" },
          protocols: { type: "array", items: { type: "string" } },
          candidates: { type: "array", items: { type: "object", additionalProperties: true } },
        },
        additionalProperties: false,
      },
    },
  ];

  if (config.discovery.enabled) {
    tools.push(
      {
        name: "discovery_probe",
        description:
          "Probe a single host+port for common OpenAPI/SOAP/GraphQL paths. CIDR / ranges are never allowed.",
        inputSchema: {
          type: "object",
          properties: {
            host: { type: "string", description: "Hostname or single IP. CIDR / ranges / wildcards are never allowed." },
            port: { type: "integer", description: "TCP port (default 80, or 443 if https=true)" },
            https: { type: "boolean", default: false },
            protocols: {
              type: "array",
              items: { type: "string" },
              description: "Limit probes: openapi, soap, graphql",
            },
          },
          required: ["host"],
          additionalProperties: false,
        },
      },
      {
        name: "discovery_scan_host",
        description:
          "Parallel single-host discovery: OpenAPI/WSDL/GraphQL paths, gRPC reflection, Redis PING, MQTT CONNECT, Modbus, CoAP, NATS INFO, JSON-RPC/XML-RPC, Pulsar 8080/6650, GCS 4443, Influx 8086, OSS headers, SMTP 25/587 220-banner. CIDR / ranges are never allowed (EVERYTHING2MCP_DISCOVERY_ALLOW_SCAN is ignored). Timeouts + SSRF (blocks metadata IPs).",
        inputSchema: {
          type: "object",
          properties: {
            host: { type: "string", description: "Single hostname or IP. CIDR / ranges / wildcards are never allowed." },
            port: { type: "integer", description: "If set, HTTP probes this port; well-known protocol ports still tried unless onlyGivenPort" },
            https: { type: "boolean" },
            protocols: { type: "array", items: { type: "string" } },
            onlyGivenPort: { type: "boolean", default: false },
          },
          required: ["host"],
          additionalProperties: false,
        },
      },
    );
  }
  return tools.map((t) => withLayer(t, "management"));
}

export const MANAGEMENT_TOOL_NAMES = new Set([
  "mcp_list",
  "mcp_add",
  "mcp_update",
  "mcp_remove",
  "mcp_query_by_protocol",
  "mcp_health",
  "mcp_explain_tool",
  "mcp_plan_bridge",
  "mcp_add_from_discovery",
  "schema_import",
  "discovery_suggest",
  "discovery_probe",
  "discovery_scan_host",
  "mcp_blacklist_list",
  "mcp_blacklist_add",
  "mcp_blacklist_remove",
]);

export async function callManagementTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ManagementContext,
): Promise<unknown> {
  switch (name) {
    case "mcp_list":
      return list(
        ctx,
        Boolean(args.verbose),
        parseLayer(args.layer),
        wantsConsoleView(ctx, args.audience) ? "console" : "agent",
      );
    case "mcp_add":
      return add(ctx, args);
    case "mcp_update":
      return update(ctx, args);
    case "mcp_remove":
      return remove(ctx, args);
    case "mcp_query_by_protocol":
      return query(ctx, args);
    case "mcp_health":
      return health(ctx, args.verbose !== false);
    case "mcp_explain_tool":
      return explain(ctx, args);
    case "mcp_plan_bridge":
      return enrichPlan(
        planBridge(requiredString(args, "goal"), {
          host: typeof args.host === "string" ? args.host : undefined,
        }),
      );
    case "mcp_add_from_discovery":
      return addFromDiscovery(ctx, args);
    case "schema_import":
      return schemaImport(ctx, args);
    case "discovery_suggest":
      return suggest(ctx, args);
    case "discovery_probe":
      return probe(ctx, args);
    case "discovery_scan_host":
      return scan(ctx, args);
    case "mcp_blacklist_list":
      return blacklistList(ctx);
    case "mcp_blacklist_add":
      return blacklistAdd(ctx, args);
    case "mcp_blacklist_remove":
      return blacklistRemove(ctx, args);
    default:
      throw new Error(`Unknown management tool: ${name}`);
  }
}

async function list(
  ctx: ManagementContext,
  verbose: boolean,
  layer: "business" | "management" | "all",
  audience: "agent" | "console" = "agent",
) {
  const snapshot = ctx.registry.list();
  let adapters = verbose ? await ctx.registry.enrichHealth(snapshot.adapters) : snapshot.adapters;
  const management = managementToolSchemas(ctx.config).map((t) => ({
    name: t.name,
    description: t.description,
    layer: "management" as const,
  }));
  let business = snapshot.tools.map((t) => ({
    ...t,
    layer: "business" as const,
  }));
  if (audience !== "console") {
    business = await ctx.security.hideAgentTools(business);
    const visible = new Set(business.map((t) => t.name));
    adapters = filterAdaptersForVisible(adapters, visible);
  }
  const policy = { allowWriteDefault: false, cidrScanDefault: false };
  const counts = { management: management.length, business: business.length };
  if (layer === "management") {
    return { layer, counts, policy, management, adapters: [], tools: management, protocols: snapshot.protocols };
  }
  if (layer === "all") {
    return {
      layer,
      counts,
      policy,
      management,
      adapters,
      tools: [...management, ...business],
      protocols: snapshot.protocols,
    };
  }
  return {
    layer: "business",
    counts,
    policy,
    /** Compact names so agents can find management tools without listing every schema. */
    management: management.map((m) => m.name),
    adapters,
    tools: business,
    protocols: snapshot.protocols,
  };
}

async function add(ctx: ManagementContext, args: Record<string, unknown>) {
  const protocol = requiredString(args, "protocol");
  const name = requiredString(args, "name");
  const config = requiredObject(args, "config");
  allowRegistration(protocol, name);
  await assertConfigTargetsAllowed(config);
  validateRegistration(protocol, name, config);
  await ctx.security.assert({
    hook: "register",
    actor: actorOf(ctx),
    target: { protocol, config },
    config,
  });
  await assertNotBlacklisted(ctx.blacklist, protocol, config);
  const inst = await ctx.registry.add(protocol, name, config);
  return {
    ok: true,
    id: inst.record.id,
    protocol: inst.record.protocol,
    tools: inst.tools.map((t) => t.name),
  };
}

async function update(ctx: ManagementContext, args: Record<string, unknown>) {
  const id = requiredString(args, "id");
  const config = requiredObject(args, "config");
  await assertConfigTargetsAllowed(config);
  const existing = ctx.registry.getRecord(id);
  await ctx.security.assert({
    hook: "register",
    actor: actorOf(ctx),
    target: { protocol: existing?.protocol, adapterId: id, config: { ...(existing?.config ?? {}), ...config } },
    config,
  });
  const inst = await ctx.registry.update(id, config);
  // update already re-checks blacklist on the merged config
  return {
    ok: true,
    id: inst.record.id,
    tools: inst.tools.map((t) => t.name),
  };
}

async function remove(ctx: ManagementContext, args: Record<string, unknown>) {
  const id = requiredString(args, "id");
  const removed = await ctx.registry.remove(id);
  if (!removed) throw new AdapterError("E_NOT_FOUND", `Unknown registration id: ${id}`, { details: { id } });
  return { ok: true, id };
}

async function query(ctx: ManagementContext, args: Record<string, unknown>) {
  const protocol = requiredString(args, "protocol");
  const snapshot = ctx.registry.queryByProtocol(protocol);
  if (wantsConsoleView(ctx, "console")) return snapshot;
  const tools = await ctx.security.hideAgentTools(snapshot.tools);
  const visible = new Set(tools.map((t) => t.name));
  return {
    ...snapshot,
    tools,
    adapters: filterAdaptersForVisible(snapshot.adapters, visible),
  };
}

async function health(ctx: ManagementContext, verbose: boolean) {
  const snapshot = ctx.registry.list();
  const adapters = verbose ? await ctx.registry.enrichHealth(snapshot.adapters) : snapshot.adapters;
  const failed = adapters.filter((a) => a.status === "restore_failed" || a.health?.ok === false);
  const hints: string[] = [];
  if (adapters.length === 0) {
    hints.push(
      "No live adapters. Golden path: mcp_plan_bridge → discovery_scan_host → mcp_add_from_discovery (or schema_import) → mcp_health / mcp_explain_tool.",
    );
  }
  for (const a of failed) {
    const help = PROTOCOL_CONFIG_HELP[canonicalProtocol(a.protocol)];
    const extra = a.error ? `: ${a.error}` : a.health?.detail ? `: ${a.health.detail}` : "";
    hints.push(
      `${a.id} is ${a.status}${extra}. Expected config ${help ?? "(see mcp_add)"}. Call mcp_update with the missing keys, or mcp_remove.`,
    );
  }
  const hidden = await ctx.security.hideAgentTools(snapshot.tools);
  const visibleNames = new Set(hidden.map((t) => t.name));
  const consoleView = wantsConsoleView(ctx, "console");
  const businessTools = consoleView ? snapshot.tools : hidden;
  const agentAdapters = consoleView ? adapters : filterAdaptersForVisible(adapters, visibleNames);
  return {
    ok: failed.length === 0,
    app: APP_NAME,
    version: APP_VERSION,
    discovery: ctx.config.discovery,
    adapterCount: agentAdapters.length,
    toolCount: businessTools.length,
    toolLayers: {
      management: managementToolSchemas(ctx.config).length,
      business: businessTools.length,
      ...(consoleView ? { hiddenBlacklisted: snapshot.tools.length - hidden.length } : {}),
    },
    protocols: snapshot.protocols,
    adapters: agentAdapters,
    hints,
    policy: { allowWriteDefault: false, cidrScanDefault: false },
    security: { mode: ctx.security.mode() },
    invokeAudit: ctx.auditLog?.snapshot(0).counts ?? invokeAudit(),
    transport: {
      kind: ctx.config.transport.kind,
      host: ctx.config.transport.host,
      port: ctx.config.transport.port,
    },
  };
}

async function explain(ctx: ManagementContext, args: Record<string, unknown>) {
  const name = requiredString(args, "name");
  if (MANAGEMENT_TOOL_NAMES.has(name)) {
    const schema = managementToolSchemas(ctx.config).find((t) => t.name === name);
    return {
      name,
      kind: "management",
      layer: "management",
      schema,
      how: "Call via MCP tools/call. Management tools inspect or mutate the catalog/discovery layer — not a backend protocol.",
      next: name.startsWith("mcp_plan")
        ? ["discovery_scan_host", "schema_import"]
        : ["mcp_list", "mcp_health"],
    };
  }
  const found = ctx.registry.lookupTool(name);
  if (!found) {
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown tool: ${name}`, {
      details: {
        tool: name,
        hint: "Business tools are protocol.name.operation. Management tools: mcp_list / mcp_plan_bridge / discovery_scan_host / schema_import. Call mcp_list { layer: \"all\" } to see both layers.",
      },
    });
  }
  const rec = ctx.registry.getRecord(found.adapterId);
  if (rec && !wantsConsoleView(ctx, "console")) {
    await assertNotBlacklisted(ctx.blacklist, rec.protocol, rec.config);
  }
  return {
    ...found,
    kind: "adapter",
    layer: "business",
    how: `tools/call ${name} with arguments matching inputSchema. Backed by ${found.protocol} adapter ${found.adapterId}.`,
    next: ["mcp_health", "mcp_explain_tool"],
  };
}

async function addFromDiscovery(ctx: ManagementContext, args: Record<string, unknown>) {
  const suggestion = (args.suggestion && typeof args.suggestion === "object" ? args.suggestion : args) as Record<
    string,
    unknown
  >;
  if (typeof suggestion.pick === "number") {
    throw new AdapterError(
      "E_INVALID_ARGUMENT",
      "mcp_add_from_discovery expects the suggestion object (protocol, name, config), not an index. Pass discovery_scan_host.suggestions[0] as { suggestion: ... }.",
      { details: { next: "discovery_scan_host" } },
    );
  }
  try {
    const protocol = requiredString(suggestion, "protocol");
    const name = requiredString(suggestion, "name");
    const config = requiredObject(suggestion, "config");
    const result = await add(ctx, { protocol, name, config });
    return {
      ...result,
      confidence: typeof suggestion.confidence === "number" ? suggestion.confidence : undefined,
      fromDiscovery: true,
    };
  } catch (err) {
    if (err instanceof AdapterError && (err.code === "E_INVALID_CONFIG" || err.code === "E_INVALID_ARGUMENT")) {
      const protocol = typeof suggestion.protocol === "string" ? canonicalProtocol(suggestion.protocol) : undefined;
      const help = protocol ? PROTOCOL_CONFIG_HELP[protocol] : undefined;
      throw new AdapterError(err.code, `${err.message} Hint: pass discovery_scan_host.suggestions[0] (the object, not pick:0).${help ? ` Expected ${help}.` : ""}`, {
        protocol,
        details: { ...(err.details ?? {}), next: ["discovery_scan_host", "mcp_plan_bridge"] },
      });
    }
    throw err;
  }
}

async function schemaImport(ctx: ManagementContext, args: Record<string, unknown>) {
  const source = requiredString(args, "source");
  const kind = typeof args.kind === "string" ? args.kind : undefined;
  const imported = await importSchema(source, kind);
  const extra = args.config && typeof args.config === "object" && !Array.isArray(args.config)
    ? (args.config as JsonObject)
    : {};
  const config: JsonObject = { ...imported.config, ...extra };
  if (typeof args.target === "string" && args.target.trim()) config.target = args.target.trim();
  if (typeof args.url === "string" && args.url.trim()) config.url = args.url.trim();
  const name = typeof args.name === "string" && args.name.trim() ? args.name.trim() : imported.name;
  const register = args.register !== false && (imported.registerable || Boolean(config.target) || Boolean(config.url && imported.kind === "graphql"));
  await ctx.security.assert({
    hook: "import",
    actor: actorOf(ctx),
    target: {
      protocol: imported.protocol,
      url: typeof config.url === "string" ? config.url : source,
      host: typeof config.host === "string" ? config.host : undefined,
      config,
    },
    config,
  });
  if (!register) {
    return { ok: true, registered: false, imported: { ...imported, name, config } };
  }
  const result = await add(ctx, { protocol: imported.protocol, name, config });
  return { registered: true, kind: imported.kind, ...result };
}

async function suggest(ctx: ManagementContext, args: Record<string, unknown>) {
  let candidates: unknown[] = Array.isArray(args.candidates) ? args.candidates : [];
  if (candidates.length === 0 && typeof args.host === "string") {
    const scanned = (await scan(ctx, args)) as {
      suggestions: SuggestedRegistration[];
      candidates: unknown[];
      blocked?: unknown[];
      hiddenBlacklisted?: number;
    };
    return {
      suggestions: scanned.suggestions,
      candidates: scanned.candidates,
      blocked: scanned.blocked ?? [],
      hiddenBlacklisted: scanned.hiddenBlacklisted ?? 0,
      note: "Pass a suggestion to mcp_add_from_discovery, or call mcp_add with protocol/name/config. Blacklisted targets are omitted from suggestions.",
    };
  }
  const typed = candidates.filter(isCandidate);
  const decorated = await decorateCandidates(ctx, typed);
  return {
    ...decorated,
    note: "Pass a suggestion to mcp_add_from_discovery, or call mcp_add with protocol/name/config. Blacklisted targets are omitted from suggestions.",
  };
}

async function probe(ctx: ManagementContext, args: Record<string, unknown>) {
  requireDiscovery(ctx);
  const host = requiredString(args, "host");
  await ctx.security.assert({
    hook: "discover",
    actor: actorOf(ctx),
    target: { host },
  });
  await assertProbeTarget(host, false);
  const https = Boolean(args.https);
  const port = typeof args.port === "number" ? args.port : https ? 443 : 80;
  const protocols = Array.isArray(args.protocols)
    ? args.protocols.filter((p): p is string => typeof p === "string")
    : undefined;
  const candidates = await probeHost({
    host,
    port,
    https,
    protocols,
    timeoutMs: ctx.config.discovery.timeoutMs,
  });
  const decorated = await decorateCandidates(ctx, candidates);
  return {
    host,
    port,
    https,
    ...decorated,
    note: "Use discovery_suggest or mcp_add_from_discovery to register. Blacklisted targets are marked and omitted from suggestions.",
  };
}

async function scan(ctx: ManagementContext, args: Record<string, unknown>) {
  requireDiscovery(ctx);
  const host = requiredString(args, "host");
  await ctx.security.assert({
    hook: "discover",
    actor: actorOf(ctx),
    target: { host },
  });
  await assertProbeTarget(host, false);
  const protocols = Array.isArray(args.protocols)
    ? args.protocols.filter((p): p is string => typeof p === "string")
    : undefined;
  const candidates = await scanHost({
    host,
    port: typeof args.port === "number" ? args.port : undefined,
    https: typeof args.https === "boolean" ? args.https : undefined,
    protocols,
    timeoutMs: ctx.config.discovery.timeoutMs,
    onlyGivenPort: Boolean(args.onlyGivenPort),
  });
  const decorated = await decorateCandidates(ctx, candidates);
  return {
    host,
    ...decorated,
    note: "Single-host only. Metadata IPs are blocked. Blacklisted targets are marked and omitted from one-click suggestions.",
  };
}

async function decorateCandidates(ctx: ManagementContext, candidates: import("../runtime/types.js").DiscoveryCandidate[]) {
  const annotated = [];
  for (const c of candidates) {
    const hit = await ctx.blacklist.matchCandidate(c);
    annotated.push({
      ...c,
      blacklisted: Boolean(hit),
      blacklistId: hit?.id,
    });
  }
  const visible = annotated.filter((c) => !c.blacklisted);
  const blocked = annotated.filter((c) => c.blacklisted);
  return {
    candidates: annotated,
    suggestions: suggestFromCandidates(visible),
    blocked,
    hiddenBlacklisted: blocked.length,
  };
}

async function blacklistList(ctx: ManagementContext) {
  const entries = await ctx.blacklist.list();
  return {
    ok: true,
    entries,
    match: "canonical protocol + normalized host + port (or protocol + normalized url)",
    note: "Blocks mcp_add / discovery register / invoke. Does not uninstall already-mounted adapters; invoke still fails.",
  };
}

async function blacklistAdd(ctx: ManagementContext, args: Record<string, unknown>) {
  const entry = await ctx.blacklist.add(args);
  return { ok: true, entry };
}

async function blacklistRemove(ctx: ManagementContext, args: Record<string, unknown>) {
  const id = requiredString(args, "id");
  const removed = await ctx.blacklist.remove(id);
  if (!removed) throw new AdapterError("E_NOT_FOUND", `Unknown blacklist id: ${id}`, { details: { id } });
  return { ok: true, id };
}

function parseLayer(value: unknown): "business" | "management" | "all" {
  if (value === "management" || value === "all" || value === "business") return value;
  return "business";
}

function enrichPlan(plan: BridgePlan): BridgePlan & {
  hints: string[];
  policy: { allowWriteDefault: false; cidrScanDefault: false };
} {
  const hints: string[] = [];
  for (const rec of plan.recommendations) {
    try {
      validateProtocolConfig(rec.protocol, rec.exampleConfig as JsonObject);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      hints.push(`${rec.protocol} example config is incomplete: ${msg}`);
    }
  }
  if (!plan.host) {
    hints.push(
      "No host in the goal. discovery_scan_host needs a single hostname/IP. Otherwise schema_import a local spec, or mcp_add with a complete config.",
    );
  }
  if (plan.recommendations.some((r) => r.exampleConfig && "allowWrite" in r.exampleConfig && r.exampleConfig.allowWrite !== true)) {
    hints.push("Writes stay blocked until you re-register with allowWrite=true.");
  }
  return {
    ...plan,
    hints,
    policy: { allowWriteDefault: false, cidrScanDefault: false },
  };
}

function requireDiscovery(ctx: ManagementContext): void {
  if (!ctx.config.discovery.enabled) {
    throw new AdapterError("E_UNSUPPORTED", "Discovery is disabled (set EVERYTHING2MCP_DISCOVERY_ENABLED=true)");
  }
}

function isCandidate(value: unknown): value is import("../runtime/types.js").DiscoveryCandidate {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return typeof c.protocol === "string" && typeof c.url === "string";
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new AdapterError("E_INVALID_ARGUMENT", `Missing required string argument "${key}"`, {
      details: { key },
    });
  }
  return v.trim();
}

function requiredObject(args: Record<string, unknown>, key: string): JsonObject {
  const v = args[key];
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new AdapterError("E_INVALID_ARGUMENT", `Missing required object argument "${key}"`, {
      details: { key },
    });
  }
  return v as JsonObject;
}
