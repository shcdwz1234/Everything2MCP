#!/usr/bin/env node
import "./runtime/webcrypto-polyfill.js";
import { startFromConfig } from "./transport/index.js";
import { log } from "./runtime/log.js";
import { APP_NAME, APP_VERSION } from "./runtime/types.js";

async function main(): Promise<void> {
  const app = await startFromConfig();
  if (app.http) {
    log(`${APP_NAME} ${APP_VERSION} ready on HTTP/SSE`, {
      url: app.http.url,
      mcp: app.http.mcpUrl,
      sse: app.http.sseUrl,
      ui: app.http.uiUrl,
      api: app.http.apiUrl,
      auth: Boolean(app.config.transport.token),
    });
    return;
  }
  log(`${APP_NAME} ${APP_VERSION} ready on stdio`, { dataDir: app.config.dataDir });
}

main().catch((err) => {
  console.error("[everything2mcp] fatal", err);
  process.exit(1);
});
