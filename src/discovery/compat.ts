import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { JsonObject, IngressKind } from "../runtime/types.js";
import type { EnvironmentInventory } from "./environment.js";
import { COMPAT_CATALOG, MCP_SERVERS_CONFIG_HINTS, type CompatApp, type CompatPriority } from "./compat-catalog.js";

export interface CompatSuggestion {
  protocol: string;
  name: string;
  config: JsonObject;
  confidence: number;
  reason: string;
  source: "compat";
  ingress: IngressKind;
  priority: CompatPriority;
  appId?: string;
  gaps?: string[];
  fallback?: boolean;
}

export interface CompatScanResult {
  ok: true;
  suggestions: CompatSuggestion[];
  catalog: Array<Pick<CompatApp, "appId" | "displayName" | "ingress" | "adapterProtocol" | "risk" | "gaps">>;
  partner: { drops: string[]; registrations: string[] };
  mcpBridgeCandidates: Array<{ kind: string; path: string; servers: string[] }>;
  deferred: Array<{ priority: "P4"; status: "deferred"; reason: string }>;
  policy: {
    allowWriteDefault: false;
    neverAutoOpenWrite: true;
    neverAutoOpenDesktop: true;
    scanDoesNotGrant: ["allowWrite", "allowShell", "allowDesktop", "allowReadSecrets"];
    southboundPriority: IngressKind[];
  };
  note: string;
}

export interface CompatScanInput {
  inventory?: EnvironmentInventory;
  installed?: string[];
  env?: NodeJS.ProcessEnv;
  home?: string;
  fsExists?: (path: string) => boolean;
  fsRead?: (path: string) => string | undefined;
  dropsDir?: string;
  partnerIds?: string[];
  ports?: number[];
}

function locked(config: JsonObject): JsonObject {
  return { ...config, allowWrite: false, allowShell: false, allowDesktop: false, allowReadSecrets: false };
}

/**
 * P0 Compat∩installed + Partner drops/registrations
 * P1 config/login clues
 * P2 ports/process
 * P3 mcpServers as bridge candidates only
 * P4 desktop UI = documented deferred/gated
 */
