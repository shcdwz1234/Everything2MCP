import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listenKubernetesLoopback } from "../src/adapters/kubernetes/index.js";
import { listenRabbitmqLoopback } from "../src/adapters/rabbitmq/index.js";
import { listenSolrLoopback } from "../src/adapters/solr/index.js";
import { fingerprintKubernetes, fingerprintRabbitmq, fingerprintSolr } from "../src/discovery/fingerprint.js";
import { planBridge } from "../src/discovery/plan.js";
import { scanHost } from "../src/discovery/scan.js";
import { suggestFromCandidates } from "../src/discovery/suggest.js";

describe("Phase U discovery (Solr / RabbitMQ management / Kubernetes)", () => {
  it("fingerprints Solr and keeps allowWrite=false", async () => {
    const loop = await listenSolrLoopback();
    try {
      const hit = await fingerprintSolr("127.0.0.1", loop.port, 800);
      assert.equal(hit?.protocol, "solr");
      assert.equal((hit?.config as { allowWrite?: boolean }).allowWrite, false);
      const scanned = await scanHost({
        host: "127.0.0.1",
        port: loop.port,
        onlyGivenPort: true,
        protocols: ["solr"],
        timeoutMs: 800,
      });
      assert.equal(suggestFromCandidates(scanned)[0]?.protocol, "solr");
    } finally {
      await loop.close();
    }
  });

  it("fingerprints RabbitMQ management HTTP", async () => {
    const loop = await listenRabbitmqLoopback();
    try {
      const hit = await fingerprintRabbitmq("127.0.0.1", loop.port, 800);
      assert.equal(hit?.protocol, "rabbitmq");
      assert.equal((hit?.config as { allowWrite?: boolean }).allowWrite, false);
    } finally {
      await loop.close();
    }
  });

  it("fingerprints Kubernetes /version", async () => {
    const loop = await listenKubernetesLoopback();
    try {
      const hit = await fingerprintKubernetes("127.0.0.1", loop.port, 800);
      assert.equal(hit?.protocol, "kubernetes");
    } finally {
      await loop.close();
    }
  });

  it("plan_bridge Solr/RabbitMQ management/k8s stay read-default", () => {
    const solr = planBridge("Solr on host 10.9.8.7");
    assert.equal((solr.recommendations.find((r) => r.protocol === "solr")?.exampleConfig as { allowWrite?: boolean }).allowWrite, false);
    const rmq = planBridge("RabbitMQ management HTTP on host 10.9.8.7");
    assert.equal(
      (rmq.recommendations.find((r) => r.protocol === "rabbitmq")?.exampleConfig as { allowWrite?: boolean }).allowWrite,
      false,
    );
    const k8s = planBridge("k8s Kubernetes API on host 10.9.8.7");
    assert.equal(k8s.recommendations.find((r) => r.protocol === "kubernetes")?.exampleConfig.namespace, "default");
  });
});
