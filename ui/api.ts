export interface ApiError extends Error {
  status: number;
  body: unknown;
}

const TOKEN_KEY = "e2mcp.token";

export function getToken(): string {
  return sessionStorage.getItem(TOKEN_KEY) ?? "";
}

export function setToken(token: string): void {
  if (token.trim()) sessionStorage.setItem(TOKEN_KEY, token.trim());
  else sessionStorage.removeItem(TOKEN_KEY);
}

export async function api<T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && init.body) headers.set("Content-Type", "application/json");
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(path, { ...init, headers });
  const text = await res.text();
  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { ok: false, error: text };
    }
  }
  if (!res.ok) {
    const err = new Error(
      body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : res.statusText,
    ) as ApiError;
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body as T;
}

export const rest = {
  health: () => api("/api/health"),
  settings: () => api("/api/settings"),
  matrix: () => api("/api/matrix"),
  adapters: () => api("/api/adapters"),
  adapter: (id: string) => api(`/api/adapters/${encodeURIComponent(id)}`),
  createAdapter: (body: unknown) => api("/api/adapters", { method: "POST", body: JSON.stringify(body) }),
  updateAdapter: (id: string, config: unknown) =>
    api(`/api/adapters/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ config }) }),
  deleteAdapter: (id: string) => api(`/api/adapters/${encodeURIComponent(id)}`, { method: "DELETE" }),
  ping: (id: string) => api(`/api/adapters/${encodeURIComponent(id)}/ping`, { method: "POST", body: "{}" }),
  tools: (layer: string) => api(`/api/tools?layer=${encodeURIComponent(layer)}`),
  tool: (name: string) => api(`/api/tools/${encodeURIComponent(name)}`),
  invoke: (name: string, args: unknown, confirm = false) =>
    api(`/api/tools/${encodeURIComponent(name)}/invoke`, {
      method: "POST",
      body: JSON.stringify({ arguments: args, confirm }),
    }),
  scan: (body: unknown) => api("/api/discovery/scan", { method: "POST", body: JSON.stringify(body) }),
  probe: (body: unknown) => api("/api/discovery/probe", { method: "POST", body: JSON.stringify(body) }),
  suggest: (body: unknown) => api("/api/discovery/suggest", { method: "POST", body: JSON.stringify(body) }),
  registerSuggestion: (body: unknown) =>
    api("/api/discovery/register", { method: "POST", body: JSON.stringify(body) }),
  inventory: () => api("/api/environment/inventory", { method: "POST", body: "{}" }),
  hotAdd: (body: unknown) => api("/api/capabilities/register", { method: "POST", body: JSON.stringify(body) }),
  hotRemove: (id: string) =>
    api("/api/capabilities/unregister", { method: "POST", body: JSON.stringify({ id, confirm: true }) }),
  importSchema: (body: unknown) => api("/api/import", { method: "POST", body: JSON.stringify(body) }),
  audit: (limit = 80) => api(`/api/audit?limit=${limit}`),
  plan: (body: unknown) => api("/api/plan", { method: "POST", body: JSON.stringify(body) }),
  errors: () => api("/api/errors"),
  blacklist: () => api("/api/blacklist"),
  addBlacklist: (body: unknown) => api("/api/blacklist", { method: "POST", body: JSON.stringify(body) }),
  removeBlacklist: (id: string) => api(`/api/blacklist/${encodeURIComponent(id)}`, { method: "DELETE" }),
  security: () => api("/api/security"),
  setMode: (mode: string) =>
    api("/api/security/mode", { method: "PUT", body: JSON.stringify({ mode, confirm: true }) }),
  partnerConnections: () => api("/api/partner/v1/connections"),
  partnerToken: () => api("/api/partner/v1/token"),
  rotatePartnerToken: () =>
    api("/api/partner/v1/token", { method: "POST", body: JSON.stringify({ confirm: true }) }),
  partnerUnregister: (capability_id: string) =>
    api("/api/partner/v1/unregister", {
      method: "POST",
      body: JSON.stringify({ capability_id, confirm: true }),
    }),
  compatScan: () => api("/api/compat/scan", { method: "POST", body: "{}" }),
};
