import { lookup } from "node:dns/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { networkInterfaces as osNetworkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { blacklistId, targetFromCandidate, targetFromConfig } from "../catalog/blacklist.js";
import { missingRequiredFields } from "../catalog/config-schema.js";
import { canonicalProtocol } from "../catalog/validate.js";
import { scanHost as defaultScanHost, type ScanOptions } from "../discovery/scan.js";
import { suggestFromCandidates, sanitizeName } from "../discovery/suggest.js";
import {
  expandCidr,
  isExcluded,
  isNeverScan,
  isPrivateIp,
  NEVER_SCAN_DOC,
  parseCidr,
  parseScopeEntry,
  PRIVATE_RANGES_DOC,
  subnetsFromInterfaces,
  type InterfaceAddr,
} from "../discovery/netscope.js";
import { mdnsMulticastQuery, ssdpMulticastSearch, type MulticastHit } from "../discovery/multicast.js";
import { AdapterError, errorPayload } from "../runtime/errors.js";
import { log } from "../runtime/log.js";
import { recordSecurityEvent } from "../runtime/metrics.js";
import type { DiscoveryCandidate, JsonObject } from "../runtime/types.js";
import { callManagementTool, type ManagementContext } from "./tools.js";

/**
 * S4 auto-discovery. Modes:
 *   auto   — default. Sweeps local private subnets (≤ /24 per interface),
 *            localhost, mDNS/SSDP responders and manual scopes on a timer.
 *   manual — only "立即扫描" / POST /api/discovery/run; same scope rules.
 *   off    — nothing runs; run() is refused.
 * Every host goes through scanHost() one at a time (single-host API, SSRF +
 * metadata deny unchanged). Candidates are never registered automatically
 * unless settings.autoEnable is on, and then only through capability_register
 * auto:true (Safe + readonly + non-blacklist). allowWrite is always false.
 */
export type DiscoveryMode = "auto" | "manual" | "off";

export interface DiscoverySettings {
  mode: DiscoveryMode;
  intervalMinutes: number;
  includeInterfaces: boolean;
  includeLocalhost: boolean;
  multicast: boolean;
  scopes: string[];
  exclude: string[];
  allowPublic: boolean;
  autoEnable: boolean;
  hostCap: number;
  concurrency: number;
  timeoutMs: number;
  protocols: string[];
}

export type CandidateStatus = "new" | "enabled" | "dismissed" | "blacklisted";

export interface AutoCandidate {
  id: string;
  protocol: string;
  host: string;
  url: string;
  title?: string;
  hint?: string;
  detail?: string;
  confidence: number;
  suggestedName: string;
  config: JsonObject;
  source: "localhost" | "interface" | "manual" | "mdns" | "ssdp";
  firstSeen: string;
  lastSeen: string;
  online: boolean;
  missCount: number;
  status: CandidateStatus;
  registeredId?: string;
  blacklistId?: string;
  /** true → UI shows 需要配置 and prompts only for `missing` / `credentials`. */
  needsConfig: boolean;
  missing: string[];
  credentials: CredentialField[];
}

export interface CredentialField {
  key: string;
  label: string;
  secret: boolean;
  /** where the value goes when enabling */
  into: "config" | "url-user" | "url-password";
}

export interface DiscoveryRun {
  id: string;
  trigger: "auto" | "manual" | "startup";
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  hostsPlanned: number;
  hostsScanned: number;
  truncated: boolean;
  found: number;
  newCount: number;
  offlineCount: number;
  autoEnabled: string[];
  errors: string[];
  ok: boolean;
}

interface DiscoveryFile {
  version: 1;
  settings?: Partial<DiscoverySettings>;
  candidates: AutoCandidate[];
  runs: DiscoveryRun[];
}

export const DEFAULT_AUTO_PROTOCOLS = [
  "openapi",
  "graphql",
  "grpc",
  "redis",
  "mqtt",
  "nats",
  "postgres",
  "mysql",
  "sqlserver",
  "mongodb",
  "elasticsearch",
  "clickhouse",
  "qdrant",
  "s3",
  "prometheus",
  "kafka",
  "amqp",
  "opcua",
  "modbus",
  "consul",
  "etcd",
  "couchdb",
  "influx",
  "rabbitmq",
];

