import { createEverything2McpServer, type Everything2Mcp } from "../control/index.js";
import type { AppConfigOverrides } from "../runtime/types.js";
import { attachStdio } from "./stdio.js";
import { listenMcpHttp, type HttpBinding } from "./http.js";

export { attachStdio } from "./stdio.js";
export { attachSse, attachHttp, listenMcpHttp, startHttp, startSse } from "./http.js";
export type { Everything2McpHttp, HttpBinding } from "./http.js";
export type { TransportKind, HttpTransportOptions, FutureHttpTransportOptions, McpServer } from "./types.js";

export type StartedApp = Everything2Mcp & { http?: HttpBinding };

/** Process entry helper: build the control plane then attach stdio. */
export async function startStdio(overrides: AppConfigOverrides = {}): Promise<Everything2Mcp> {
  const app = await createEverything2McpServer(overrides);
  await attachStdio(app.server);
  return app;
}

/** Pick stdio (default) or the HTTP/SSE listener from AppConfig.transport.kind. */
export async function startFromConfig(overrides: AppConfigOverrides = {}): Promise<StartedApp> {
  const app = await createEverything2McpServer(overrides);
  if (app.config.transport.kind === "stdio") {
    await attachStdio(app.server);
    return app;
  }
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
