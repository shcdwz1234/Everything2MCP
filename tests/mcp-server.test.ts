import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createEverything2McpServer } from "../src/control/server.js";

const specPath = fileURLToPath(new URL("../examples/petstore.openapi.json", import.meta.url));

describe("MCP server management tools", () => {
  let dataDir: string;
  let close: () => Promise<void>;
  let client: Client;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "e2mcp-mcp-"));
    const app = await createEverything2McpServer({ dataDir });
    close = app.close;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([app.server.connect(serverTransport), client.connect(clientTransport)]);
  });

  after(async () => {
    await client.close();
    await close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("exposes management tools over MCP", async () => {
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name);
    for (const required of [
      "mcp_list",
      "mcp_add",
      "mcp_update",
      "mcp_remove",
      "mcp_query_by_protocol",
      "mcp_health",
      "mcp_explain_tool",
      "mcp_plan_bridge",
      "mcp_add_from_discovery",
      "schema_import",
      "discovery_suggest",
      "discovery_probe",
      "discovery_scan_host",
      "mcp_blacklist_list",
      "mcp_blacklist_add",
      "mcp_blacklist_remove",
      "environment_inventory",
      "capability_register",
      "capability_unregister",
      "capability_configure",
    ]) {
      assert.ok(names.includes(required), `missing ${required}`);
    }
  });

  it("adds an OpenAPI fixture and surfaces operations as tools", async () => {
    const added = await client.callTool({
      name: "mcp_add",
      arguments: {
        protocol: "openapi",
        name: "widgets",
        config: { spec: specPath, baseUrl: "http://127.0.0.1:9" },
      },
    });
    assert.equal(added.isError, undefined);
    const payload = JSON.parse(textOf(added));
    assert.equal(payload.id, "openapi:widgets");
    assert.ok(payload.tools.includes("openapi.widgets.listWidgets"));

    const tools = await client.listTools();
    assert.ok(tools.tools.some((t) => t.name === "openapi.widgets.getWidget"));

    const queried = await client.callTool({
      name: "mcp_query_by_protocol",
      arguments: { protocol: "openapi" },
    });
    const q = JSON.parse(textOf(queried));
    assert.equal(q.adapters.length, 1);

    await client.callTool({ name: "mcp_remove", arguments: { id: "openapi:widgets" } });
    const after = await client.listTools();
    assert.ok(!after.tools.some((t) => t.name.startsWith("openapi.widgets.")));
  });

  it("capability_unregister is the agent hot-delete path and drops tools without restart", async () => {
    const added = JSON.parse(
      textOf(
        await client.callTool({
          name: "capability_register",
          arguments: { protocol: "os_info", name: "mcpdel", config: { allowWrite: false }, confirm: true },
        }),
      ),
    );
    assert.equal(added.id, "os_info:mcpdel");
    const before = await client.listTools();
    assert.ok(before.tools.some((t) => t.name === "os_info.mcpdel.uname"));

    const gone = JSON.parse(
      textOf(await client.callTool({ name: "capability_unregister", arguments: { id: "os_info:mcpdel" } })),
    );
    assert.equal(gone.ok, true);
    assert.equal(gone.state, "unregistered");

    const after = await client.listTools();
    assert.ok(!after.tools.some((t) => t.name === "os_info.mcpdel.uname"));
  });

  it("plans, explains, health-checks, and schema_imports for agents", async () => {
    const planned = JSON.parse(
      textOf(await client.callTool({ name: "mcp_plan_bridge", arguments: { goal: "expose the OpenAPI spec on 127.0.0.1" } })),
    );
    assert.ok(planned.recommendations.some((r: { protocol: string }) => r.protocol === "openapi"));

    const imported = JSON.parse(
      textOf(
        await client.callTool({
          name: "schema_import",
          arguments: { source: specPath, name: "fromschema", register: true, config: { baseUrl: "http://127.0.0.1:9" } },
        }),
      ),
    );
    assert.equal(imported.registered, true);
    assert.equal(imported.id, "openapi:fromschema");

    const explained = JSON.parse(
      textOf(await client.callTool({ name: "mcp_explain_tool", arguments: { name: "openapi.fromschema.listWidgets" } })),
    );
    assert.equal(explained.protocol, "openapi");
    assert.equal(explained.localName, "listWidgets");

    const health = JSON.parse(textOf(await client.callTool({ name: "mcp_health", arguments: {} })));
    assert.equal(health.ok, true);
    assert.ok(health.toolCount >= 1);

    await client.callTool({ name: "mcp_remove", arguments: { id: "openapi:fromschema" } });
  });
});

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content.find((c) => c.type === "text");
  assert.ok(block?.text);
  return block.text;
}