const MAX_RUNS = 50;
const MAX_CANDIDATES = 500;
/** Offline candidates that stay unseen for this many runs are pruned (unless enabled). */
const PRUNE_AFTER_MISSES = 10;

/** Protocols whose servers almost always require credentials → 需要配置 by default. */
const AUTH_TYPICAL = new Set(["postgres", "mysql", "sqlserver", "s3", "amqp"]);

const CREDENTIALS: Record<string, CredentialField[]> = {
  postgres: [
    { key: "username", label: "用户名", secret: false, into: "url-user" },
    { key: "password", label: "密码", secret: true, into: "url-password" },
  ],
  mysql: [
    { key: "username", label: "用户名", secret: false, into: "url-user" },
    { key: "password", label: "密码", secret: true, into: "url-password" },
  ],
  sqlserver: [
    { key: "username", label: "用户名", secret: false, into: "url-user" },
    { key: "password", label: "密码", secret: true, into: "url-password" },
  ],
  mongodb: [
    { key: "username", label: "用户名 (可选)", secret: false, into: "url-user" },
    { key: "password", label: "密码 (可选)", secret: true, into: "url-password" },
  ],
  amqp: [
    { key: "username", label: "用户名", secret: false, into: "url-user" },
    { key: "password", label: "密码", secret: true, into: "url-password" },
  ],
  redis: [{ key: "password", label: "密码 (可选)", secret: true, into: "url-password" }],
  mqtt: [
    { key: "username", label: "用户名 (可选)", secret: false, into: "config" },
    { key: "password", label: "密码 (可选)", secret: true, into: "config" },
  ],
  s3: [
    { key: "accessKey", label: "Access Key", secret: false, into: "config" },
    { key: "secretKey", label: "Secret Key", secret: true, into: "config" },
  ],
};

export function defaultDiscoveryMode(env: NodeJS.ProcessEnv = process.env, discoveryEnabled = true): DiscoveryMode {
  const raw = env.EVERYTHING2MCP_DISCOVERY_MODE?.trim().toLowerCase();
  if (!discoveryEnabled) return "off";
  if (raw === "auto" || raw === "manual" || raw === "off") return raw;
  // Test runners must not sweep the network unless a test opts in explicitly.
  if (env.NODE_TEST_CONTEXT) return "off";
  return "auto";
}

export function defaultSettings(env: NodeJS.ProcessEnv = process.env, discoveryEnabled = true): DiscoverySettings {
  const interval = Number(env.EVERYTHING2MCP_DISCOVERY_INTERVAL_MIN ?? 30);
  return normalizeSettings({
    mode: defaultDiscoveryMode(env, discoveryEnabled),
    intervalMinutes: Number.isFinite(interval) ? interval : 30,
    includeInterfaces: true,
    includeLocalhost: true,
    multicast: true,
    scopes: splitList(env.EVERYTHING2MCP_DISCOVERY_SCOPES),
    exclude: splitList(env.EVERYTHING2MCP_DISCOVERY_EXCLUDE),
    allowPublic: false,
    autoEnable: false,
    hostCap: 256,
    concurrency: 16,
    timeoutMs: 800,
    protocols: [...DEFAULT_AUTO_PROTOCOLS],
  });
}

function splitList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function clamp(n: unknown, lo: number, hi: number, fallback: number): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

