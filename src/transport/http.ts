import { createServer, type IncomingMessage, type Server as NodeHttpServer, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createEverything2McpServer, handleConsoleRest, type Everything2Mcp } from "../control/index.js";
import { DEFAULT_HTTP_PORT } from "../catalog/config.js";
import { log } from "../runtime/log.js";
import { APP_NAME, APP_VERSION, type AppConfigOverrides, type TransportConfig } from "../runtime/types.js";
import { resolveUiRoot, tryServeUi } from "./static-ui.js";
import type { HttpTransportOptions } from "./types.js";

export interface HttpBinding {
  httpServer: NodeHttpServer;
  host: string;
  port: number;
  url: string;
  mcpUrl: string;
  sseUrl: string;
  uiUrl: string;
  apiUrl: string;
  mcpPath: string;
  ssePath: string;
  messagesPath: string;
  close: () => Promise<void>;
}

export interface Everything2McpHttp extends Everything2Mcp {
  http: HttpBinding;
}

type StreamableSession = {
  kind: "streamable";
  transport: StreamableHTTPServerTransport;
  server: Server;
};

type SseSession = {
  kind: "sse";
  transport: SSEServerTransport;
  server: Server;
};

type Session = StreamableSession | SseSession;

function mergeTransport(app: Everything2Mcp, options?: HttpTransportOptions): TransportConfig {
  return {
    ...app.config.transport,
    host: options?.host ?? app.config.transport.host,
    port: options?.port ?? app.config.transport.port,
    mcpPath: options?.path ?? app.config.transport.mcpPath,
    ssePath: options?.ssePath ?? app.config.transport.ssePath,
    messagesPath: options?.messagesPath ?? app.config.transport.messagesPath,
    token: options?.token ?? app.config.transport.token,
    tokenHeader: options?.tokenHeader ?? app.config.transport.tokenHeader,
  };
}

function normalizePath(path: string): string {
  if (!path) return "/";
  const withSlash = path.startsWith("/") ? path : `/${path}`;
  if (withSlash.length > 1 && withSlash.endsWith("/")) return withSlash.slice(0, -1);
  return withSlash;
}

function publicHost(host: string): string {
  if (host === "0.0.0.0" || host === "::" || host === "[::]") return "127.0.0.1";
  return host;
}

function tokensEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

function extractToken(req: IncomingMessage, extraHeader?: string): string | undefined {
  const auth = headerValue(req, "authorization");
  if (auth) {
    const bearer = auth.match(/^Bearer\s+(.+)$/i);
    return bearer?.[1]?.trim() ?? auth.trim();
  }
  const apiKey = headerValue(req, "x-api-key");
  if (apiKey) return apiKey.trim();
  if (extraHeader) {
    const extra = headerValue(req, extraHeader);
    if (extra) return extra.trim();
  }
  return undefined;
}

function flattenHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") out[k] = v;
    else if (Array.isArray(v) && v[0]) out[k] = v[0];
  }
  return out;
}

function isPartnerAppPath(pathname: string): boolean {
  return /^\/api\/partner\/v1\/(register|unregister|heartbeat|invoke|schema)$/.test(pathname);
}

function rejectUnauthorized(res: ServerResponse): void {
  res.writeHead(401, {
    "Content-Type": "application/json",
    "WWW-Authenticate": 'Bearer realm="everything2mcp"',
  });
  res.end(JSON.stringify({ ok: false, error: "unauthorized", code: "E_AUTH" }));
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, x-partner-token, mcp-session-id, mcp-protocol-version",
    "Access-Control-Expose-Headers": "mcp-session-id, mcp-protocol-version",
  };
}

