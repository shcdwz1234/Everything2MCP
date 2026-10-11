import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { AdapterError } from "../src/runtime/errors.js";
import { assertConfigTargetsAllowed, assertHostProbeAllowed, assertProbeTarget } from "../src/control/policy.js";
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
  it("blocks Alibaba metadata, broadcast, and IMDS /24 siblings", () => {
    assert.equal(isBlockedIp("100.100.100.200"), true);
    assert.equal(isBlockedIp("169.254.169.253"), true);
    assert.equal(isBlockedIp("169.254.169.1"), true);
    assert.equal(isBlockedIp("255.255.255.255"), true);
    assert.equal(isBlockedIp("10.0.0.1"), false);
    assert.equal(isBlockedHostname("metadata.google.com"), true);
    assert.equal(isBlockedHostname("[fe80::abcd]"), true);
  });

  it("assertConfigTargetsAllowed refuses metadata URLs and host:port in mcp_add-shaped configs", async () => {
    await assert.rejects(
      () => assertConfigTargetsAllowed({ url: "http://169.254.169.254/latest/meta-data" }),
      AdapterError,
    );
    await assert.rejects(
      () => assertConfigTargetsAllowed({ endpoint: "redis://metadata.google.internal:6379" }),
      AdapterError,
    );
    await assert.rejects(
      () => assertConfigTargetsAllowed({ host: "169.254.169.254:80" }),
      AdapterError,
    );
    await assertConfigTargetsAllowed({ url: "http://127.0.0.1:9/openapi.json", allowWrite: false });
    await assertConfigTargetsAllowed({ spec: "./examples/petstore.openapi.json" });
  });

  it("assertHostProbeAllowed / assertProbeTarget refuse CIDR even when allowScan is true", async () => {
    assert.throws(() => assertHostProbeAllowed("10.0.0.0/8", true), AdapterError);
    assert.throws(() => assertHostProbeAllowed("192.168.0.*", true), AdapterError);
    await assert.rejects(() => assertProbeTarget("169.254.169.254", true), AdapterError);
  });

  it("fetchSafe refuses a redirect hop that lands on link-local metadata", async () => {
    const bounce = createServer((req, res) => {
      res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data" });
      res.end();
    });
    const port = await new Promise((resolve) => {
      bounce.listen(0, "127.0.0.1", () => {
        resolve(bounce.address().port);
      });
    });
    try {
      await assert.rejects(
        () => fetchSafe("http://127.0.0.1:" + port + "/", { timeoutMs: 500 }),
        (err) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
      );
    } finally {
      bounce.close();
    }
  });
});
