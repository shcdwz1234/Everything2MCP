import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const MISSING_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <title>Everything2MCP · UI not built</title>
  <style>
    body { margin:0; font:15px/1.5 ui-sans-serif,system-ui; background:#0B0F14; color:#e7eef4; }
    main { max-width:40rem; margin:12vh auto; padding:2rem; background:#121820; border:1px solid #1e2a36; }
    code { color:#3DD6C6; }
    a { color:#3DD6C6; }
  </style>
</head>
<body>
  <main>
    <p style="color:#3DD6C6;letter-spacing:.12em;text-transform:uppercase;font-size:11px">Everything2MCP</p>
    <h1>控制台尚未构建</h1>
    <p>运行 <code>npm run ui:build</code> 或 <code>npm run build</code>，产物写入 <code>dist/ui</code>，然后打开 <a href="/ui/">/ui/</a>。</p>
  </main>
</body>
</html>`;

export function resolveUiRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "../ui"),
    resolve(here, "../../dist/ui"),
    resolve(process.cwd(), "dist/ui"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "index.html"))) return dir;
  }
  return candidates[0]!;
}

function safeJoin(root: string, rel: string): string | undefined {
  const full = resolve(root, rel);
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (full !== root && !full.startsWith(prefix) && full !== root) return undefined;
  if (!full.startsWith(root)) return undefined;
  return full;
}

function sendFile(res: ServerResponse, file: string, status = 200): void {
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store, max-age=0" });
  createReadStream(file).pipe(res);
}

function sendHtml(res: ServerResponse, html: string, status = 200): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store, max-age=0" });
  res.end(html);
}

/** Serve the console SPA at `/ui` and `/ui/*`. Returns true if the request was handled. */
export function tryServeUi(req: IncomingMessage, res: ServerResponse, pathname: string, uiRoot: string): boolean {
  if (pathname !== "/ui" && !pathname.startsWith("/ui/")) return false;
  if (req.method && req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "method not allowed", code: "E_INVALID_ARGUMENT" }));
    return true;
  }

  let rel = pathname === "/ui" ? "index.html" : pathname.slice("/ui/".length);
  if (!rel || rel.endsWith("/")) rel += rel.endsWith("/") ? "index.html" : "index.html";

  const file = safeJoin(uiRoot, rel);
  if (file && existsSync(file) && statSync(file).isFile()) {
    sendFile(res, file);
    return true;
  }

  const index = join(uiRoot, "index.html");
  if (existsSync(index)) {
    sendFile(res, index);
    return true;
  }

  sendHtml(res, MISSING_HTML, 503);
  return true;
}
