import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { OpenApiAdapter } from "../src/adapters/openapi/index.js";

const specPath = fileURLToPath(new URL("../examples/petstore.openapi.json", import.meta.url));

describe("OpenApiAdapter", () => {
  it("rejects missing spec", async () => {
    await assert.rejects(() => new OpenApiAdapter("o").connect({}), /spec/);
  });

  it("maps OpenAPI operations to MCP tool schemas", async () => {
    const adapter = new OpenApiAdapter("test");
    await adapter.connect({ spec: specPath, baseUrl: "http://127.0.0.1:9" });
    const tools = await adapter.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["createWidget", "deleteWidget", "getWidget", "listWidgets"]);

    const get = tools.find((t) => t.name === "getWidget");
    assert.ok(get);
    assert.equal(get.inputSchema.type, "object");
    assert.ok(get.inputSchema.required?.includes("id"));

    const create = tools.find((t) => t.name === "createWidget");
    assert.ok(create?.inputSchema.required?.includes("body"));
    await adapter.disconnect();
  });

  it("invokes mapped operations against a live HTTP fixture", async () => {
    const http = await listen((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/widgets") {
        json(res, 200, [{ id: "1", name: "alpha" }]);
        return;
      }
      if (req.method === "GET" && url.pathname === "/widgets/1") {
        json(res, 200, { id: "1", name: "alpha" });
        return;
      }
      if (req.method === "POST" && url.pathname === "/widgets") {
        json(res, 201, { id: "2", name: "beta" });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const adapter = new OpenApiAdapter("live");
    try {
      await adapter.connect({ spec: specPath, baseUrl: `http://127.0.0.1:${http.port}`, allowWrite: true });
      const list = (await adapter.invoke("listWidgets", { limit: 10 })) as {
        status: number;
        data: unknown;
      };
      assert.equal(list.status, 200);
      assert.deepEqual(list.data, [{ id: "1", name: "alpha" }]);

      const got = (await adapter.invoke("getWidget", { id: "1" })) as { status: number; data: unknown };
      assert.equal(got.status, 200);
      assert.deepEqual(got.data, { id: "1", name: "alpha" });

      const created = (await adapter.invoke("createWidget", { body: { name: "beta" } })) as {
        status: number;
      };
      assert.equal(created.status, 201);
      await assert.rejects(() => adapter.invoke("noSuchOp", {}), /Unknown OpenAPI operation/);
    } finally {
      await adapter.disconnect();
      await http.close();
    }
  });

  it("defaults allowWrite=false and blocks POST; GET still works", async () => {
    const http = await listen((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/widgets") {
        json(res, 200, [{ id: "1" }]);
        return;
      }
      json(res, 201, { id: "2" });
    });
    const adapter = new OpenApiAdapter("ro");
    try {
      await adapter.connect({ spec: specPath, baseUrl: `http://127.0.0.1:${http.port}` });
      const list = (await adapter.invoke("listWidgets", {})) as { status: number };
      assert.equal(list.status, 200);
      await assert.rejects(() => adapter.invoke("createWidget", { body: { name: "x" } }), /allowWrite/);
    } finally {
      await adapter.disconnect();
      await http.close();
    }
  });

  it("rejects tools before connect", async () => {
    const adapter = new OpenApiAdapter("idle");
    await assert.rejects(() => adapter.listTools(), /not connected/);
  });
});

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