export function normalizeSettings(input: Partial<DiscoverySettings>, base?: DiscoverySettings): DiscoverySettings {
  const b = base ?? {
    mode: "manual" as DiscoveryMode,
    intervalMinutes: 30,
    includeInterfaces: true,
    includeLocalhost: true,
    multicast: true,
    scopes: [],
    exclude: [],
    allowPublic: false,
    autoEnable: false,
    hostCap: 256,
    concurrency: 16,
    timeoutMs: 800,
    protocols: [...DEFAULT_AUTO_PROTOCOLS],
  };
  const mode = input.mode === "auto" || input.mode === "manual" || input.mode === "off" ? input.mode : b.mode;
  const allowPublic = typeof input.allowPublic === "boolean" ? input.allowPublic : b.allowPublic;
  const scopesIn = Array.isArray(input.scopes) ? input.scopes.map(String) : b.scopes;
  const scopes: string[] = [];
  for (const s of scopesIn) {
    if (!s.trim()) continue;
    scopes.push(parseScopeEntry(s, allowPublic).raw); // throws on invalid / public without opt-in
  }
  const exclude = (Array.isArray(input.exclude) ? input.exclude.map(String) : b.exclude).map((s) => s.trim()).filter(Boolean);
  const protocols = (Array.isArray(input.protocols) ? input.protocols.map(String) : b.protocols)
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  return {
    mode,
    intervalMinutes: clamp(input.intervalMinutes ?? b.intervalMinutes, 5, 24 * 60, 30),
    includeInterfaces: typeof input.includeInterfaces === "boolean" ? input.includeInterfaces : b.includeInterfaces,
    includeLocalhost: typeof input.includeLocalhost === "boolean" ? input.includeLocalhost : b.includeLocalhost,
    multicast: typeof input.multicast === "boolean" ? input.multicast : b.multicast,
    scopes: [...new Set(scopes)],
    exclude: [...new Set(exclude)],
    allowPublic,
    autoEnable: typeof input.autoEnable === "boolean" ? input.autoEnable : b.autoEnable,
    hostCap: clamp(input.hostCap ?? b.hostCap, 1, 1024, 256),
    concurrency: clamp(input.concurrency ?? b.concurrency, 1, 64, 16),
    timeoutMs: clamp(input.timeoutMs ?? b.timeoutMs, 100, 10_000, 800),
    protocols: protocols.length ? [...new Set(protocols)] : [...DEFAULT_AUTO_PROTOCOLS],
  };
}

export interface AutoDiscoveryDeps {
  ctx: ManagementContext;
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  discoveryEnabled?: boolean;
  scanHost?: (opts: ScanOptions) => Promise<DiscoveryCandidate[]>;
  networkInterfaces?: () => Record<string, InterfaceAddr[] | undefined>;
  mdnsBrowse?: (timeoutMs: number) => Promise<MulticastHit[]>;
  ssdpBrowse?: (timeoutMs: number) => Promise<MulticastHit[]>;
  resolve?: (host: string) => Promise<string[]>;
  now?: () => Date;
  /** ms before the first auto run after start() (default 5000). */
  startupDelayMs?: number;
  /** Explicit mode (config override); wins over discovery.json. */
  mode?: DiscoveryMode;
}

interface PlannedHost {
  host: string;
  source: AutoCandidate["source"];
}

export class AutoDiscovery {
  readonly filePath: string;
  private settings: DiscoverySettings;
  private candidates: AutoCandidate[] = [];
  private runs: DiscoveryRun[] = [];
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<DiscoveryRun> | undefined;
  private nextRunAt: string | undefined;
  private stopped = false;
  private loaded = false;
  private readonly deps: Required<Omit<AutoDiscoveryDeps, "env" | "discoveryEnabled" | "mode">> & { env: NodeJS.ProcessEnv };

  constructor(deps: AutoDiscoveryDeps) {
    this.filePath = join(deps.dataDir, "discovery.json");
    const env = deps.env ?? process.env;
    this.settings = defaultSettings(env, deps.discoveryEnabled ?? true);
    this.deps = {
      ctx: deps.ctx,
      dataDir: deps.dataDir,
      env,
      scanHost: deps.scanHost ?? defaultScanHost,
      networkInterfaces: deps.networkInterfaces ?? (() => osNetworkInterfaces() as Record<string, InterfaceAddr[] | undefined>),
      mdnsBrowse: deps.mdnsBrowse ?? mdnsMulticastQuery,
      ssdpBrowse: deps.ssdpBrowse ?? ssdpMulticastSearch,
      resolve: deps.resolve ?? (async (h) => (await lookup(h, { all: true })).map((r) => r.address)),
      now: deps.now ?? (() => new Date()),
      startupDelayMs: deps.startupDelayMs ?? 5000,
    };
    if (deps.discoveryEnabled === false) this.forcedOff = true;
    this.explicitMode = deps.mode ?? parseMode(env.EVERYTHING2MCP_DISCOVERY_MODE);
  }