export function scanCompat(input: CompatScanInput = {}): CompatScanResult {
  const env = input.env ?? process.env;
  const home = input.home ?? homedir();
  const exists = input.fsExists ?? ((p: string) => {
    try {
      return existsSync(p);
    } catch {
      return false;
    }
  });
  const read = input.fsRead ?? ((p: string) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return undefined;
    }
  });
  const installed = new Set(
    (input.installed ?? input.inventory?.runtimes.filter((r) => r.present).map((r) => r.id) ?? []).map((s) =>
      s.toLowerCase(),
    ),
  );
  const ports = new Set(input.ports ?? input.inventory?.listeningPorts.map((p) => p.port) ?? []);
  const suggestions: CompatSuggestion[] = [];
  const seen = new Set<string>();

  const push = (s: CompatSuggestion) => {
    const key = `${s.protocol}:${s.name}:${s.priority}`;
    if (seen.has(key)) return;
    seen.add(key);
    suggestions.push({ ...s, config: locked(s.config) });
  };

  for (const app of COMPAT_CATALOG) {
    if (app.appId === "personal_wechat") continue;
    const bins = (app.detect.binaries ?? []).map((b) => b.toLowerCase());
    const hitBin = bins.some((b) => installed.has(b) || env.PATH?.toLowerCase().includes(b));
    const hitEnv = (app.detect.env ?? []).some((k) => Boolean(env[k]));
    const hitPort = (app.detect.ports ?? []).some((p) => ports.has(p));
    if (hitBin) {
      push({
        protocol: app.adapterProtocol,
        name: "local",
        config: { simulator: true, ingress: "native" },
        confidence: 0.8,
        reason: `P0 Compat∩installed: ${app.displayName} binary/runtime clue`,
        source: "compat",
        ingress: "native",
        priority: "P0",
        appId: app.appId,
        gaps: app.gaps,
      });
    } else if (hitEnv) {
      push({
        protocol: app.adapterProtocol,
        name: "local",
        config: { simulator: true, ingress: "native" },
        confidence: 0.65,
        reason: `P1 config/login clue (${app.detect.env?.join(", ")}) — tokens are not copied`,
        source: "compat",
        ingress: "native",
        priority: "P1",
        appId: app.appId,
        gaps: app.gaps,
      });
    } else if (hitPort) {
      push({
        protocol: app.adapterProtocol,
        name: "local",
        config: { simulator: true, ingress: "native" },
        confidence: 0.4,
        reason: `P2 listening port matched Compat catalog for ${app.displayName}`,
        source: "compat",
        ingress: "native",
        priority: "P2",
        appId: app.appId,
        gaps: app.gaps,
      });
    }
  }

  const dropsDir = input.dropsDir;
  const dropFiles: string[] = [];
  if (dropsDir && exists(dropsDir)) {
    try {
      for (const ent of readdirSync(dropsDir)) {
        if (!ent.endsWith(".json")) continue;
        dropFiles.push(join(dropsDir, ent));
        push({
          protocol: "partner",
          name: ent.replace(/\.json$/i, "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "drop",
          config: { ingress: "partner", drop: join(dropsDir, ent) },
          confidence: 0.9,
          reason: `P0 Partner drop file ${ent}`,
          source: "compat",
          ingress: "partner",
          priority: "P0",
        });
      }
    } catch {
      /* ignore unreadable drops */
    }
  }

  for (const id of input.partnerIds ?? []) {
    push({
      protocol: "partner",
      name: id.includes(":") ? id.split(":")[1] ?? id : id,
      config: { ingress: "partner" },
      confidence: 1,
      reason: `P0 live Partner registration ${id}`,
      source: "compat",
      ingress: "partner",
      priority: "P0",
    });
  }

  const mcpBridgeCandidates: CompatScanResult["mcpBridgeCandidates"] = [];
  for (const hint of MCP_SERVERS_CONFIG_HINTS) {
    const path = join(home, hint.rel);
    const raw = exists(path) ? read(path) : undefined;
    if (!raw) continue;
    let servers: string[] = [];
    try {
      const json = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
      servers = Object.keys(json.mcpServers ?? json);
    } catch {
      servers = [];
    }
    mcpBridgeCandidates.push({ kind: hint.kind, path, servers });
    push({
      protocol: "mcp_bridge",
      name: hint.kind,
      config: { path, ingress: "mcp_bridge", simulator: true },
      confidence: 0.35,
      reason: `P3 mcpServers file (${hint.kind}) — last-resort 兜底, not the primary southbound`,
      source: "compat",
      ingress: "mcp_bridge",
      priority: "P3",
      fallback: true,
      gaps: ["Do not require vendors to speak MCP for new integrations"],
    });
  }

  suggestions.sort((a, b) => a.priority.localeCompare(b.priority) || b.confidence - a.confidence);

  return {
    ok: true,
    suggestions,
    catalog: COMPAT_CATALOG.map(({ appId, displayName, ingress, adapterProtocol, risk, gaps }) => ({
      appId,
      displayName,
      ingress,
      adapterProtocol,
      risk,
      gaps,
    })),
    partner: { drops: dropFiles, registrations: input.partnerIds ?? [] },
    mcpBridgeCandidates,
    deferred: [
      {
        priority: "P4",
        status: "deferred",
        reason:
          "Desktop UI automation (window scrape / accessibility) is gated by allowDesktop and is not used for Compat detect. Personal WeChat private-chat compatibility is not claimed.",
      },
    ],
    policy: {
      allowWriteDefault: false,
      neverAutoOpenWrite: true,
      neverAutoOpenDesktop: true,
      scanDoesNotGrant: ["allowWrite", "allowShell", "allowDesktop", "allowReadSecrets"],
      southboundPriority: ["partner", "native", "mcp_bridge"],
    },
    note: "Scan success ≠ write/desktop/secrets. One-click path is capability_register on a suggestion (same Lifecycle). MCP bridge is marked 兜底.",
  };
}

export function defaultDropsDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.EVERYTHING2MCP_DROPS_DIR?.trim()) return env.EVERYTHING2MCP_DROPS_DIR.trim();
  if (platform === "win32") {
    const root = env.LOCALAPPDATA?.trim() || env.APPDATA?.trim() || join(homedir(), "AppData", "Local");
    return join(root, "everything2mcp", "drops");
  }
  return join(env.HOME?.trim() || homedir(), ".everything2mcp", "drops");
}

