import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { fingerprintAlertmanager, fingerprintDockerEngine, fingerprintVault } from "../src/discovery/fingerprint.js";

describe("Phase P1 discovery fingerprints", () => {
  it("vault / alertmanager / docker engine HTTP fingerprints (no secrets)", async () => {
    const server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url?.startsWith("/v1/sys/health")) {
        res.end(JSON.stringify({ initialized: true, sealed: false, version: "1.15" }));
        return;
      }
      if (req.url?.startsWith("/api/v2/status")) {
        res.end(JSON.stringify({ cluster: { status: "ready" }, versionInfo: { version: "0.27" } }));
        return;
      }
      if (req.url?.startsWith("/version")) {
        res.end(JSON.stringify({ ApiVersion: "1.45", platform: { name: "docker" } }));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const vault = await fingerprintVault("127.0.0.1", port, 500);
      assert.equal(vault?.protocol, "vault");
      assert.equal((vault?.config as { allowReadSecrets?: boolean })?.allowReadSecrets, false);
      const am = await fingerprintAlertmanager("127.0.0.1", port, 500);
      assert.equal(am?.protocol, "alertmanager");
      const docker = await fingerprintDockerEngine("127.0.0.1", port, 500);
      assert.equal(docker?.protocol, "docker");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
