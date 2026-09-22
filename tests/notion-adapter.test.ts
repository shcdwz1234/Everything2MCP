import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NotionAdapter, listenNotionLoopback } from "../src/adapters/notion/index.js";
import { AdapterError } from "../src/runtime/errors.js";

describe("notion native adapter", () => {
  it("search/read; create gated", async () => {
    const a = new NotionAdapter("notion:t");
    await a.connect({ simulator: true });
    const found = (await a.invoke("search", { query: "Partner" })) as { results: Array<{ id: string }> };
    assert.ok(found.results.length >= 1);
    const page = await a.invoke("get_page", { id: found.results[0]!.id });
    assert.ok(page);
    await assert.rejects(
      () => a.invoke("create_page", { title: "nope" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
    await a.disconnect();
  });

  it("HTTP loopback", async () => {
    const loop = await listenNotionLoopback();
    const a = new NotionAdapter("notion:http");
    try {
      await a.connect({ url: `http://127.0.0.1:${loop.port}` });
      const found = (await a.invoke("search", {})) as { results: unknown[] };
      assert.ok(found.results.length >= 1);
    } finally {
      await a.disconnect();
      await loop.close();
    }
  });
});
