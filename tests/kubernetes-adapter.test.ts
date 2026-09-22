import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KubernetesAdapter, listenKubernetesLoopback } from "../src/adapters/kubernetes/index.js";
import { createAdapter, registerBuiltinAdapters } from "../src/adapters/index.js";
import { AdapterError } from "../src/runtime/errors.js";

registerBuiltinAdapters();

describe("KubernetesAdapter", () => {
  it("memory list/get; exec/apply stay E_UNSUPPORTED", async () => {
    const adapter = new KubernetesAdapter("k8s.mem");
    await adapter.connect({ simulator: true });
    try {
      const pods = (await adapter.invoke("list_pods", {})) as { items: Array<{ metadata: { name: string } }> };
      assert.ok(pods.items.some((p) => p.metadata.name === "web"));
      const pod = (await adapter.invoke("get_pod", { name: "web" })) as { kind: string };
      assert.equal(pod.kind, "Pod");
      const svc = (await adapter.invoke("get_service", { name: "web" })) as { kind: string };
      assert.equal(svc.kind, "Service");
      const cm = (await adapter.invoke("get_configmap", { name: "app" })) as { data: { LOG: string } };
      assert.equal(cm.data.LOG, "info");
      const logs = (await adapter.invoke("logs", { name: "web", tail: 10 })) as { lines: string[] };
      assert.ok(logs.lines.includes("nginx started"));
      await assert.rejects(
        () => adapter.invoke("exec", { name: "web", command: "ls" }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
      );
      await assert.rejects(
        () => adapter.invoke("apply", { manifest: { kind: "Pod" } }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
      );
    } finally {
      await adapter.disconnect();
    }
  });

  it("HTTP /api/v1 loopback + k8s alias", async () => {
    assert.equal(createAdapter("k8s", "alias").protocol, "kubernetes");
    const loop = await listenKubernetesLoopback();
    const adapter = new KubernetesAdapter("k8s.http");
    try {
      await adapter.connect({ url: `http://127.0.0.1:${loop.port}` });
      const pods = (await adapter.invoke("list_pods", { namespace: "default" })) as { items: unknown[] };
      assert.equal(pods.items.length, 1);
    } finally {
      await adapter.disconnect();
      await loop.close();
    }
  });
});
