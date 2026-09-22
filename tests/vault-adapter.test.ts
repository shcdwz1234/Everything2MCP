import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VaultAdapter, listenVaultLoopback } from "../src/adapters/vault/index.js";
import { createAdapter, registerBuiltinAdapters } from "../src/adapters/index.js";
import { AdapterError } from "../src/runtime/errors.js";
import { evaluateLifecycle } from "../src/catalog/lifecycle.js";

registerBuiltinAdapters();

describe("Vault / OpenBao read-only slice", () => {
  it("health and list_keys never dump secrets; read_secret gated", async () => {
    assert.equal(createAdapter("openbao", "x").protocol, "vault");
    const a = new VaultAdapter("vault:t");
    await a.connect({ simulator: true });
    const health = (await a.invoke("health", {})) as { initialized: boolean };
    assert.equal(health.initialized, true);
    const keys = (await a.invoke("list_keys", { mount: "secret/" })) as { keys: string[] };
    assert.ok(keys.keys.includes("app/db"));
    assert.ok(!JSON.stringify(keys).includes("s3cret"));
    await assert.rejects(
      () => a.invoke("read_secret", { path: "secret/data/app/db" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
    await a.disconnect();
  });

  it("allowReadSecrets can read simulator payload", async () => {
    const a = new VaultAdapter("vault:r");
    await a.connect({ simulator: true, allowReadSecrets: true });
    const secret = (await a.invoke("read_secret", { path: "secret/data/app/db" })) as { data: { password: string } };
    assert.equal(secret.data.password, "s3cret");
    await a.disconnect();
  });

  it("lifecycle: allowReadSecrets is not auto-eligible", () => {
    const decision = evaluateLifecycle({
      proposal: { protocol: "vault", name: "local", config: { simulator: true, allowReadSecrets: true } },
      mode: "safe",
      blacklisted: false,
      alreadyLive: false,
      validated: true,
    });
    assert.equal(decision.autoEligible, false);
    assert.equal(decision.state, "pending_confirm");
  });

  it("HTTP health loopback", async () => {
    const loop = await listenVaultLoopback();
    const a = new VaultAdapter("vault:http");
    try {
      await a.connect({ url: `http://127.0.0.1:${loop.port}` });
      const health = (await a.invoke("health", {})) as { initialized: boolean };
      assert.equal(health.initialized, true);
    } finally {
      await a.disconnect();
      await loop.close();
    }
  });
});
