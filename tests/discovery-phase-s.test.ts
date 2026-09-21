import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listenDnsLoopback } from "../src/adapters/dns/index.js";
import { fingerprintDns } from "../src/discovery/fingerprint.js";
import { planBridge } from "../src/discovery/plan.js";
import { scanHost } from "../src/discovery/scan.js";
import { suggestFromCandidates } from "../src/discovery/suggest.js";

describe("Phase S discovery (DNS / NATS / AMQP plan allowWrite)", () => {
  it("fingerprints unicast DNS QR and keeps allowWrite=false", async () => {
    const loop = await listenDnsLoopback();
    try {
      const hit = await fingerprintDns("127.0.0.1", loop.port, 800);
      assert.equal(hit?.protocol, "dns");
      assert.equal((hit?.config as { allowWrite?: boolean }).allowWrite, false);
      const scanned = await scanHost({
        host: "127.0.0.1",
        port: loop.port,
        onlyGivenPort: true,
        protocols: ["dns"],
        timeoutMs: 800,
      });
      const suggestions = suggestFromCandidates(scanned);
      assert.equal(suggestions[0]?.protocol, "dns");
      assert.equal((suggestions[0]?.config as { allowWrite?: boolean }).allowWrite, false);
    } finally {
      await loop.close();
    }
  });

  it("plan_bridge NATS/AMQP/DNS/GraphQL stay read-only", () => {
    const nats = planBridge("NATS JetStream on host 10.9.8.7");
    assert.equal(
      (nats.recommendations.find((r) => r.protocol === "nats")?.exampleConfig as { allowWrite?: boolean }).allowWrite,
      false,
    );
    const amqp = planBridge("AMQP RabbitMQ on host 10.9.8.7");
    assert.equal(
      (amqp.recommendations.find((r) => r.protocol === "amqp")?.exampleConfig as { allowWrite?: boolean }).allowWrite,
      false,
    );
    const dns = planBridge("DNS name server on host 10.9.8.7");
    assert.equal(
      (dns.recommendations.find((r) => r.protocol === "dns")?.exampleConfig as { allowWrite?: boolean }).allowWrite,
      false,
    );
    const gql = planBridge("GraphQL gql on host 10.9.8.7");
    assert.equal(
      (gql.recommendations.find((r) => r.protocol === "graphql")?.exampleConfig as { allowWrite?: boolean }).allowWrite,
      false,
    );
  });
});
