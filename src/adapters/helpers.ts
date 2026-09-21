export function stringField(config: Record<string, unknown>, key: string): string | undefined {
  const v = config[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export function requiredString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new Error(`Missing required string "${key}"`);
  return v.trim();
}

export function requiredNumber(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== "number" || Number.isNaN(v)) throw new Error(`Missing required number "${key}"`);
  return v;
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}

export function payloadToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

export function timeoutMs(args: Record<string, unknown>, fallback = 5000): number {
  return typeof args.timeoutMs === "number" ? args.timeoutMs : fallback;
}
