import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AlertmanagerAdapter, listenAlertmanagerLoopback } from "../src/adapters/alertmanager/index.js";
import { AdapterError } from "../src/runtime/errors.js";

describe("Prometheus Alertmanager", () => {
  it("reads alerts; create_silence gated", async () => {
    const a = new AlertmanagerAdapter("am:t");
    await a.connect({ simulator: true });
    const alerts = (await a.invoke("alerts", {})) as { alerts: Array<{ fingerprint: string }> };
    assert.ok(alerts.alerts.length >= 1);
    await assert.rejects(
      () => a.invoke("create_silence", { comment: "nope" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
    await a.disconnect();
  });

  it("HTTP status loopback", async () => {
    const loop = await listenAlertmanagerLoopback();
    const a = new AlertmanagerAdapter("am:http");
    try {
      await a.connect({ url: `http://127.0.0.1:${loop.port}` });
      const st = (await a.invoke("status", {})) as { cluster: { status: string } };
      assert.equal(st.cluster.status, "ready");
    } finally {
      await a.disconnect();
      await loop.close();
    }
  });
});
