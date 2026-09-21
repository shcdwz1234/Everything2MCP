import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AdapterError } from "../src/runtime/errors.js";
import { QdrantAdapter } from "../src/adapters/qdrant/index.js";

describe("P1 qdrant (not chromadb)", () => {
  it("upsert/search cosine", async () => {
    const adapter = new QdrantAdapter("v");
    await adapter.connect({ simulator: true, allowWrite: true });
    try {
      await adapter.invoke("upsert", {
        collection: "docs",
        points: [
          { id: 1, vector: [1, 0], payload: { text: "a" } },
          { id: 2, vector: [0, 1], payload: { text: "b" } },
        ],
      });
      const hits = (await adapter.invoke("search", { collection: "docs", vector: [1, 0.1], limit: 1 })) as {
        hits: Array<{ id: number }>;
      };
      assert.equal(hits.hits[0]?.id, 1);
      const desc = (await adapter.invoke("describe", { collection: "docs" })) as { points: number };
      assert.equal(desc.points, 2);
    } finally {
      await adapter.disconnect();
    }
  });

  it("allowWrite=false blocks upsert; live url is E_UNSUPPORTED", async () => {
    const ro = new QdrantAdapter("ro");
    await ro.connect({ simulator: true });
    try {
      await assert.rejects(
        () =>
          ro.invoke("upsert", {
            collection: "docs",
            points: [{ id: 1, vector: [1, 0], payload: {} }],
          }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
      );
    } finally {
      await ro.disconnect();
    }
    await assert.rejects(
      () => new QdrantAdapter("live").connect({ url: "http://127.0.0.1:6333" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
  });
});
