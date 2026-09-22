import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { McpBridgeAdapter } from "../src/adapters/mcp-bridge/index.js";
import { createEverything2McpServer } from "../src/control/server.js";
import { callManagementTool } from "../src/control/tools.js";
import { AdapterError } from "../src/runtime/errors.js";

describe("mcp_bridge 兜底", () => {
  it("imports fixture mcpServers with prefixed tools", async () => {
    const a = new McpBridgeAdapter("mcp_bridge:t");
    await a.connect({
      mcpServers: {
        demo: { command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] },
        notes: { command: "node", args: ["notes.js"] },
      },
    });
    const tools = await a.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("demo_describe"));
    assert.ok(names.includes("demo_ping"));
    assert.ok(names.includes("notes_ping"));
    const desc = (await a.invoke("demo_describe", {})) as { ingress: string; child: string; fallback: boolean };
    assert.equal(desc.ingress, "mcp_bridge");
    assert.equal(desc.child, "demo");
    assert.equal(desc.fallback, true);
    await a.disconnect();
  });

  it("live spawn is E_UNSUPPORTED", async () => {
    const a = new McpBridgeAdapter("mcp_bridge:live");
    await assert.rejects(
      () => a.connect({ mcpServers: { x: { command: "node" } }, liveSpawn: true }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
  });

  it("catalog prefix after capability_register", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "e2mcp-br-"));
    const app = await createEverything2McpServer({ dataDir });
    try {
      const ctx = { registry: app.registry, config: app.config, blacklist: app.blacklist, security: app.security };
      await callManagementTool(
        "capability_register",
        {
          protocol: "mcp_bridge",
          name: "imported",
          config: { mcpServers: { demo: { command: "node" } } },
          confirm: true,
        },
        ctx,
      );
      const names = app.registry.list().tools.map((t) => t.name);
      assert.ok(names.includes("mcp_bridge.imported.demo_ping"));
      const snap = app.registry.list().adapters.find((a) => a.id === "mcp_bridge:imported");
      assert.equal(snap?.ingress, "mcp_bridge");
    } finally {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("reads mcpServers from a file path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "e2mcp-brf-"));
    const file = join(dir, "mcp.json");
    await writeFile(file, JSON.stringify({ mcpServers: { fixture: { command: "echo" } } }));
    const a = new McpBridgeAdapter("mcp_bridge:file");
    try {
      await a.connect({ path: file });
      const tools = await a.listTools();
      assert.ok(tools.some((t) => t.name === "fixture_ping"));
    } finally {
      await a.disconnect();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
