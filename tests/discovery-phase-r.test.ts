import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listenPromRemoteWrite } from "../src/adapters/prometheus/index.js";
import { fingerprintPrometheus } from "../src/discovery/fingerprint.js";
import { planBridge } from "../src/discovery/plan.js";
import { scanHost } from "../src/discovery/scan.js";
import { suggestFromCandidates } from "../src/discovery/suggest.js";

describe("Phase R discovery (Prometheus remote_write / plan allowWrite)", () => {
  it("fingerprints Prometheus /-/healthy and keeps allowWrite=false", async () => {
    const loop = await listenPromRemoteWrite();
    try {
      const hit = await fingerprintPrometheus("127.0.0.1", loop.port, 800);
      assert.equal(hit?.protocol, "prometheus");
      assert.equal((hit?.config as { allowWrite?: boolean }).allowWrite, false);
      const scanned = await scanHost({
        host: "127.0.0.1",
        port: loop.port,
        onlyGivenPort: true,
        protocols: ["prometheus"],
        timeoutMs: 800,
      });
      const suggestions = suggestFromCandidates(scanned);
      assert.equal(suggestions[0]?.protocol, "prometheus");
      assert.equal((suggestions[0]?.config as { allowWrite?: boolean }).allowWrite, false);
    } finally {
      await loop.close();
    }
  });

  it("plan_bridge Prometheus example stays read-only", () => {
    const plan = planBridge("Prometheus remote_write on host 10.9.8.7");
    const rec = plan.recommendations.find((r) => r.protocol === "prometheus");
    assert.ok(rec);
    assert.equal((rec?.exampleConfig as { allowWrite?: boolean }).allowWrite, false);
  });
});
