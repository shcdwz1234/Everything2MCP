import { AdapterError, type ErrorCode } from "../../runtime/errors.js";

export type ControlMode = "safe" | "full";

export type SecurityHook =
  | "auth"
  | "discover"
  | "register"
  | "invoke"
  | "import"
  | "list"
  | "modeChange";

export type PolicyEffect = "allow" | "deny" | "challenge";

export type ModuleSource = "builtin" | "file" | "package";

export interface PolicyContext {
  mode: ControlMode;
  hook: SecurityHook;
  requestId?: string;
  actor: {
    kind: "http-token" | "mcp-stdio" | "console";
    tokenPresent: boolean;
  };
  target?: {
    protocol?: string;
    host?: string;
    port?: number;
    url?: string;
    adapterId?: string;
    blacklistId?: string;
    config?: Record<string, unknown>;
  };
  tool?: {
    name: string;
    layer: "management" | "business";
    write?: boolean;
    adapterId?: string;
    protocol?: string;
  };
  listedTools?: Array<{ name: string; adapterId?: string; protocol?: string }>;
  config?: Record<string, unknown>;
  challengeSatisfied?: boolean;
}

export interface PolicyDecision {
  effect: PolicyEffect;
  code?: string;
  reason: string;
  moduleId: string;
  hideTools?: string[];
  challenge?: {
    kind: "confirm" | "reauth";
    hint: string;
  };
}

export interface SecurityModule {
  readonly id: string;
  readonly hooks: readonly SecurityHook[];
  readonly locked?: boolean;
  readonly bypassInFullControl?: boolean;
  evaluate(ctx: PolicyContext): Promise<PolicyDecision>;
}

export interface ModuleDescriptor {
  id: string;
  source: ModuleSource;
  builtin: boolean;
  locked: boolean;
  bypassInFullControl: boolean;
  hooks: SecurityHook[];
}

export interface SecurityModuleLoader {
  list(): ModuleDescriptor[];
  inject(module: SecurityModule, opts?: { source?: ModuleSource; replace?: boolean }): Promise<void>;
  replace(id: string, module: SecurityModule): Promise<void>;
  remove(id: string): Promise<void>;
  reload(): Promise<void>;
}

export interface SecurityFile {
  version: 1;
  mode: ControlMode;
  modules?: Array<{
    id: string;
    enabled?: boolean;
    source?: ModuleSource;
    path?: string;
    package?: string;
  }>;
}

export function allowDecision(moduleId: string, reason = "ok"): PolicyDecision {
  return { effect: "allow", reason, moduleId };
}

export function denyDecision(moduleId: string, code: string, reason: string): PolicyDecision {
  return { effect: "deny", code, reason, moduleId };
}

export function throwIfDenied(decision: PolicyDecision): PolicyDecision {
  if (decision.effect === "deny") {
    throw new AdapterError((decision.code as ErrorCode) ?? "E_UNSUPPORTED", decision.reason, {
      details: { moduleId: decision.moduleId },
    });
  }
  if (decision.effect === "challenge") {
    throw new AdapterError("E_INVALID_ARGUMENT", decision.challenge?.hint ?? decision.reason, {
      details: { moduleId: decision.moduleId, challenge: decision.challenge },
    });
  }
  return decision;
}

export function defaultActor(kind: PolicyContext["actor"]["kind"] = "mcp-stdio"): PolicyContext["actor"] {
  return { kind, tokenPresent: false };
}
