import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DnsAdapter, listenDnsLoopback } from "../src/adapters/dns/index.js";
import { AdapterError } from "../src/runtime/errors.js";

describe("DnsAdapter", () => {
  it("memory A/TXT query; unknown type E_UNSUPPORTED", async () => {
    const adapter = new DnsAdapter("dns.mem");
    await adapter.connect({ simulator: true });
    try {
      const a = (await adapter.invoke("query", { name: "example.test", type: "A" })) as {
        answers: Array<{ data: string }>;
      };
      assert.equal(a.answers[0]?.data, "127.0.0.1");
      const txt = (await adapter.invoke("query", { name: "example.test", type: "TXT" })) as {
        answers: Array<{ data: string }>;
      };
      assert.equal(txt.answers[0]?.data, "everything2mcp");
      const miss = (await adapter.invoke("query", { name: "nope.test", type: "A" })) as { answers: unknown[] };
      assert.equal(miss.answers.length, 0);
      await assert.rejects(
        () => adapter.invoke("query", { name: "example.test", type: "MX" }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
      );
    } finally {
      await adapter.disconnect();
    }
  });

  it("UDP loopback A query", async () => {
    const loop = await listenDnsLoopback();
    const adapter = new DnsAdapter("dns.live");
    try {
      await adapter.connect({ host: "127.0.0.1", port: loop.port, timeoutMs: 800 });
      const got = (await adapter.invoke("query", { name: "example.test", type: "A" })) as {
        answers: Array<{ data: string }>;
      };
      assert.equal(got.answers[0]?.data, "127.0.0.1");
    } finally {
      await adapter.disconnect();
      await loop.close();
    }
  });
});
