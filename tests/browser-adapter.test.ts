import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BrowserAdapter } from "../src/adapters/browser/index.js";
import { AdapterError } from "../src/runtime/errors.js";
import { evaluateLifecycle } from "../src/catalog/lifecycle.js";

describe("headless browser gated stub + allowDesktop", () => {
  it("default deny; even allowDesktop does not launch a browser", async () => {
    const a = new BrowserAdapter("browser:t");
    await a.connect({});
    await assert.rejects(
      () => a.invoke("navigate", { url: "https://example.test" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED" && /allowDesktop=false/.test((err as Error).message),
    );
    await a.disconnect();

    const b = new BrowserAdapter("browser:on");
    await b.connect({ allowDesktop: true });
    await assert.rejects(
      () => b.invoke("snapshot", {}),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED" && /does not launch/.test((err as Error).message),
    );
    await b.disconnect();
  });

  it("lifecycle: allowDesktop is not auto-eligible", () => {
    const decision = evaluateLifecycle({
      proposal: { protocol: "browser", name: "local", config: { allowDesktop: true } },
      mode: "safe",
      blacklisted: false,
      alreadyLive: false,
      validated: true,
    });
    assert.equal(decision.autoEligible, false);
    assert.equal(decision.state, "pending_confirm");
  });
});
