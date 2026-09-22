import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scanCompat } from "../src/discovery/compat.js";
import { COMPAT_CATALOG } from "../src/discovery/compat-catalog.js";

describe("compat_scan", () => {
  it("returns structured suggestions with ingress and never opens write", () => {
    const result = scanCompat({
      installed: ["feishu", "gh"],
      env: { SLACK_BOT_TOKEN: "x", PATH: "/usr/bin" },
      home: "/tmp/e2mcp-compat-home-does-not-exist",
      fsExists: () => false,
      partnerIds: ["partner:demo_chat"],
      ports: [],
    });
    assert.equal(result.ok, true);
    assert.ok(result.suggestions.length >= 3);
    assert.ok(result.suggestions.every((s) => s.config.allowWrite !== true));
    assert.ok(result.suggestions.every((s) => s.config.allowDesktop !== true));
    assert.ok(result.suggestions.some((s) => s.ingress === "native" && s.protocol === "feishu" && s.priority === "P0"));
    assert.ok(result.suggestions.some((s) => s.ingress === "native" && s.protocol === "github"));
    assert.ok(result.suggestions.some((s) => s.ingress === "native" && s.protocol === "slack" && s.priority === "P1"));
    assert.ok(result.suggestions.some((s) => s.ingress === "partner" && s.priority === "P0"));
    assert.deepEqual(result.policy.southboundPriority, ["partner", "native", "mcp_bridge"]);
    assert.ok(result.deferred.some((d) => d.priority === "P4"));
    assert.ok(result.catalog.some((c) => c.appId === "personal_wechat"));
    assert.ok(COMPAT_CATALOG.some((c) => c.appId === "wecom" && c.gaps.some((g) => /个人微信|Personal WeChat/i.test(g))));
    assert.ok(result.policy.scanDoesNotGrant.includes("allowWrite"));
  });

  it("marks mcpServers files as P3 bridge 兜底 only", () => {
    const result = scanCompat({
      home: "/tmp/fake-home",
      fsExists: (p) => p.endsWith(".cursor/mcp.json"),
      fsRead: () => JSON.stringify({ mcpServers: { fs: { command: "npx" } } }),
      installed: [],
      env: {},
    });
    const bridge = result.suggestions.filter((s) => s.ingress === "mcp_bridge");
    assert.ok(bridge.length >= 1);
    assert.ok(bridge.every((s) => s.priority === "P3" && s.fallback === true));
    assert.ok(result.mcpBridgeCandidates.some((c) => c.kind === "cursor"));
  });
});
