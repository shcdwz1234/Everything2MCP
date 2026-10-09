import { makeId } from "../catalog/registry.js";
import type { ToolRegistry } from "../catalog/registry.js";
import { evaluateLifecycle, type CapabilityProposal, type LifecycleDecision } from "../catalog/lifecycle.js";
import { canonicalProtocol, validateRegistration } from "../catalog/validate.js";
import { AdapterError } from "../runtime/errors.js";
import type { JsonObject } from "../runtime/types.js";
import { assertNotBlacklisted, type BlacklistStore } from "../catalog/blacklist.js";
import type { SecurityPlane } from "./security/index.js";

export interface CapabilityContext {
  registry: ToolRegistry;
  blacklist: BlacklistStore;
  security: SecurityPlane;
}

export async function decideCapability(
  ctx: CapabilityContext,
  proposal: CapabilityProposal,
): Promise<LifecycleDecision> {
  const protocol = canonicalProtocol(proposal.protocol);
  const name = proposal.name;
  const config = { ...proposal.config };
  if (config.allowWrite !== true) config.allowWrite = false;
  let validated = true;
  try {
    validateRegistration(protocol, name, config);
  } catch {
    validated = false;
  }
  const id = makeId(protocol, name);
  const alreadyLive = Boolean(ctx.registry.get(id));
  let blacklisted = false;
  try {
    await assertNotBlacklisted(ctx.blacklist, protocol, config);
  } catch (err) {
    if (err instanceof AdapterError && err.code === "E_BLACKLISTED") blacklisted = true;
    else throw err;
  }
  return evaluateLifecycle({
    proposal: { ...proposal, protocol, name, config },
    mode: ctx.security.mode(),
    blacklisted,
    alreadyLive,
    validated,
  });
}

export function proposalFromArgs(args: Record<string, unknown>): CapabilityProposal {
  const suggestion =
    args.suggestion && typeof args.suggestion === "object" && !Array.isArray(args.suggestion)
      ? (args.suggestion as Record<string, unknown>)
      : args;
  const protocol = String(suggestion.protocol ?? "").trim();
  const name = String(suggestion.name ?? "").trim();
  const config =
    suggestion.config && typeof suggestion.config === "object" && !Array.isArray(suggestion.config)
      ? ({ ...(suggestion.config as JsonObject) } as JsonObject)
      : {};
  if (!protocol || !name) {
    throw new AdapterError("E_INVALID_ARGUMENT", "capability_register needs protocol and name (or a suggestion object)", {
      details: { keys: Object.keys(args) },
    });
  }
  if (config.allowWrite !== true) config.allowWrite = false;
  const source =
    suggestion.source === "environment" || suggestion.source === "discovery" || suggestion.source === "manual"
      ? suggestion.source
      : "agent";
  return {
    protocol,
    name,
    config,
    source,
    confidence: typeof suggestion.confidence === "number" ? suggestion.confidence : undefined,
    reason: typeof suggestion.reason === "string" ? suggestion.reason : undefined,
  };
}

export function assertAutoAllowed(decision: LifecycleDecision, auto: boolean, confirm: boolean): void {
  if (decision.state === "denied") {
    throw new AdapterError("E_BLACKLISTED", decision.reason, { protocol: decision.proposal.protocol });
  }
  if (decision.state === "draft") {
    throw new AdapterError("E_INVALID_CONFIG", decision.reason, { protocol: decision.proposal.protocol });
  }
  if (auto && !decision.autoEligible) {
    throw new AdapterError(
      "E_UNSUPPORTED",
      "auto-register is limited to readonly (allowWrite/allowShell/allowDesktop/allowReadSecrets not true) + non-blacklist (Safe and Full)",
      { protocol: decision.proposal.protocol, details: { state: decision.state, reason: decision.reason } },
    );
  }
  void confirm;
}
