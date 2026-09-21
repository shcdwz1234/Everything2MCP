const EXACT_SECRET = new Set([
  "password",
  "passwd",
  "secret",
  "secretkey",
  "token",
  "accesstoken",
  "apikey",
  "authorization",
  "bearer",
  "credential",
  "privatekey",
  "clientsecret",
  "accesskey",
  "jwt",
  "tlskey",
]);

const SECRET_HINT = /secret|password|passwd|token|apikey|privatekey|credential/;
const NOT_SECRET = /timeout|retries|interval|content/;

const REDACTED = "••••";

/** Normalize a config/object key for secret matching (camelCase / snake / kebab). */
export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isSecretKey(key: string): boolean {
  const n = normalizeKey(key);
  if (EXACT_SECRET.has(n)) return true;
  if (NOT_SECRET.test(n)) return false;
  return SECRET_HINT.test(n);
}

/**
 * Recursively replace secret string values with a mask.
 * Used on REST responses and durable audit so credentials never persist.
 */
export function redactSecrets<T>(value: T): T {
  return redactInner(value) as T;
}

function redactInner(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactInner);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKey(key) && typeof child === "string" && child.length > 0) {
        out[key] = REDACTED;
      } else if (isSecretKey(key) && typeof child === "number") {
        out[key] = REDACTED;
      } else {
        out[key] = redactInner(child);
      }
    }
    return out;
  }
  return value;
}

export const SECRET_MASK = REDACTED;
