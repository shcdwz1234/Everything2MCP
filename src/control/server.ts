import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadAppConfig } from "../catalog/config.js";
import { BlacklistStore } from "../catalog/blacklist.js";
import { ToolRegistry } from "../catalog/registry.js";
import { JsonStore } from "../catalog/store.js";
import { AuditLog, registerAuditLog, unregisterAuditLog } from "../runtime/audit-log.js";
import { registerBuiltinAdapters } from "../runtime/bootstrap.js";
import { errorPayload } from "../runtime/errors.js";
import { log } from "../runtime/log.js";
import { APP_NAME, APP_VERSION, type AppConfig, type AppConfigOverrides } from "../runtime/types.js";
import { callManagementTool, MANAGEMENT_TOOL_NAMES, managementToolSchemas } from "./tools.js";
import { SecurityPlane } from "./security/index.js";
import { defaultActor } from "./security/types.js";
import { pickupDrops } from "./partner.js";
import { defaultDropsDir } from "../discovery/compat.js";
import { join } from "node:path";

const SERVER_INSTRUCTIONS =
  "Everything2MCP is a protocol→MCP bridge. Agent-facing northbound is MCP only. Southbound priority: (1) E2MCP Partner protocol (apps do not speak MCP) (2) native OpenAPI adapters (3) mcp_bridge 兜底. Deploy is a minimal MCP core — capabilities are hot-added, not bulk-registered at boot. Prefer environment_inventory / compat_scan / partner_list → capability_register. Writes default allowWrite=false. Never scan CIDR. Scan never opens write/desktop/secrets.";

export interface Everything2Mcp {
  server: Server;
  registry: ToolRegistry;
  config: AppConfig;
  blacklist: BlacklistStore;
  security: SecurityPlane;
  auditLog: AuditLog;
  /** Extra MCP Server sharing the same registry (HTTP/SSE sessions). */
  createSessionServer: () => Server;
  releaseSessionServer: (server: Server) => Promise<void>;
  close: () => Promise<void>;
}

export async function createEverything2McpServer(
  overrides: AppConfigOverrides = {},
): Promise<Everything2Mcp> {
  registerBuiltinAdapters();
  const loaded = loadAppConfig();
  const config: AppConfig = {
    dataDir: overrides.dataDir ?? loaded.dataDir,
    discovery: { ...loaded.discovery, ...overrides.discovery, allowScan: false },
    transport: { ...loaded.transport, ...overrides.transport },
    rateLimit: { ...loaded.rateLimit, ...overrides.rateLimit },
  };

  const store = new JsonStore(config.dataDir);
  const blacklist = new BlacklistStore(config.dataDir);
  const registry = new ToolRegistry(store, blacklist);
  const auditLog = new AuditLog(config.dataDir);
  await auditLog.restore();
  registerAuditLog(auditLog);
  const security = new SecurityPlane(config.dataDir, {
    blacklist,
    registrations: store,
    tokenConfigured: () => Boolean(config.transport.token),
    lookupAdapter: (id) => {
      const rec = registry.getRecord(id);
      return rec ? { protocol: rec.protocol, config: rec.config } : undefined;
    },
    rateLimit: config.rateLimit,
  });
  await registry.restore();
  await security.restore();

  const mgmt = { registry, config, blacklist, security, auditLog };
  for (const dir of dropsDirsFor(config.dataDir)) {
    try {
      const picked = await pickupDrops(mgmt, dir);
      if (picked.picked.length || picked.errors.length) {
        log("partner drops pickup", picked);
      }
    } catch (err) {
      log("partner drops pickup failed", { dir, error: String(err) });
    }
  }

  const liveServers = new Set<Server>();
  const closingServers = new WeakSet<Server>();

  const notifyListChanged = (server: Server): void => {
    void server.sendToolListChanged().catch((err) => {
      log("tools/list_changed failed", { error: String(err) });
    });
  };

  registry.onChange(() => {
    for (const s of liveServers) notifyListChanged(s);
  });

  security.onChange(() => {
    for (const s of liveServers) notifyListChanged(s);
  });

  const primary = wireMcpServer(registry, config, blacklist, security, auditLog);
  liveServers.add(primary);

  return {
    server: primary,
    registry,
    config,
    blacklist,
    security,
    auditLog,
    createSessionServer: () => {
      const session = wireMcpServer(registry, config, blacklist, security, auditLog);
      liveServers.add(session);
      return session;
    },
    releaseSessionServer: async (server: Server) => {
      liveServers.delete(server);
      if (closingServers.has(server)) return;
      closingServers.add(server);
      try {
        await server.close();
      } catch {
        /* already closed */
      }
    },
    close: async () => {
      unregisterAuditLog(config.dataDir);
      await auditLog.flush();
      await registry.shutdown();
      await Promise.all(
        [...liveServers].map(async (s) => {
          if (closingServers.has(s)) return;
          closingServers.add(s);
          try {
            await s.close();
          } catch {
            /* ignore */
          }
        }),
      );
      liveServers.clear();
    },
  };
}

/** Bind ListTools / CallTool onto a new SDK Server that shares the catalog. */
export function wireMcpServer(
  registry: ToolRegistry,
  config: AppConfig,
  blacklist: BlacklistStore,
  security: SecurityPlane,
  auditLog?: AuditLog,
): Server {
  const server = new Server(
    { name: APP_NAME, version: APP_VERSION },
    {
      capabilities: { tools: { listChanged: true } },
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  const management = managementToolSchemas(config);

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const business = registry.list().tools;
    const visible = await security.hideAgentTools(business);
    const names = new Set(visible.map((t) => t.name));
    return {
      tools: [...management, ...registry.adapterTools().filter((t) => names.has(t.name))],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const result = MANAGEMENT_TOOL_NAMES.has(name)
        ? await callManagementTool(name, args, {
            registry,
            config,
            blacklist,
            security,
            auditLog,
            actor: defaultActor("mcp-stdio"),
          })
        : await (async () => {
            const found = registry.lookupTool(name);
            const rec = found ? registry.getRecord(found.adapterId) : undefined;
            await security.assert({
              hook: "invoke",
              actor: defaultActor("mcp-stdio"),
              tool: found
                ? { name, layer: "business", adapterId: found.adapterId, protocol: found.protocol }
                : { name, layer: "business" },
              target: rec
                ? { protocol: rec.protocol, adapterId: rec.id, config: rec.config }
                : undefined,
            });
            return registry.invoke(name, args);
          })();
      return {
        content: [{ type: "text" as const, text: stringify(result) }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: stringify(errorPayload(err)) }],
      };
    }
  });

  return server;
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function dropsDirsFor(dataDir: string): string[] {
  const dirs = [join(dataDir, "drops")];
  if (process.env.EVERYTHING2MCP_DROPS_DIR?.trim()) dirs.push(process.env.EVERYTHING2MCP_DROPS_DIR.trim());
  else if (!process.env.NODE_TEST_CONTEXT && process.env.EVERYTHING2MCP_DROPS_HOME !== "0") {
    dirs.push(defaultDropsDir());
  }
  return [...new Set(dirs)];
}