  private explicitMode: DiscoveryMode | undefined;

  private forcedOff = false;

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8")) as DiscoveryFile;
      if (raw && raw.version === 1) {
        if (raw.settings) {
          try {
            this.settings = normalizeSettings(raw.settings, this.settings);
          } catch (err) {
            log("discovery.json settings ignored", { error: String(err) });
          }
        }
        this.candidates = Array.isArray(raw.candidates) ? raw.candidates : [];
        this.runs = Array.isArray(raw.runs) ? raw.runs : [];
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") log("discovery.json unreadable", { error: String(err) });
    }
    if (this.explicitMode) this.settings = { ...this.settings, mode: this.explicitMode };
    if (this.forcedOff) this.settings = { ...this.settings, mode: "off" };
  }

  private async persist(persistSettings = false): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    let settings: Partial<DiscoverySettings> | undefined;
    if (persistSettings) settings = this.settings;
    else {
      try {
        const prev = JSON.parse(await readFile(this.filePath, "utf8")) as DiscoveryFile;
        settings = prev.settings;
      } catch {
        settings = undefined;
      }
    }
    const body: DiscoveryFile = { version: 1, settings, candidates: this.candidates, runs: this.runs };
    await writeFile(this.filePath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  }

  getSettings(): DiscoverySettings {
    return { ...this.settings, scopes: [...this.settings.scopes], exclude: [...this.settings.exclude], protocols: [...this.settings.protocols] };
  }

  async updateSettings(patch: Partial<DiscoverySettings>): Promise<DiscoverySettings> {
    await this.load();
    if (this.forcedOff && patch.mode && patch.mode !== "off") {
      throw new AdapterError("E_UNSUPPORTED", "Discovery is disabled (EVERYTHING2MCP_DISCOVERY_ENABLED=false)");
    }
    const next = normalizeSettings(patch, this.settings);
    const prevMode = this.settings.mode;
    this.settings = next;
    // A console choice replaces the startup override for the rest of the process.
    this.explicitMode = undefined;
    await this.persist(true);
    recordSecurityEvent({
      ok: true,
      kind: "discovery",
      tool: "discovery.settings",
      detail: `mode ${prevMode} → ${next.mode}; scopes=${next.scopes.length}; interfaces=${next.includeInterfaces}; public=${next.allowPublic}; autoEnable=${next.autoEnable}`,
      dataDir: this.deps.dataDir,
    });
    this.reschedule();
    return this.getSettings();
  }

  /** Start the scheduler (auto mode only). Safe to call more than once. */
  async start(): Promise<void> {
    await this.load();
    this.stopped = false;
    this.reschedule(this.deps.startupDelayMs, "startup");
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.nextRunAt = undefined;
  }

  async idle(): Promise<void> {
    if (this.running) await this.running.catch(() => undefined);
  }

  private reschedule(delayMs?: number, trigger: DiscoveryRun["trigger"] = "auto"): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.nextRunAt = undefined;
    if (this.stopped || this.settings.mode !== "auto") return;
    const ms = delayMs ?? this.settings.intervalMinutes * 60_000;
    this.nextRunAt = new Date(this.deps.now().getTime() + ms).toISOString();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run(trigger)
        .catch((err) => log("auto discovery run failed", { error: String(err) }))
        .finally(() => this.reschedule());
    }, ms);
    this.timer.unref?.();
  }

  status(): Record<string, unknown> {
    const last = this.runs[0];
    return {
      mode: this.settings.mode,
      running: Boolean(this.running),
      nextRunAt: this.nextRunAt,
      lastRun: last,
      counts: this.counts(),
    };
  }

  counts(): Record<string, number> {
    const visible = this.candidates.filter((c) => c.status === "new");
    return {
      discovered: visible.length,
      ready: visible.filter((c) => !c.needsConfig).length,
      needsConfig: visible.filter((c) => c.needsConfig).length,
      online: this.candidates.filter((c) => c.online).length,
      enabled: this.candidates.filter((c) => c.status === "enabled").length,
      dismissed: this.candidates.filter((c) => c.status === "dismissed").length,
      blacklisted: this.candidates.filter((c) => c.status === "blacklisted").length,
    };
  }

  /** Registration ids that came from a discovery candidate (for the 来源 column). */
  registeredIds(): Set<string> {
    return new Set(this.candidates.map((c) => c.registeredId).filter((v): v is string => typeof v === "string"));
  }

  async listCandidates(): Promise<AutoCandidate[]> {
    await this.load();
    await this.refreshStatuses();
    return this.candidates.map((c) => ({ ...c }));
  }

  listRuns(limit = 20): DiscoveryRun[] {
    return this.runs.slice(0, Math.max(0, Math.min(MAX_RUNS, limit)));
  }

  /** Re-derive blacklisted / enabled statuses (blacklist or registry may have changed). */
  private async refreshStatuses(): Promise<void> {
    const reg = this.deps.ctx.registry.list();
    const regTargets = new Map<string, string>();
    for (const a of reg.adapters) {
      const rec = this.deps.ctx.registry.getRecord(a.id);
      if (!rec) continue;
      const t = targetFromConfig(rec.protocol, rec.config);
      if (t) regTargets.set(blacklistId(t), a.id);
    }
    for (const c of this.candidates) {
      const hit = await this.deps.ctx.blacklist.matchCandidate({ protocol: c.protocol, url: c.url, hint: "", status: 0, config: c.config });
      if (hit) {
        c.status = "blacklisted";
        c.blacklistId = hit.id;
        continue;
      }
      if (c.status === "blacklisted") {
        c.status = "new";
        c.blacklistId = undefined;
      }
      const reg = regTargets.get(c.id);
      if (reg) {
        c.status = "enabled";
        c.registeredId = reg;
      } else if (c.status === "enabled" && c.registeredId && !this.deps.ctx.registry.getRecord(c.registeredId)) {
        c.status = "new";
        c.registeredId = undefined;
      }
    }
  }

  /** Build the bounded host list for one run. Exposed for tests. */
  async planHosts(): Promise<{ hosts: PlannedHost[]; truncated: boolean; errors: string[] }> {
    const s = this.settings;
    const cap = s.hostCap;
    const errors: string[] = [];
    const seen = new Set<string>();
    const hosts: PlannedHost[] = [];
    let truncated = false;
    const push = (host: string, source: PlannedHost["source"]): boolean => {
      const h = host.toLowerCase();
      if (seen.has(h)) return true;
      if (isExcluded(h, s.exclude)) return true;
      if (isNeverScan(h)) return true;
      if (hosts.length >= cap) {
        truncated = true;
        return false;
      }
      seen.add(h);
      hosts.push({ host: h, source });
      return true;
    };

    if (s.includeLocalhost) push("127.0.0.1", "localhost");

    const manualCidrs: string[] = [];
    for (const scope of s.scopes) {
      let entry;
      try {
        entry = parseScopeEntry(scope, s.allowPublic);
      } catch (err) {
        errors.push(`${scope}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (entry.kind === "ip") push(entry.raw, "manual");
      else if (entry.kind === "cidr") manualCidrs.push(entry.raw);
      else {
        try {
          const addrs = await this.deps.resolve(entry.raw);
          const bad = addrs.find((a) => isNeverScan(a) || (!s.allowPublic && !isPrivateIp(a)));
          if (!addrs.length) errors.push(`${entry.raw}: no address`);
          else if (bad) errors.push(`${entry.raw}: resolves to ${bad} (public needs allowPublic; link-local/metadata never)`);
          else push(entry.raw, "manual");
        } catch (err) {
          errors.push(`${entry.raw}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    if (s.multicast && s.mode !== "off") {
      const browse = async (fn: (ms: number) => Promise<MulticastHit[]>, via: string) => {
        try {
          return await fn(Math.min(2000, Math.max(500, s.timeoutMs * 2)));
        } catch (err) {
          errors.push(`${via}: ${String(err)}`);
          return [];
        }
      };
      const [m, sd] = await Promise.all([browse(this.deps.mdnsBrowse, "mdns"), browse(this.deps.ssdpBrowse, "ssdp")]);
      for (const hit of [...m, ...sd]) {
        if (!s.allowPublic && !isPrivateIp(hit.host)) continue;
        push(hit.host, hit.via);
      }
    }

    for (const raw of manualCidrs) {
      const c = parseCidr(raw)!;
      const { hosts: list, truncated: t } = expandCidr(c, cap);
      if (t) truncated = true;
      for (const h of list) if (!push(h, "manual")) break;
    }

    if (s.includeInterfaces) {
      let subnets: ReturnType<typeof subnetsFromInterfaces> = [];
      try {
        subnets = subnetsFromInterfaces(this.deps.networkInterfaces());
      } catch (err) {
        errors.push(`interfaces: ${String(err)}`);
      }
      for (const sn of subnets) {
        const { hosts: list } = expandCidr(sn.cidr, 256);
        for (const h of list) {
          if (h === sn.self) continue; // localhost already covers our own services
          if (!push(h, "interface")) break;
        }
      }
    }
    return { hosts, truncated, errors };
  }

  /** One discovery pass. Concurrent callers share the in-flight run. */
  run(trigger: DiscoveryRun["trigger"] = "manual"): Promise<DiscoveryRun> {
    if (this.running) return this.running;
    const p = this.doRun(trigger).finally(() => {
      this.running = undefined;
    });
    this.running = p;
    return p;
  }

  private async doRun(trigger: DiscoveryRun["trigger"]): Promise<DiscoveryRun> {
    await this.load();
    if (this.settings.mode === "off") {
      throw new AdapterError("E_UNSUPPORTED", "Auto-discovery is off (设置 → 发现 → 模式)");
    }
    const ctx = this.deps.ctx;
    // One discover-hook evaluation per run (not per host) so the per-minute
    // discover quota is not exhausted by a sweep; blacklist/SSRF still apply per host.
    await ctx.security.assert({
      hook: "discover",
      actor: { kind: "console", tokenPresent: true },
      target: { protocol: "auto-discovery" },
    });
    const started = this.deps.now();
    const run: DiscoveryRun = {
      id: `run-${started.getTime().toString(36)}`,
      trigger,
      startedAt: started.toISOString(),
      hostsPlanned: 0,
      hostsScanned: 0,
      truncated: false,
      found: 0,
      newCount: 0,
      offlineCount: 0,
      autoEnabled: [],
      errors: [],
      ok: true,
    };
    const plan = await this.planHosts();
    run.hostsPlanned = plan.hosts.length;
    run.truncated = plan.truncated;
    run.errors.push(...plan.errors);

    const found: Array<{ cand: DiscoveryCandidate; source: PlannedHost["source"]; host: string }> = [];
    const queue = [...plan.hosts];
    const workers = Array.from({ length: Math.min(this.settings.concurrency, queue.length) }, async () => {
      for (;;) {
        const next = queue.shift();
        if (!next || this.stopped) return;
        try {
          const cands = await this.deps.scanHost({
            host: next.host,
            protocols: this.settings.protocols,
            timeoutMs: this.settings.timeoutMs,
          });
          for (const cand of cands) found.push({ cand, source: next.source, host: next.host });
        } catch (err) {
          if (run.errors.length < 20) run.errors.push(`${next.host}: ${errorPayload(err).error}`);
        } finally {
          run.hostsScanned += 1;
        }
      }
    });
    await Promise.all(workers);

    const nowIso = this.deps.now().toISOString();
    const scannedHosts = new Set(plan.hosts.map((h) => h.host));
    const seenIds = new Set<string>();
    const suggestions = suggestFromCandidates(found.map((f) => f.cand));
    for (const [i, f] of found.entries()) {
      const sugg = suggestions[i]!;
      const config: JsonObject = { ...sugg.config, allowWrite: false };
      const protocol = canonicalProtocol(f.cand.protocol);
      const target = targetFromCandidate({ ...f.cand, config });
      const id = target ? blacklistId(target) : `${protocol}|${f.cand.url}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      run.found += 1;
      const missing = missingRequiredFields(protocol, config).map((x) => x.key);
      const credentials = CREDENTIALS[protocol] ?? [];
      const authHinted = /auth|password|noauth|denied|unauthori[sz]ed|\b401\b|\b403\b/i.test(`${f.cand.detail ?? ""} ${f.cand.hint ?? ""}`);
      const needsConfig = missing.length > 0 || (AUTH_TYPICAL.has(protocol) && !hasCredentials(config)) || (authHinted && credentials.length > 0);
      const existing = this.candidates.find((c) => c.id === id);
      if (existing) {
        existing.lastSeen = nowIso;
        existing.online = true;
        existing.missCount = 0;
        existing.title = f.cand.title ?? existing.title;
        existing.detail = f.cand.detail ?? existing.detail;
        existing.confidence = sugg.confidence;
        existing.missing = missing;
        existing.needsConfig = needsConfig;
        existing.credentials = credentials;
        if (existing.status !== "enabled") existing.config = config;
      } else {
        run.newCount += 1;
        this.candidates.unshift({
          id,
          protocol,
          host: target?.host ?? f.host,
          url: f.cand.url,
          title: f.cand.title,
          hint: f.cand.hint,
          detail: f.cand.detail,
          confidence: sugg.confidence,
          suggestedName: sanitizeName(sugg.name),
          config,
          source: f.source,
          firstSeen: nowIso,
          lastSeen: nowIso,
          online: true,
          missCount: 0,
          status: "new",
          needsConfig,
          missing,
          credentials,
        });
      }
    }
    for (const c of this.candidates) {
      if (seenIds.has(c.id)) continue;
      if (!scannedHosts.has(c.host.toLowerCase())) continue;
      if (c.online) run.offlineCount += 1;
      c.online = false;
      c.missCount += 1;
    }
    this.candidates = this.candidates
      .filter((c) => c.status === "enabled" || c.missCount < PRUNE_AFTER_MISSES)
      .slice(0, MAX_CANDIDATES);
    await this.refreshStatuses();

    if (this.settings.autoEnable) {
      for (const c of this.candidates) {
        if (c.status !== "new" || c.needsConfig || !c.online) continue;
        try {
          const res = (await callManagementTool(
            "capability_register",
            {
              suggestion: { protocol: c.protocol, name: this.uniqueName(c.suggestedName), config: c.config, source: "discovery", confidence: c.confidence },
              auto: true,
            },
            { ...ctx, actor: { kind: "console", tokenPresent: true } },
          )) as { id: string };
          c.status = "enabled";
          c.registeredId = res.id;
          run.autoEnabled.push(res.id);
        } catch (err) {
          if (run.errors.length < 20) run.errors.push(`auto-enable ${c.id}: ${errorPayload(err).error}`);
        }
      }
    }

    const finished = this.deps.now();
    run.finishedAt = finished.toISOString();
    run.durationMs = finished.getTime() - started.getTime();
    run.ok = run.errors.length === 0 || run.hostsScanned > 0;
    this.runs.unshift(run);
    this.runs = this.runs.slice(0, MAX_RUNS);
    await this.persist();
    recordSecurityEvent({
      ok: run.ok,
      kind: "discovery",
      tool: `discovery.${trigger}`,
      detail: `hosts=${run.hostsScanned}/${run.hostsPlanned}${run.truncated ? " (capped)" : ""} found=${run.found} new=${run.newCount} offline=${run.offlineCount}${run.autoEnabled.length ? ` autoEnabled=${run.autoEnabled.length}` : ""}`,
      dataDir: this.deps.dataDir,
    });
    return run;
  }

  private uniqueName(base: string): string {
    const taken = new Set(this.deps.ctx.registry.list().adapters.map((a) => a.name));
    let name = sanitizeName(base);
    let i = 2;
    while (taken.has(name)) name = sanitizeName(`${base}-${i++}`);
    return name;
  }

  /**
   * One-click enable (已发现，可一键启用). Merges only the prompted fields
   * (missing required + credentials) into the stored config, then goes through
   * capability_register (same gates as mcp_add). allowWrite stays false.
   */
  async enable(id: string, input: { name?: string; config?: JsonObject; credentials?: Record<string, string> }): Promise<Record<string, unknown>> {
    await this.load();
    await this.refreshStatuses();
    const c = this.candidates.find((x) => x.id === id);
    if (!c) throw new AdapterError("E_NOT_FOUND", `Unknown discovery candidate: ${id}`, { details: { id } });
    if (c.status === "blacklisted") {
      throw new AdapterError("E_BLACKLISTED", `Candidate ${id} is blacklisted (${c.blacklistId}). 解除 first.`, { details: { id, blacklistId: c.blacklistId } });
    }
    if (c.status === "enabled" && c.registeredId && this.deps.ctx.registry.getRecord(c.registeredId)) {
      throw new AdapterError("E_CONFLICT", `Already enabled as ${c.registeredId}`, { details: { id, registeredId: c.registeredId } });
    }
    const extra = input.config ?? {};
    const allowedKeys = new Set([...c.missing, ...missingRequiredFields(c.protocol, c.config).map((f) => f.key)]);
    const merged: JsonObject = { ...c.config };
    for (const [k, v] of Object.entries(extra)) {
      if (k === "allowWrite") continue;
      if (allowedKeys.has(k) || !(k in merged)) merged[k] = v as JsonObject[string];
    }
    applyCredentials(merged, c.credentials, input.credentials ?? {});
    merged.allowWrite = false;
    const name = sanitizeName(input.name?.trim() || this.uniqueName(c.suggestedName));
    const res = (await callManagementTool(
      "capability_register",
      { suggestion: { protocol: c.protocol, name, config: merged, source: "discovery", confidence: c.confidence } },
      this.deps.ctx,
    )) as { id: string; tools: string[] };
    c.status = "enabled";
    c.registeredId = res.id;
    await this.persist();
    return { ok: true, candidate: { ...c }, registered: res };
  }

  async dismiss(id: string): Promise<AutoCandidate> {
    await this.load();
    const c = this.candidates.find((x) => x.id === id);
    if (!c) throw new AdapterError("E_NOT_FOUND", `Unknown discovery candidate: ${id}`, { details: { id } });
    c.status = "dismissed";
    await this.persist();
    return { ...c };
  }

  async restore(id: string): Promise<AutoCandidate> {
    await this.load();
    const c = this.candidates.find((x) => x.id === id);
    if (!c) throw new AdapterError("E_NOT_FOUND", `Unknown discovery candidate: ${id}`, { details: { id } });
    if (c.status === "dismissed") c.status = "new";
    await this.persist();
    return { ...c };
  }

  describe(): Record<string, unknown> {
    return {
      privateRanges: PRIVATE_RANGES_DOC,
      neverScan: NEVER_SCAN_DOC,
      limits: { autoPrefixCap: "/24 per interface", manualPrefixMin: "/16", hostCapMax: 1024, concurrencyMax: 64 },
      notes: [
        "每台主机单独走 scanHost（单主机 API、SSRF / 元数据拒绝不变）。",
        "候选默认 allowWrite=false，黑名单命中的不会出现在可启用列表。",
        "autoEnable 仅对 Safe + 只读 + 非黑名单 + 无需凭据 的候选生效，默认关闭。",
      ],
    };
  }
}

function parseMode(raw: string | undefined): DiscoveryMode | undefined {
  const v = raw?.trim().toLowerCase();
  return v === "auto" || v === "manual" || v === "off" ? v : undefined;
}

function hasCredentials(config: JsonObject): boolean {
  if (typeof config.password === "string" && config.password) return true;
  if (typeof config.secretKey === "string" && config.secretKey) return true;
  const url = typeof config.url === "string" ? config.url : "";
  return /^[a-z][a-z0-9+.-]*:\/\/[^/@]+@/i.test(url);
}

export function applyCredentials(config: JsonObject, fields: CredentialField[], values: Record<string, string>): void {
  let user: string | undefined;
  let pass: string | undefined;
  for (const f of fields) {
    const v = values[f.key];
    if (typeof v !== "string" || !v) continue;
    if (f.into === "config") config[f.key] = v;
    else if (f.into === "url-user") user = v;
    else pass = v;
  }
  if ((user || pass) && typeof config.url === "string") {
    try {
      const u = new URL(config.url);
      if (user) u.username = encodeURIComponent(user);
      if (pass) u.password = encodeURIComponent(pass);
      config.url = u.toString();
    } catch {
      /* leave url untouched */
    }
  }
}
