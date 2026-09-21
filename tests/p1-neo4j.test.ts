import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AdapterError } from "../src/runtime/errors.js";
import { listenNeo4jHttpLoopback, Neo4jAdapter } from "../src/adapters/neo4j/index.js";

describe("P1 neo4j", () => {
  it("CREATE/MATCH plus allowWrite gate", async () => {
    const adapter = new Neo4jAdapter("g");
    await adapter.connect({ simulator: true, allowWrite: true });
    try {
      await adapter.invoke("cypher", { statement: "CREATE (n:Person {name: $name})", params: { name: "Ada" } });
      const matched = (await adapter.invoke("cypher", { statement: "MATCH (n:Person) RETURN n" })) as {
        records: unknown[];
      };
      assert.equal(matched.records.length, 1);
      const labels = (await adapter.invoke("list_labels", {})) as { labels: string[] };
      assert.ok(labels.labels.includes("Person"));
    } finally {
      await adapter.disconnect();
    }
  });

  it("allowWrite=false blocks CREATE; live bolt is E_UNSUPPORTED", async () => {
    const ro = new Neo4jAdapter("ro");
    await ro.connect({ simulator: true });
    try {
      await assert.rejects(
        () => ro.invoke("cypher", { statement: "CREATE (n:Person {name: $name})", params: { name: "Bob" } }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
      );
      const read = (await ro.invoke("cypher", { statement: "RETURN 1" })) as { records: unknown[] };
      assert.equal(read.records.length, 1);
    } finally {
      await ro.disconnect();
    }
    await assert.rejects(
      () => new Neo4jAdapter("live").connect({ url: "bolt://127.0.0.1:7687" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
  });

  it("HTTP transactional /db/neo4j/tx/commit loopback", async () => {
    const loop = await listenNeo4jHttpLoopback();
    const adapter = new Neo4jAdapter("g.http");
    try {
      await adapter.connect({ url: `http://127.0.0.1:${loop.port}`, allowWrite: true });
      await adapter.invoke("cypher", { statement: "CREATE (n:Person {name: $name})", params: { name: "Ada" } });
      const matched = (await adapter.invoke("cypher", { statement: "MATCH (n:Person) RETURN n" })) as {
        records: unknown[];
      };
      assert.equal(matched.records.length, 1);
      const labels = (await adapter.invoke("list_labels", {})) as { labels: string[] };
      assert.ok(labels.labels.includes("Person"));
    } finally {
      await adapter.disconnect();
      await loop.close();
    }
  });
});
