import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listenSolrLoopback, SolrAdapter } from "../src/adapters/solr/index.js";
import { AdapterError } from "../src/runtime/errors.js";

describe("SolrAdapter", () => {
  it("memory select/update gated by allowWrite", async () => {
    const ro = new SolrAdapter("solr.ro");
    await ro.connect({ simulator: true });
    try {
      await assert.rejects(
        () => ro.invoke("update", { core: "docs", documents: [{ id: "1", title: "hi" }] }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
      );
    } finally {
      await ro.disconnect();
    }

    const adapter = new SolrAdapter("solr.mem");
    await adapter.connect({ simulator: true, allowWrite: true });
    try {
      await adapter.invoke("update", { core: "docs", documents: [{ id: "1", title: "hi" }] });
      const hit = (await adapter.invoke("select", { core: "docs", q: "title:hi" })) as { numFound: number };
      assert.equal(hit.numFound, 1);
      const cores = (await adapter.invoke("list_cores", {})) as { cores: string[] };
      assert.ok(cores.cores.includes("docs"));
    } finally {
      await adapter.disconnect();
    }
  });

  it("HTTP select/update loopback", async () => {
    const loop = await listenSolrLoopback();
    const adapter = new SolrAdapter("solr.http");
    try {
      await adapter.connect({ url: `http://127.0.0.1:${loop.port}`, allowWrite: true });
      await adapter.invoke("update", { core: "docs", documents: [{ id: "a", title: "ok" }] });
      const hit = (await adapter.invoke("select", { core: "docs", q: "*:*" })) as { numFound: number; docs: Array<{ id: string }> };
      assert.equal(hit.numFound, 1);
      assert.equal(hit.docs[0]?.id, "a");
    } finally {
      await adapter.disconnect();
      await loop.close();
    }
  });
});
