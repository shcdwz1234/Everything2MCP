import { looksLikeReadRpc } from "../../adapters/rpc-gate.js";
import { blacklistId, blacklistedError, targetFromConfig, type BlacklistStore } from "../../catalog/blacklist.js";
import { looksLikeNetworkRange } from "../../discovery/probe.js";
import { AdapterError, type ErrorCode } from "../../runtime/errors.js";
import { isBlockedHostname } from "../../runtime/ssrf.js";
import type { JsonObject } from "../../runtime/types.js";
import { SlidingWindowLimiter, type RateLimitConfig } from "./rate-limit.js";
import { allowDecision, denyDecision, type PolicyContext, type PolicyDecision, type SecurityModule } from "./types.js";

function hostFromCtx(ctx: PolicyContext): string {
  if (ctx.target?.host) return ctx.target.host;
  const cfg = ctx.target?.config ?? ctx.config;
  if (cfg && typeof cfg.host === "string") return cfg.host;
  return "";
}

function cidrDeny(moduleId: string, host: string): PolicyDecision | undefined {
  if (host && looksLikeNetworkRange(host)) {
    return denyDecision(
      moduleId,
      "E_UNSUPPORTED",
      "Refusing to scan a network range. CIDR / ranges / wildcards are never allowed (Safe and Full).",
    );
  }
  return undefined;
}

