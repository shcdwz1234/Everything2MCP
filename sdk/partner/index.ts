/**
 * Thin E2MCP Partner SDK (Node). Apps do NOT implement MCP.
 * Register a Capability Manifest, serve HTTP invoke, heartbeat, unregister.
 */
export interface PartnerOperation {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  risk: "readonly" | "write" | "desktop";
}

export interface PartnerManifest {
  capability_id: string;
  display_name: string;
  version: string;
  operations: PartnerOperation[];
  invoke: { kind: "http" | "ipc"; url?: string; path?: string };
  auth?: { type: "none" | "bearer" | "partner_token"; token?: string };
  heartbeatTtlMs?: number;
}

export interface PartnerClientOptions {
  baseUrl: string;
  token: string;
}

async function post(url: string, token: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-partner-token": token },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as unknown;
  if (!res.ok) {
    const err = json && typeof json === "object" && "error" in json ? String((json as { error: unknown }).error) : res.statusText;
    throw new Error(err);
  }
  return json;
}

export async function register(opts: PartnerClientOptions, manifest: PartnerManifest, extra: Record<string, unknown> = {}) {
  return post(`${opts.baseUrl.replace(/\/+$/, "")}/api/partner/v1/register`, opts.token, { ...manifest, ...extra });
}

export async function heartbeat(opts: PartnerClientOptions, capability_id: string) {
  return post(`${opts.baseUrl.replace(/\/+$/, "")}/api/partner/v1/heartbeat`, opts.token, { capability_id });
}

export async function unregister(opts: PartnerClientOptions, capability_id: string) {
  return post(`${opts.baseUrl.replace(/\/+$/, "")}/api/partner/v1/unregister`, opts.token, { capability_id, confirm: true });
}

export type InvokeHandler = (req: { op: string; args: Record<string, unknown>; call_id?: string }) => Promise<unknown> | unknown;

/** Serve the Partner invoke HTTP callback. This is not an MCP server. */
export async function serveInvoke(
  handler: InvokeHandler,
  listen: { host?: string; port?: number } = {},
): Promise<{ port: number; url: string; close: () => Promise<void> }> {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let payload: { op?: string; args?: Record<string, unknown>; call_id?: string } = {};
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as typeof payload;
      } catch {
        payload = {};
      }
      res.setHeader("content-type", "application/json");
      try {
        const result = await handler({
          op: payload.op ?? "",
          args: payload.args ?? {},
          call_id: payload.call_id,
        });
        res.end(JSON.stringify({ ok: true, result, call_id: payload.call_id }));
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      }
    })();
  });
  const host = listen.host ?? "127.0.0.1";
  await new Promise<void>((r) => server.listen(listen.port ?? 0, host, r));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    url: `http://${host}:${port}/invoke`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
