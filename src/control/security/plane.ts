import { AdapterError } from "../../runtime/errors.js";
import { recordSecurityEvent } from "../../runtime/metrics.js";
import type { BlacklistStore } from "../../catalog/blacklist.js";
import type { JsonStore } from "../../catalog/store.js";
import type { JsonObject, RateLimitConfig } from "../../runtime/types.js";
import { IntegrityLedger, type IntegritySnapshot } from "./integrity.js";
import { createBuiltinModules } from "./modules.js";
import { DEFAULT_RATE_LIMIT } from "./rate-limit.js";
import { SecurityStore } from "./store.js";
import {
  allowDecision,
  denyDecision,
  throwIfDenied,
  type ControlMode,
  type ModuleDescriptor,
  type ModuleSource,
  type PolicyContext,
  type PolicyDecision,
  type SecurityModule,
  type SecurityModuleLoader,
} from "./types.js";

export class SecurityPlane implements SecurityModuleLoader {
  private readonly store: SecurityStore;
  private readonly integrity: IntegrityLedger;
  private readonly modules = new Map<string, SecurityModule>();
  private readonly dataDir: string;
  private onChangeHandler: (() => void) | undefined;

  constructor(
    dataDir: string,
    private readonly deps: {
      blacklist: BlacklistStore;
      registrations?: JsonStore;
      tokenConfigured: () => boolean;
      lookupAdapter?: (id: string) => { protocol: string; config: JsonObject } | undefined;
      rateLimit?: RateLimitConfig;
    },
  ) {
    this.dataDir = dataDir;
    this.store = new SecurityStore(dataDir);
    this.integrity = new IntegrityLedger(dataDir);
    this.deps.blacklist.onPersist = () => this.integrity.seal("blacklist.json").then(() => undefined);
    if (this.deps.registrations) {
      this.deps.registrations.onPersist = () => this.integrity.seal("registrations.json").then(() => undefined);
    }
    for (const mod of createBuiltinModules({
      ...deps,
      verifyIntegrity: () => this.integrity.verifyAll(),
      rateLimit: deps.rateLimit ?? DEFAULT_RATE_LIMIT,
    })) {
      this.modules.set(mod.id, mod);
    }
  }

  onChange(handler: () => void): void {
    this.onChangeHandler = handler;
  }

  async restore(): Promise<void> {
    await this.store.load();
    await this.integrity.verifyAll();
  }

  integritySnapshot(): Promise<IntegritySnapshot> {
    return this.integrity.snapshot();
  }

  mode(): ControlMode {
    return this.store.current();
  }

  async setMode(next: ControlMode, ctx: Omit<PolicyContext, "mode" | "hook"> & { hook?: "modeChange" }): Promise<PolicyDecision> {
    if (next !== "safe" && next !== "full") {
      throw new AdapterError("E_INVALID_ARGUMENT", "security.mode must be safe or full");
    }
    const from = this.mode();
    const decision = await this.evaluate({
      ...ctx,
      hook: "modeChange",
      mode: from,
      target: { ...ctx.target, host: undefined },
    });
    throwIfDenied(decision);
    if (from !== next) {
      await this.store.save(next);
      await this.integrity.seal("security.json");
      recordSecurityEvent({
        ok: true,
        kind: "mode_change",
        detail: `${from} → ${next}`,
        tool: "security.mode",
        dataDir: this.dataDir,
      });
      this.onChangeHandler?.();
    }
    return { effect: "allow", reason: `mode=${next}`, moduleId: "plane" };
  }

  descriptors(): ModuleDescriptor[] {
    return this.list();
  }

  list(): ModuleDescriptor[] {
    return [...this.modules.values()].map((m) => ({
      id: m.id,
      source: "builtin" as const,
      builtin: true,
      locked: Boolean(m.locked),
      bypassInFullControl: Boolean(m.bypassInFullControl),
      hooks: [...m.hooks],
    }));
  }

  async inject(_module: SecurityModule, opts?: { source?: ModuleSource; replace?: boolean }): Promise<void> {
    const source = opts?.source ?? "file";
    if (source !== "builtin") {
      throw new AdapterError("E_UNSUPPORTED", "v1 security loader only ships builtin modules", {
        details: { source },
      });
    }
    throw new AdapterError("E_UNSUPPORTED", "v1 cannot inject additional builtin modules at runtime");
  }

  async replace(id: string, _module: SecurityModule): Promise<void> {
    const existing = this.modules.get(id);
    if (existing?.locked) {
      throw new AdapterError("E_UNSUPPORTED", `Cannot replace locked module ${id}`);
    }
    if (id === "builtin-blacklist") {
      throw new AdapterError("E_UNSUPPORTED", "Cannot replace builtin-blacklist");
    }
    throw new AdapterError("E_UNSUPPORTED", "v1 security loader only ships builtin modules", {
      details: { id },
    });
  }

  async remove(id: string): Promise<void> {
    const existing = this.modules.get(id);
    if (!existing) throw new AdapterError("E_NOT_FOUND", `Unknown security module: ${id}`, { details: { id } });
    if (existing.locked || id === "builtin-blacklist") {
      throw new AdapterError("E_UNSUPPORTED", `Cannot remove resident module ${id}`);
    }
    throw new AdapterError("E_UNSUPPORTED", "v1 cannot unload builtin modules");
  }

  async reload(): Promise<void> {
    this.store.invalidate();
    await this.store.load();
    await this.integrity.verifyAll();
    this.onChangeHandler?.();
  }

  async evaluate(partial: Omit<PolicyContext, "mode"> & { mode?: ControlMode }): Promise<PolicyDecision> {
    const mode = partial.mode ?? this.mode();
    const ctx: PolicyContext = { ...partial, mode };
    const hide = new Set<string>();
    let challenge: PolicyDecision | undefined;
    for (const mod of this.modules.values()) {
      if (!mod.hooks.includes(ctx.hook)) continue;
      if (mode === "full" && mod.bypassInFullControl && !mod.locked) continue;
      const decision = await mod.evaluate(ctx);
      for (const name of decision.hideTools ?? []) hide.add(name);
      if (decision.effect === "deny") {
        recordSecurityEvent({
          ok: false,
          kind: "policy",
          code: decision.code,
          detail: `${mod.id}: ${decision.reason}`,
          tool: ctx.tool?.name,
          protocol: ctx.target?.protocol ?? ctx.tool?.protocol,
          adapterId: ctx.target?.adapterId ?? ctx.tool?.adapterId,
          dataDir: this.dataDir,
        });
        return { ...decision, hideTools: [...hide] };
      }
      if (decision.effect === "challenge" && !ctx.challengeSatisfied) challenge = decision;
    }
    const ok: PolicyDecision = challenge ?? allowDecision("plane", "allow");
    ok.hideTools = [...hide];
    return ok;
  }

  async assert(partial: Omit<PolicyContext, "mode"> & { mode?: ControlMode }): Promise<PolicyDecision> {
    return throwIfDenied(await this.evaluate(partial));
  }

  async hideAgentTools<T extends { name: string; adapterId?: string; protocol?: string }>(
    tools: T[],
    actor: PolicyContext["actor"] = { kind: "mcp-stdio", tokenPresent: false },
  ): Promise<T[]> {
    const decision = await this.evaluate({
      hook: "list",
      actor,
      listedTools: tools.map((t) => ({ name: t.name, adapterId: t.adapterId, protocol: t.protocol })),
    });
    const hide = new Set(decision.hideTools ?? []);
    if (hide.size === 0) return tools;
    return tools.filter((t) => !hide.has(t.name));
  }
}

export { denyDecision };
