import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AdapterError } from "../src/runtime/errors.js";
import { loadPemFromConfig, loadTlsMaterial, watchTlsMaterial } from "../src/adapters/tls-material.js";
import { credentialsFromConfig } from "../src/adapters/grpc/index.js";

describe("TLS material (reconnect reload)", () => {
  it("reads inline PEM and file paths; reconnect re-reads the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "e2mcp-tls-"));
    const caPath = join(dir, "ca.pem");
    try {
      await writeFile(caPath, "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n");
      const first = loadPemFromConfig({ caFile: caPath }, ["caFile"], "grpc");
      assert.equal(first?.source, "file");
      assert.match(first!.buffer.toString("utf8"), /AAAA/);

      await writeFile(caPath, "-----BEGIN CERTIFICATE-----\nBBBB\n-----END CERTIFICATE-----\n");
      const second = loadPemFromConfig({ caFile: caPath }, ["caFile"], "grpc");
      assert.match(second!.buffer.toString("utf8"), /BBBB/);

      const inline = loadPemFromConfig(
        { ca: "-----BEGIN CERTIFICATE-----\nCCCC\n-----END CERTIFICATE-----" },
        ["ca"],
        "grpc",
      );
      assert.equal(inline?.source, "inline");

      const material = loadTlsMaterial({ caFile: caPath }, "grpc");
      assert.deepEqual(material.filePaths, [caPath]);
      assert.match(material.note, /watchTlsMaterial|mcp_update/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects missing files and cert-without-key; grpc credentials reuse the helper", () => {
    assert.throws(
      () => loadTlsMaterial({ tls: true, ca: "/no/such/ca.pem" }, "grpc"),
      (err: unknown) => err instanceof AdapterError && err.code === "E_INVALID_CONFIG",
    );
    assert.throws(
      () =>
        loadTlsMaterial(
          { cert: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----" },
          "grpc",
        ),
      /both cert and key/,
    );
    assert.throws(
      () => credentialsFromConfig({ tls: true, ca: "/no/such/ca.pem" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_INVALID_CONFIG",
    );
    assert.ok(credentialsFromConfig({ tls: false }));
  });

  it("watchTlsMaterial re-reads PEM files and records a readable failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "e2mcp-tls-watch-"));
    const caPath = join(dir, "ca.pem");
    await writeFile(caPath, "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n");
    const handle = watchTlsMaterial({ caFile: caPath }, "grpc");
    try {
      assert.equal(handle.watching, true);
      assert.equal(handle.generations, 1);
      assert.match(handle.get().ca!.buffer.toString("utf8"), /AAAA/);
      await writeFile(caPath, "-----BEGIN CERTIFICATE-----\nBBBB\n-----END CERTIFICATE-----\n");
      await new Promise((r) => setTimeout(r, 80));
      assert.match(handle.get().ca!.buffer.toString("utf8"), /BBBB/);
      assert.ok(handle.generations >= 2);
      assert.equal(handle.lastError, undefined);
      await rm(caPath);
      await new Promise((r) => setTimeout(r, 80));
      assert.ok(handle.lastError);
      assert.equal(handle.lastError.code, "E_INVALID_CONFIG");
    } finally {
      handle.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