function applyCors(res: ServerResponse): void {
  for (const [k, v] of Object.entries(corsHeaders())) {
    res.setHeader(k, v);
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return undefined;
  return JSON.parse(raw);
}

function isInitializeRequest(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some((msg) => msg && typeof msg === "object" && (msg as { method?: string }).method === "initialize");
}

/**
 * Bind Streamable HTTP (`/mcp`) and legacy SSE (`/sse` + `/messages`) on a Node HTTP server.
 * Used by both `attachHttp` and `attachSse` — they share one listener.
 */
export async function listenMcpHttp(app: Everything2Mcp, options?: HttpTransportOptions): Promise<HttpBinding> {
  const transportCfg = mergeTransport(app, options);
  const host = transportCfg.host || "127.0.0.1";
  const port = transportCfg.port ?? DEFAULT_HTTP_PORT;
  const mcpPath = normalizePath(transportCfg.mcpPath || "/mcp");
  const ssePath = normalizePath(transportCfg.ssePath || "/sse");
  const messagesPath = normalizePath(transportCfg.messagesPath || "/messages");
  const token = transportCfg.token;
  const tokenHeader = transportCfg.tokenHeader;

  const sessions = new Map<string, Session>();

  const httpServer = createServer(async (req, res) => {
    try {
      applyCors(res);
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);
      const pathname = normalizePath(url.pathname);

      if (req.method === "OPTIONS") {
        res.writeHead(204, corsHeaders());
        res.end();
        return;
      }

      if (pathname === "/health" && req.method === "GET") {
        writeJson(res, 200, {
          ok: true,
          app: APP_NAME,
          version: APP_VERSION,
          transport: { mcpPath, ssePath, messagesPath },
          ui: "/ui/",
        });
        return;
      }

      if (pathname === "/" && req.method === "GET") {
        res.writeHead(302, { Location: "/ui/" });
        res.end();
        return;
      }

      const uiRoot = resolveUiRoot();
      if (tryServeUi(req, res, pathname, uiRoot)) return;

      if (token && !isPartnerAppPath(pathname)) {
        const provided = extractToken(req, tokenHeader);
        if (!provided || !tokensEqual(provided, token)) {
          rejectUnauthorized(res);
          return;
        }
      }

      if (pathname === "/api" || pathname.startsWith("/api/")) {
        let parsed: unknown;
        try {
          parsed = req.method === "GET" || req.method === "HEAD" || req.method === "DELETE" ? undefined : await readJsonBody(req);
        } catch (err) {
          writeJson(res, 400, {
            ok: false,
            error: err instanceof Error ? err.message : "Invalid JSON body",
            code: "E_INVALID_ARGUMENT",
          });
          return;
        }
        const result = await handleConsoleRest(app, {
          method: req.method ?? "GET",
          pathname,
          query: url.searchParams,
          body: parsed,
          headers: flattenHeaders(req),
        });
        writeJson(res, result.status, result.body);
        return;
      }

      if (pathname === mcpPath) {
        await handleStreamable(req, res, app, sessions);
        return;
      }

      if (pathname === ssePath && req.method === "GET") {
        await handleSseOpen(req, res, app, sessions, messagesPath);
        return;
      }

      if (pathname === messagesPath && req.method === "POST") {
        const sessionId = url.searchParams.get("sessionId") ?? headerValue(req, "mcp-session-id");
        const session = sessionId ? sessions.get(sessionId) : undefined;
        if (!session || session.kind !== "sse") {
          writeJson(res, 404, { ok: false, error: "Unknown SSE session", code: "E_NOT_FOUND" });
          return;
        }
        await session.transport.handlePostMessage(req, res);
        return;
      }

      writeJson(res, 404, { ok: false, error: `No route for ${req.method} ${pathname}`, code: "E_NOT_FOUND" });
    } catch (err) {
      log("http transport error", { error: String(err) });
      if (!res.headersSent) {
        writeJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err), code: "E_PROTOCOL" });
      } else {
        res.end();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => resolve());
  });

  const addr = httpServer.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;
  const url = `http://${publicHost(host)}:${boundPort}`;

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    for (const [id, session] of [...sessions]) {
      sessions.delete(id);
      await app.releaseSessionServer(session.server);
    }
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
      httpServer.closeAllConnections?.();
    });
  };

  log("http/sse transport listening", { url, mcpPath, ssePath, ui: `${url}/ui/`, auth: Boolean(token) });
  return {
    httpServer,
    host,
    port: boundPort,
    url,
    mcpUrl: `${url}${mcpPath}`,
    sseUrl: `${url}${ssePath}`,
    uiUrl: `${url}/ui/`,
    apiUrl: `${url}/api`,
    mcpPath,
    ssePath,
    messagesPath,
    close,
  };
}

async function handleStreamable(
  req: IncomingMessage,
  res: ServerResponse,
  app: Everything2Mcp,
  sessions: Map<string, Session>,
): Promise<void> {
  const sessionId = headerValue(req, "mcp-session-id");
  if (sessionId) {
    const existing = sessions.get(sessionId);
    if (!existing || existing.kind !== "streamable") {
      writeJson(res, 404, { ok: false, error: "Unknown MCP session", code: "E_NOT_FOUND" });
      return;
    }
    const parsedBody = req.method === "POST" ? await readJsonBody(req) : undefined;
    await existing.transport.handleRequest(req, res, parsedBody);
    return;
  }

  if (req.method !== "POST") {
    writeJson(res, 400, { ok: false, error: "Missing mcp-session-id", code: "E_INVALID_ARGUMENT" });
    return;
  }

  const parsedBody = await readJsonBody(req);
  if (!isInitializeRequest(parsedBody)) {
    writeJson(res, 400, { ok: false, error: "Expected initialize request to start a session", code: "E_INVALID_ARGUMENT" });
    return;
  }

  const server = app.createSessionServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, { kind: "streamable", transport, server });
    },
  });
  // Register before connect so Protocol.connect chains this (must not call server.close()).
  transport.onclose = () => {
    const id = transport.sessionId;
    if (id) sessions.delete(id);
  };
  await server.connect(transport);
  await transport.handleRequest(req, res, parsedBody);
}

async function handleSseOpen(
  _req: IncomingMessage,
  res: ServerResponse,
  app: Everything2Mcp,
  sessions: Map<string, Session>,
  messagesPath: string,
): Promise<void> {
  const server = app.createSessionServer();
  const transport = new SSEServerTransport(messagesPath, res);
  sessions.set(transport.sessionId, { kind: "sse", transport, server });
  transport.onclose = () => {
    sessions.delete(transport.sessionId);
  };
  await server.connect(transport);
}

/** Start Streamable HTTP + SSE on a bound port. `http` and `sse` kinds share this listener. */
export async function attachHttp(app: Everything2Mcp, options?: HttpTransportOptions): Promise<HttpBinding> {
  return listenMcpHttp(app, options);
}

/** Alias of attachHttp: SSE is served on the same HTTP listener at `/sse`. */
export async function attachSse(app: Everything2Mcp, options?: HttpTransportOptions): Promise<HttpBinding> {
  return listenMcpHttp(app, options);
}

export async function startHttp(overrides: AppConfigOverrides = {}): Promise<Everything2McpHttp> {
  const app = await createEverything2McpServer(overrides);
  const http = await listenMcpHttp(app, overrides.transport);
  const originalClose = app.close;
  return {
    ...app,
    http,
    close: async () => {
      await http.close();
      await originalClose();
    },
  };
}

/** Same as startHttp — SSE and Streamable HTTP share one process listener. */
export const startSse = startHttp;
