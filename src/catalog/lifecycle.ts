import type { JsonObject } from "../runtime/types.js";

/**
 * Capability Lifecycle (Phase V). Logical plane only — lives in Catalog, not a sixth package.
 *
 * inventory/config-validate → suggest → policy gate → confirm | auto_readonly → live → unregistered
 *
 * Catalog.hot_register is ToolRegistry.add; hot-delete is ToolRegistry.remove
 * (same persist + list_changed path). Unregister is control-plane: it does not
 * require allowWrite, and blacklist does not block removal of a live instance.
 */
export const CAPABILITY_STATES = [
  "draft",
  "validated",
  "suggested",
  "denied",
  "pending_confirm",
  "auto_readonly",
  "live",
  "unregistered",
] as const;

export type CapabilityState = (typeof CAPABILITY_STATES)[number];

export type CapabilitySource = "discovery" | "environment" | "manual" | "agent";

export interface CapabilityProposal {
  protocol: string;
  name: string;
  config: JsonObject;
  source?: CapabilitySource;
  confidence?: number;
  reason?: string;
}

export interface LifecycleDecision {
  state: CapabilityState;
  autoEligible: boolean;
  requiresConfirm: boolean;
  readonly: boolean;
  reason: string;
  proposal: CapabilityProposal;
}

export function isReadonlyConfig(config: JsonObject): boolean {
  if (config.riskCeiling === "write" || config.riskCeiling === "desktop") return false;
  return (
    config.allowWrite !== true &&
    config.allowShell !== true &&
    config.allowDesktop !== true &&
    config.allowReadSecrets !== true
  );
}

/**
 * Auto-register is readonly + not blacklisted (Safe and Full).
 * Write/shell/desktop/secrets-gated configs always need confirm.
 * Suggest never bulk-registers. needsConfig candidates are skipped by the caller.
 */
export function evaluateLifecycle(input: {
  proposal: CapabilityProposal;
  mode: "safe" | "full";
  blacklisted: boolean;
  alreadyLive: boolean;
  validated: boolean;
}): LifecycleDecision {
  const { proposal, mode, blacklisted, alreadyLive, validated } = input;
  const readonly = isReadonlyConfig(proposal.config);

  if (alreadyLive) {
    return {
      state: "live",
      autoEligible: false,
      requiresConfirm: false,
      readonly,
      reason: "Already registered (live).",
      proposal,
    };
  }
  if (!validated) {
    return {
      state: "draft",
      autoEligible: false,
      requiresConfirm: true,
      readonly,
      reason: "Config did not validate.",
      proposal,
    };
  }
  if (blacklisted) {
    return {
      state: "denied",
      autoEligible: false,
      requiresConfirm: false,
      readonly,
      reason: "Target is blacklisted (Safe and Full).",
      proposal,
    };
  }

  const autoEligible = readonly && !blacklisted;
  if (autoEligible) {
    return {
      state: "auto_readonly",
      autoEligible: true,
      requiresConfirm: false,
      readonly,
      reason: `${mode === "full" ? "Full" : "Safe"} + readonly + not blacklisted; auto-register allowed if the caller opts in with auto:true.`,
      proposal,
    };
  }
  return {
    state: "pending_confirm",
    autoEligible: false,
    requiresConfirm: true,
    readonly,
    reason:
      "Write/shell/desktop/secrets (or Partner write/desktop riskCeiling) is not auto-eligible; confirm or explicit register required.",
    proposal,
  };
}

/**
 * Hot-delete decision. Removing a live capability is always allowed at the
 * lifecycle layer (Safe and Full). Missing id is a clear error, not a silent no-op.
 * Blacklist / allowWrite are not consulted — re-add is still gated.
 */
export function evaluateUnregister(input: { id: string; live: boolean }): {
  state: "unregistered" | "denied";
  found: boolean;
  reason: string;
  id: string;
} {
  if (!input.live) {
    return {
      state: "denied",
      found: false,
      reason: `Unknown registration id: ${input.id}`,
      id: input.id,
    };
  }
  return {
    state: "unregistered",
    found: true,
    reason: "Live capability can be hot-removed (control-plane; allowWrite not required).",
    id: input.id,
  };
}
