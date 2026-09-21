import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AdapterError } from "../src/runtime/errors.js";
import { ElasticsearchAdapter, listenElasticsearchLoopback } from "../src/adapters/elasticsearch/index.js";
import { createAdapter, registerBuiltinAdapters } from "../src/adapters/index.js";

registerBuiltinAdapters();

describe("P1 elasticsearch / opensearch", () => {
  it("search/index with allowWrite gate", async () => {
    const adapter = new ElasticsearchAdapter("es");
    await adapter.connect({ simulator: true, allowWrite: true });
    try {
      await adapter.invoke("index_doc", { index: "logs", document: { level: "info", msg: "hi" } });
      const hit = (await adapter.invoke("search", { index: "logs", query: { term: { level: "info" } } })) as {
        hits: { total: number };
      };
      assert.equal(hit.hits.total, 1);
      const listed = (await adapter.invoke("list_indices", {})) as { indices: string[] };
      assert.ok(listed.indices.includes("logs"));
    } finally {
      await adapter.disconnect();
    }
  });

  it("opensearch alias + allowWrite=false + live url failure", async () => {
    const os = createAdapter("opensearch", "os");
    assert.equal(os.protocol, "opensearch");
    await os.connect({ simulator: true });
    try {
      await assert.rejects(
        () => os.invoke("index_doc", { index: "logs", document: { level: "info" } }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
      );
    } finally {
      await os.disconnect();
    }
    const dead = new ElasticsearchAdapter("live");
    await dead.connect({ url: "http://127.0.0.1:9" });
    try {
      await assert.rejects(
        () => dead.invoke("list_indices", {}),
        (err: unknown) => err instanceof Error,
      );
    } finally {
      await dead.disconnect();
    }
  });

  it("HTTP _search / _doc loopback", async () => {
    const loop = await listenElasticsearchLoopback();
    const adapter = new ElasticsearchAdapter("es.http");
    try {
      await adapter.connect({ url: `http://127.0.0.1:${loop.port}`, allowWrite: true });
      await adapter.invoke("index_doc", { index: "logs", id: "1", document: { level: "info" } });
      const hit = (await adapter.invoke("search", { index: "logs", query: { term: { level: "info" } } })) as {
        hits: { total: number };
      };
      assert.equal(hit.hits.total, 1);
    } finally {
      await adapter.disconnect();
      await loop.close();
    }
  });
});
