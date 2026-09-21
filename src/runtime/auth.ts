import type { AuthConfig } from "./types.js";

/** Merge config.headers + bearer/basic/apiKey into a header map. Used by all HTTP-class adapters. */
export function headersFromConfig(
  config: Record<string, unknown>,
  extra: Record<string, string> = {},
): Record<string, string> {
  return applyAuthHeaders({ ...stringMap(config.headers), ...extra }, parseAuth(config));
}

export function applyAuthHeaders(
  headers: Record<string, string>,
  auth: AuthConfig | undefined,
): Record<string, string> {
  if (!auth || auth.type === "none") return headers;
  const next = { ...headers };
  if (auth.type === "apiKey") {
    const header = auth.headerName ?? "X-API-Key";
    if (auth.apiKey) next[header] = auth.apiKey;
  } else if (auth.type === "bearer") {
    if (auth.token) next.Authorization = `Bearer ${auth.token}`;
  } else if (auth.type === "basic") {
    const user = auth.username ?? "";
    const pass = auth.password ?? "";
    next.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
  }
  return next;
}

export function applyAuthQuery(
  url: URL,
  auth: AuthConfig | undefined,
): void {
  if (!auth || auth.type !== "apiKey" || !auth.queryName || !auth.apiKey) return;
  url.searchParams.set(auth.queryName, auth.apiKey);
}

export function parseAuth(config: Record<string, unknown>): AuthConfig | undefined {
  const raw = config.auth;
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const type = typeof obj.type === "string" ? obj.type : "none";
  if (type !== "none" && type !== "apiKey" && type !== "bearer" && type !== "basic") {
    return { type: "none" };
  }
  return {
    type,
    apiKey: typeof obj.apiKey === "string" ? obj.apiKey : undefined,
    token: typeof obj.token === "string" ? obj.token : undefined,
    username: typeof obj.username === "string" ? obj.username : undefined,
    password: typeof obj.password === "string" ? obj.password : undefined,
    headerName: typeof obj.headerName === "string" ? obj.headerName : undefined,
    queryName: typeof obj.queryName === "string" ? obj.queryName : undefined,
  };
}

function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
