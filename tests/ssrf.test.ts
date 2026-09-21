import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { AdapterError } from "../src/runtime/errors.js";
import { assertHostAllowed, assertUrlAllowed, fetchSafe, isBlockedHostname, isBlockedIp } from "../src/runtime/ssrf.js";

describe("SSRF guards", () => {
  it("blocks cloud metadata IPs and hostnames", () => {
    assert.equal(isBlockedIp("169.254.169.254"), true);
    assert.equal(isBlockedIp("169.254.170.2"), true);
    assert.equal(isBlockedIp("169.254.169.10"), true);
    assert.equal(isBlockedIp("127.0.0.1"), false);
    assert.equal(isBlockedIp("10.0.0.8"), false);
    assert.equal(isBlockedHostname("metadata.google.internal"), true);
    assert.equal(isBlockedHostname("localhost"), false);
  });

  it("refuses metadata URLs before fetch, including data-plane schemes", async () => {
    await assert.rejects(() => assertHostAllowed("169.254.169.254"), AdapterError);
    await assert.rejects(() => assertUrlAllowed("http://169.254.169.254/latest/meta-data"), AdapterError);
    await assert.rejects(() => assertUrlAllowed("http://metadata.google.internal/"), AdapterError);
    await assert.rejects(() => assertUrlAllowed("postgres://169.254.169.254/db"), AdapterError);
    await assert.rejects(() => assertUrlAllowed("mongodb://169.254.169.254:27017"), AdapterError);
    await assert.rejects(() => assertUrlAllowed("redis://169.254.169.254:6379"), AdapterError);
    const allowed = await assertUrlAllowed("http://127.0.0.1:9/openapi.json");
    assert.equal(allowed.hostname, "127.0.0.1");
  });

  it("blocks IPv6 link-local, mapped IMDS, 0.0.0.0, and userinfo URLs", async () => {
    assert.equal(isBlockedIp("fe80::1"), true);
    assert.equal(isBlockedIp("::ffff:169.254.169.254"), true);
    assert.equal(isBlockedIp("0.0.0.0"), true);
    await assert.rejects(() => assertUrlAllowed("http://user:pass@127.0.0.1/"), AdapterError);
    const fileOk = await assertUrlAllowed("file:///tmp/spec.json");
    assert.equal(fileOk.protocol, "file:");
  });

  it("fetchSafe aborts a hanging HTTP peer within timeoutMs", async () => {
    const hanging = createServer(() => {
      /* never respond */
    });
    const port = await new Promise<number>((resolve) => {
      hanging.listen(0, "127.0.0.1", () => {
        resolve((hanging.address() as { port: number }).port);
      });
    });
    try {
      const started = Date.now();
      await assert.rejects(() => fetchSafe(`http://127.0.0.1:${port}/`, { timeoutMs: 80 }));
      assert.ok(Date.now() - started < 2000);
    } finally {
      hanging.close();
    }
  });
});