export function createBuiltinModules(deps: {
  blacklist: BlacklistStore;
  tokenConfigured: () => boolean;
  lookupAdapter?: (id: string) => { protocol: string; config: JsonObject } | undefined;
  verifyIntegrity?: () => Promise<void>;
  rateLimit?: RateLimitConfig;
}): SecurityModule[] {
  const coreAuth: SecurityModule = {
    id: "core-auth",
    hooks: ["auth"],
    locked: true,
    bypassInFullControl: false,
    async evaluate(ctx) {
      if (ctx.hook !== "auth") return allowDecision(this.id);
      if (deps.tokenConfigured() && !ctx.actor.tokenPresent) {
        return denyDecision(this.id, "E_AUTH", "HTTP token required");
      }
      return allowDecision(this.id);
    },
  };

  const coreAudit: SecurityModule = {
    id: "core-audit",
    hooks: ["auth", "discover", "register", "unregister", "invoke", "import", "list", "modeChange"],
    locked: true,
    bypassInFullControl: false,
    async evaluate() {
      return allowDecision("core-audit", "audit sink");
    },
  };

  const coreIntegrity: SecurityModule = {
    id: "core-integrity",
    hooks: ["discover", "register", "unregister", "import", "invoke", "modeChange"],
    locked: true,
    bypassInFullControl: false,
    async evaluate(ctx) {
      if (deps.verifyIntegrity) {
        try {
          await deps.verifyIntegrity();
        } catch (err) {
          if (err instanceof AdapterError) {
            return denyDecision(this.id, err.code, err.message);
          }
          throw err;
        }
      }
      const hit = cidrDeny(this.id, hostFromCtx(ctx));
      if (hit) return hit;
      return allowDecision(this.id);
    },
  };

  const discoveryScope: SecurityModule = {
    id: "discovery-scope",
    hooks: ["discover"],
    locked: true,
    bypassInFullControl: false,
    async evaluate(ctx) {
      return cidrDeny(this.id, hostFromCtx(ctx)) ?? allowDecision(this.id);
    },
  };

  const ssrf: SecurityModule = {
    id: "ssrf",
    hooks: ["discover", "register", "import"],
    locked: false,
    bypassInFullControl: false,
    async evaluate(ctx) {
      const host = hostFromCtx(ctx);
      if (host && isBlockedHostname(host.split(":")[0] ?? host)) {
        return denyDecision(this.id, "E_UNSUPPORTED", `Refusing metadata / link-local host: ${host}`);
      }
      return allowDecision(this.id);
    },
  };

  const blacklist: SecurityModule = {
    id: "builtin-blacklist",
    hooks: ["discover", "register", "list", "invoke"],
    locked: false,
    bypassInFullControl: false,
    async evaluate(ctx) {
      if (ctx.hook === "list") {
        const hide: string[] = [];
        const listed = ctx.listedTools ?? [];
        for (const tool of listed) {
          const id = tool.adapterId;
          if (!id || !deps.lookupAdapter) continue;
          const rec = deps.lookupAdapter(id);
          if (!rec) continue;
          const target = targetFromConfig(rec.protocol, rec.config);
          if (!target) continue;
          const hit = await deps.blacklist.find(blacklistId(target));
          if (hit) hide.push(tool.name);
        }
        return { effect: "allow", reason: "list filter", moduleId: this.id, hideTools: hide };
      }
      const protocol = ctx.target?.protocol ?? ctx.tool?.protocol;
      const config = (ctx.target?.config ?? ctx.config) as JsonObject | undefined;
      if (!protocol || !config) return allowDecision(this.id);
      const hit = await deps.blacklist.matchConfig(protocol, config);
      if (!hit) return allowDecision(this.id);
      const err = blacklistedError(hit);
      return denyDecision(this.id, err.code, err.message);
    },
  };

  const allowWrite: SecurityModule = {
    id: "allow-write",
    hooks: ["invoke"],
    locked: false,
    bypassInFullControl: true,
    async evaluate(ctx) {
      if (ctx.hook !== "invoke") return allowDecision(this.id);
      const write = ctx.tool?.write === true;
      const cfg = ctx.target?.config ?? ctx.config;
      const allowed = cfg?.allowWrite === true;
      if (write && !allowed) {
        return denyDecision(
          this.id,
          "E_UNSUPPORTED",
          "Write invoke blocked (allowWrite is not true). Full mode may skip this module; adapters still gate writes.",
        );
      }
      return allowDecision(this.id);
    },
  };

  const dangerous: SecurityModule = {
    id: "dangerous-tools",
    hooks: ["invoke"],
    locked: false,
    bypassInFullControl: true,
    async evaluate(ctx) {
      if (ctx.hook !== "invoke" || !ctx.tool) return allowDecision(this.id);
      const name = ctx.tool.name;
      const write = ctx.tool.write === true || !looksLikeReadRpc(name);
      if (write && !ctx.challengeSatisfied && ctx.actor.kind === "console") {
        return {
          effect: "challenge",
          reason: "Write invoke requires confirm:true",
          moduleId: this.id,
          challenge: { kind: "confirm", hint: "Write invoke requires confirm:true in the console." },
        };
      }
      return allowDecision(this.id);
    },
  };

  const limiter = new SlidingWindowLimiter(
    deps.rateLimit ?? { invokePerMinute: 60, discoverPerMinute: 20 },
  );

  const rateLimit: SecurityModule = {
    id: "rate-limit",
    hooks: ["invoke", "discover"],
    locked: false,
    bypassInFullControl: true,
    async evaluate(ctx) {
      if (ctx.hook !== "invoke" && ctx.hook !== "discover") return allowDecision(this.id);
      return limiter.try(ctx.hook) ?? allowDecision(this.id, "within quota");
    },
  };

  const secretRedact: SecurityModule = {
    id: "secret-redact",
    hooks: ["register", "unregister", "invoke", "import", "list", "modeChange"],
    locked: false,
    bypassInFullControl: false,
    async evaluate() {
      return allowDecision(this.id, "audit/log/REST secrets redacted");
    },
  };

  const tlsMaterial: SecurityModule = {
    id: "tls-material",
    hooks: ["register"],
    locked: false,
    bypassInFullControl: false,
    async evaluate() {
      return allowDecision(this.id, "PEM watchTlsMaterial re-reads files; live gRPC channel still needs mcp_update");
    },
  };

  return [
    coreAuth,
    coreAudit,
    coreIntegrity,
    discoveryScope,
    ssrf,
    blacklist,
    allowWrite,
    dangerous,
    rateLimit,
    secretRedact,
    tlsMaterial,
  ];
}

export function inferWrite(toolName: string, config?: JsonObject): boolean {
  if (config && typeof toolName === "string") {
    /* allowWrite gate uses write flag from caller when provided */
  }
  return !looksLikeReadRpc(toolName);
}

export function asAdapterError(decision: PolicyDecision): AdapterError {
  return new AdapterError((decision.code as ErrorCode) ?? "E_UNSUPPORTED", decision.reason, {
    details: { moduleId: decision.moduleId },
  });
}
