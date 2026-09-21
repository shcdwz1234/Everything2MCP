import { denyDecision, type PolicyDecision } from "./types.js";

export interface RateLimitConfig {
  /** Sliding 60s window. 0 = unlimited. */
  invokePerMinute: number;
  discoverPerMinute: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  invokePerMinute: 60,
  discoverPerMinute: 20,
};

/** Conservative process-local sliding window. Full mode skips this module. */
export class SlidingWindowLimiter {
  private readonly buckets = new Map<string, number[]>();

  constructor(private readonly limits: RateLimitConfig) {}

  try(hook: "invoke" | "discover"): PolicyDecision | undefined {
    const limit = hook === "invoke" ? this.limits.invokePerMinute : this.limits.discoverPerMinute;
    if (!Number.isFinite(limit) || limit <= 0) return undefined;
    const now = Date.now();
    const windowMs = 60_000;
    let hits = this.buckets.get(hook) ?? [];
    hits = hits.filter((t) => now - t < windowMs);
    if (hits.length >= limit) {
      return denyDecision(
        "rate-limit",
        "E_UNSUPPORTED",
        `Rate limit exceeded (${limit} ${hook} calls per minute). Full mode skips this module.`,
      );
    }
    hits.push(now);
    this.buckets.set(hook, hits);
    return undefined;
  }
}

export function parseRateLimit(
  env: NodeJS.ProcessEnv = process.env,
  overrides?: Partial<RateLimitConfig>,
): RateLimitConfig {
  const invoke = Number(env.EVERYTHING2MCP_RATE_LIMIT_INVOKE ?? DEFAULT_RATE_LIMIT.invokePerMinute);
  const discover = Number(env.EVERYTHING2MCP_RATE_LIMIT_DISCOVER ?? DEFAULT_RATE_LIMIT.discoverPerMinute);
  return {
    invokePerMinute:
      overrides?.invokePerMinute ?? (Number.isFinite(invoke) && invoke >= 0 ? invoke : DEFAULT_RATE_LIMIT.invokePerMinute),
    discoverPerMinute:
      overrides?.discoverPerMinute ??
      (Number.isFinite(discover) && discover >= 0 ? discover : DEFAULT_RATE_LIMIT.discoverPerMinute),
  };
}
