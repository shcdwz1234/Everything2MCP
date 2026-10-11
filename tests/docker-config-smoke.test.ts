import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_HTTP_PORT, loadAppConfig } from "../src/catalog/config.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("Docker / config smoke (unit, no daemon)", () => {
  it("Dockerfile binds 0.0.0.0, exposes 8742, healthchecks /health, runs as node", () => {
    const df = readFileSync(join(root, "Dockerfile"), "utf8");
    assert.match(df, /EVERYTHING2MCP_HTTP_HOST=0\.0\.0\.0/);
    assert.match(df, /EVERYTHING2MCP_HTTP_PORT=8742/);
    assert.match(df, /EXPOSE 8742/);
    assert.match(df, /HEALTHCHECK[\s\S]*\/health/);
    assert.match(df, /USER node/);
    assert.match(df, /EVERYTHING2MCP_HTTP_TOKEN/);
    assert.match(df, /CMD \["node", "dist\/index\.js"\]/);
  });

  it("compose maps host loopback only and surfaces HTTP_TOKEN", () => {
    const yml = readFileSync(join(root, "docker-compose.yml"), "utf8");
    assert.match(yml, /127\.0\.0\.1:8742:8742/);
    assert.match(yml, /EVERYTHING2MCP_HTTP_HOST:\s*"0\.0\.0\.0"/);
    assert.match(yml, /EVERYTHING2MCP_HTTP_TOKEN:\s*\$\{EVERYTHING2MCP_HTTP_TOKEN/);
    assert.match(yml, /EVERYTHING2MCP_TRANSPORT:\s*http/);
  });

  it(".dockerignore keeps secrets and local data out of the image context", () => {
    const ig = readFileSync(join(root, ".dockerignore"), "utf8");
    assert.match(ig, /^data$/m);
    assert.match(ig, /^\.env$/m);
    assert.match(ig, /^node_modules$/m);
  });

  it("loadAppConfig defaults are stdio + loopback + CIDR never allowed", () => {
    const cfg = loadAppConfig({});
    assert.equal(cfg.transport.kind, "stdio");
    assert.equal(cfg.transport.host, "127.0.0.1");
    assert.equal(cfg.transport.port, DEFAULT_HTTP_PORT);
    assert.equal(cfg.discovery.allowScan, false);
    assert.equal(cfg.transport.token, undefined);

    const http = loadAppConfig({
      EVERYTHING2MCP_TRANSPORT: "http",
      EVERYTHING2MCP_HTTP_HOST: "0.0.0.0",
      EVERYTHING2MCP_HTTP_TOKEN: "compose-token",
    });
    assert.equal(http.transport.kind, "http");
    assert.equal(http.transport.host, "0.0.0.0");
    assert.equal(http.transport.token, "compose-token");
  });
});
