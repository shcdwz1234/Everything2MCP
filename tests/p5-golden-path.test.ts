import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createEverything2McpServer } from "../src/control/server.js";
import { layerOf } from "../src/control/layers.js";

const specPath = fileURLToPath(new URL("../examples/petstore.openapi.json", import.meta.url));

describe("P5 golden path (agent autonomy)", () => {
  let dataDir: string;
  let close: () => Promise<void>;
  let client: Client;
  let httpPort = 0;
  let httpServer: ReturnType<typeof createServer>;
  let spec: string;

  before(async () => {
    spec = await readFile(specPath, "utf8");
    httpServer = createServer((req, res) => {
      if (req.url === "/openapi.json" || req.url === "/openapi.json/") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(spec);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    httpPort = await new Promise<number>((resolve) => {
      httpServer.listen(0, "127.0.0.1", () => {
        const addr = httpServer.address() as { port: number };
        resolve(addr.port);
      });
    });
    dataDir = await mkdtemp(join(tmpdir(), "e2mcp-p5-"));
    const app = await createEverything2McpServer({ dataDir });
    close = app.close;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "p5-agent", version: "0.0.0" });
    await Promise.all([app.server.connect(serverTransport), client.connect(clientTransport)]);
  });

  after(async () => {
    await client.close();
    await close();
    await new Promise<void>((resolve, reject) => httpServer.close((err) => (err ? reject(err) : resolve())));
    await rm(dataDir, { recursive: true, force: true });
  });

  it("plans → scans one host → add_from_discovery → health/explain, plus schema_import", async () => {
    const emptyHealth = JSON.parse(textOf(await client.callTool({ name: "mcp_health", arguments: {} })));
    assert.equal(emptyHealth.adapterCount, 0);
    assert.ok(Array.isArray(emptyHealth.hints) && emptyHealth.hints.some((h: string) => /Golden path/i.test(h)));
    assert.equal(emptyHealth.policy.allowWriteDefault, false);

    const planned = JSON.parse(
      textOf(
        await client.callTool({
          name: "mcp_plan_bridge",
          arguments: { goal: `Connect the OpenAPI REST API on host 127.0.0.1` },
        }),
      ),
    );
    assert.ok(planned.recommendations.some((r: { protocol: string }) => r.protocol === "openapi"));
    assert.equal(planned.host, "127.0.0.1");
    assert.ok(planned.steps.some((s: { tool: string }) => s.tool === "discovery_scan_host"));
    assert.ok(planned.steps.some((s: { tool: string }) => s.tool === "mcp_add_from_discovery"));
    assert.ok(planned.steps.some((s: { tool: string }) => s.tool === "mcp_health"));
    assert.ok(planned.steps.some((s: { tool: string }) => s.tool === "mcp_explain_tool"));
    assert.ok(planned.notes.some((n: string) => /allowWrite=false/.test(n)));
    assert.equal(planned.policy.allowWriteDefault, false);
    assert.ok(!JSON.stringify(planned.steps).includes('"pick"'));

    const scanned = JSON.parse(
      textOf(
        await client.callTool({
          name: "discovery_scan_host",
          arguments: {
            host: "127.0.0.1",
            port: httpPort,
            onlyGivenPort: true,
            protocols: ["openapi"],
          },
        }),
      ),
    );
    assert.ok(Array.isArray(scanned.suggestions) && scanned.suggestions.length >= 1);
    const suggestion = scanned.suggestions[0] as { protocol: string; name: string; config: Record<string, unknown> };
    assert.equal(suggestion.protocol, "openapi");

    const added = JSON.parse(
      textOf(
        await client.callTool({
          name: "mcp_add_from_discovery",
          arguments: { suggestion },
        }),
      ),
    );
    assert.equal(added.fromDiscovery, true);
    assert.ok(added.id.startsWith("openapi:"));
    assert.ok(Array.isArray(added.tools) && added.tools.some((t: string) => t.endsWith("listWidgets")));

    const health = JSON.parse(textOf(await client.callTool({ name: "mcp_health", arguments: { verbose: true } })));
    assert.equal(health.ok, true);
    assert.ok(health.adapterCount >= 1);
    assert.ok(health.toolLayers.business >= 1);
    assert.ok(health.toolLayers.management >= 1);

    const bizName = added.tools.find((t: string) => t.endsWith("listWidgets")) as string;
    const explained = JSON.parse(
      textOf(await client.callTool({ name: "mcp_explain_tool", arguments: { name: bizName } })),
    );
    assert.equal(explained.layer, "business");
    assert.equal(explained.protocol, "openapi");
    assert.equal(explained.localName, "listWidgets");

    const mgmt = JSON.parse(
      textOf(await client.callTool({ name: "mcp_explain_tool", arguments: { name: "mcp_plan_bridge" } })),
    );
    assert.equal(mgmt.layer, "management");

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

    await client.callTool({ name: "mcp_remove", arguments: { id: added.id } });
    await client.callTool({ name: "mcp_remove", arguments: { id: "openapi:fromschema" } });
  });

  it("separates management vs business layers in listTools and mcp_list", async () => {
    await client.callTool({
      name: "mcp_add",
      arguments: { protocol: "openapi", name: "layerdemo", config: { spec: specPath, baseUrl: "http://127.0.0.1:9" } },
    });
    try {
      const listed = await client.listTools();
      const mgmt = listed.tools.filter((t) => layerOf(t as { name: string; _meta?: { layer?: unknown } }) === "management");
      const biz = listed.tools.filter((t) => layerOf(t as { name: string; _meta?: { layer?: unknown } }) === "business");
      assert.ok(mgmt.some((t) => t.name === "mcp_list"));
      assert.ok(biz.some((t) => t.name === "openapi.layerdemo.listWidgets"));
      const mcpListTool = listed.tools.find((t) => t.name === "mcp_list") as {
        annotations?: { title?: string };
        _meta?: { layer?: string };
      };
      assert.equal(mcpListTool._meta?.layer, "management");
      assert.match(mcpListTool.annotations?.title ?? "", /Management/);

      const businessList = JSON.parse(textOf(await client.callTool({ name: "mcp_list", arguments: {} })));
      assert.equal(businessList.layer, "business");
      assert.ok(Array.isArray(businessList.management));
      assert.ok(businessList.management.includes("mcp_plan_bridge"));
      assert.ok(businessList.tools.every((t: { layer?: string; name: string }) => t.layer === "business" || t.name.includes(".")));
      assert.ok(!businessList.tools.some((t: { name: string }) => t.name === "mcp_add"));

      const managementList = JSON.parse(
        textOf(await client.callTool({ name: "mcp_list", arguments: { layer: "management" } })),
      );
      assert.equal(managementList.layer, "management");
      assert.ok(managementList.tools.some((t: { name: string }) => t.name === "discovery_scan_host"));
      assert.ok(!managementList.tools.some((t: { name: string }) => t.name.startsWith("openapi.")));

      const allList = JSON.parse(textOf(await client.callTool({ name: "mcp_list", arguments: { layer: "all" } })));
      assert.ok(allList.tools.some((t: { name: string }) => t.name === "mcp_health"));
      assert.ok(allList.tools.some((t: { name: string }) => t.name === "openapi.layerdemo.getWidget"));
    } finally {
      await client.callTool({ name: "mcp_remove", arguments: { id: "openapi:layerdemo" } });
    }
  });

  it("hints when add_from_discovery is missing config", async () => {
    const failed = await client.callTool({
      name: "mcp_add_from_discovery",
      arguments: { pick: 0 },
    });
    assert.equal(failed.isError, true);
    const payload = JSON.parse(textOf(failed));
    assert.match(payload.error ?? "", /suggestion object|not an index/i);
  });
});

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content.find((c) => c.type === "text");
  assert.ok(block?.text);
  return block.text;
}
