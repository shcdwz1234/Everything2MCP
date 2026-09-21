import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WhoisAdapter, listenWhoisLoopback } from "../src/adapters/whois/index.js";

describe("WhoisAdapter", () => {
  it("memory query hit and miss", async () => {
    const adapter = new WhoisAdapter("whois.mem");
    await adapter.connect({ simulator: true });
    try {
      const hit = (await adapter.invoke("query", { name: "example.test" })) as { text: string };
      assert.match(hit.text, /Domain Name: EXAMPLE.TEST/);
      const miss = (await adapter.invoke("query", { name: "nope.test" })) as { text: string };
      assert.match(miss.text, /No match/);
    } finally {
      await adapter.disconnect();
    }
  });

  it("TCP 43 loopback query", async () => {
    const loop = await listenWhoisLoopback();
    const adapter = new WhoisAdapter("whois.live");
    try {
      await adapter.connect({ host: "127.0.0.1", port: loop.port, timeoutMs: 800 });
      const hit = (await adapter.invoke("query", { name: "example.test" })) as { text: string };
      assert.match(hit.text, /Registrar: e2mcp/);
    } finally {
      await adapter.disconnect();
      await loop.close();
    }
  });
});
