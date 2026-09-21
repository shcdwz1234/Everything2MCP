import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listenCassandraNative } from "../src/adapters/cassandra/index.js";
import { listenCouchLoopback } from "../src/adapters/couchdb/index.js";
import { listenNeo4jHttpLoopback } from "../src/adapters/neo4j/index.js";
import { listenWhoisLoopback } from "../src/adapters/whois/index.js";
import { fingerprintCassandra, fingerprintCouchdb, fingerprintNeo4jHttp, fingerprintWhois } from "../src/discovery/fingerprint.js";
import { planBridge } from "../src/discovery/plan.js";
import { scanHost } from "../src/discovery/scan.js";
import { suggestFromCandidates } from "../src/discovery/suggest.js";

describe("Phase T discovery (Cassandra / CouchDB / Whois / Neo4j HTTP)", () => {
  it("fingerprints Cassandra READY and keeps allowWrite=false", async () => {
    const loop = await listenCassandraNative();
    try {
      const hit = await fingerprintCassandra("127.0.0.1", loop.port, 800);
      assert.equal(hit?.protocol, "cassandra");
      assert.equal((hit?.config as { allowWrite?: boolean }).allowWrite, false);
      const scanned = await scanHost({
        host: "127.0.0.1",
        port: loop.port,
        onlyGivenPort: true,
        protocols: ["cassandra"],
        timeoutMs: 800,
      });
      const suggestions = suggestFromCandidates(scanned);
      assert.equal(suggestions[0]?.protocol, "cassandra");
      assert.equal((suggestions[0]?.config as { allowWrite?: boolean }).allowWrite, false);
    } finally {
      await loop.close();
    }
  });

  it("fingerprints CouchDB Welcome", async () => {
    const loop = await listenCouchLoopback();
    try {
      const hit = await fingerprintCouchdb("127.0.0.1", loop.port, 800);
      assert.equal(hit?.protocol, "couchdb");
      assert.equal((hit?.config as { allowWrite?: boolean }).allowWrite, false);
    } finally {
      await loop.close();
    }
  });

  it("fingerprints Whois Domain Name", async () => {
    const loop = await listenWhoisLoopback();
    try {
      const hit = await fingerprintWhois("127.0.0.1", loop.port, 800);
      assert.equal(hit?.protocol, "whois");
    } finally {
      await loop.close();
    }
  });

  it("fingerprints Neo4j HTTP transactional root", async () => {
    const loop = await listenNeo4jHttpLoopback();
    try {
      const hit = await fingerprintNeo4jHttp("127.0.0.1", loop.port, 800);
      assert.equal(hit?.protocol, "neo4j");
      assert.equal((hit?.config as { allowWrite?: boolean }).allowWrite, false);
    } finally {
      await loop.close();
    }
  });

  it("plan_bridge Cassandra/CouchDB/Whois stay read-only", () => {
    const cass = planBridge("Cassandra CQL on host 10.9.8.7");
    assert.equal(
      (cass.recommendations.find((r) => r.protocol === "cassandra")?.exampleConfig as { allowWrite?: boolean }).allowWrite,
      false,
    );
    const couch = planBridge("CouchDB on host 10.9.8.7");
    assert.equal(
      (couch.recommendations.find((r) => r.protocol === "couchdb")?.exampleConfig as { allowWrite?: boolean }).allowWrite,
      false,
    );
    const neo = planBridge("Neo4j cypher on host 10.9.8.7");
    assert.equal((neo.recommendations.find((r) => r.protocol === "neo4j")?.exampleConfig as { allowWrite?: boolean }).allowWrite, false);
    assert.match(String(neo.recommendations.find((r) => r.protocol === "neo4j")?.exampleConfig.url), /^http:/);
  });
});
