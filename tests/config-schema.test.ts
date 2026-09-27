import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { registerBuiltinAdapters } from "../src/adapters/index.js";
import {
  allConfigSchemas,
  checkRequiredBySchema,
  configSchemaFor,
  missingRequiredFields,
  missingSecretFields,
} from "../src/catalog/config-schema.js";
import { canonicalProtocol, validateRegistration } from "../src/catalog/validate.js";
import { knownProtocols } from "../src/runtime/bootstrap.js";
import { startHttp } from "../src/transport/http.js";
import { EMPTY_OK, validConfig } from "./fixtures.js";

registerBuiltinAdapters();

function validates(protocol: string, config: Record<string, unknown>): boolean {
  try {
    validateRegistration(protocol, "x", config as never);
    return true;
  } catch {
    return false;
  }
}

describe("S1 per-adapter config schema", () => {
  it("has one schema per canonical protocol with title/ingress/fields", () => {
    const schemas = allConfigSchemas();
    const canon = new Set(knownProtocols().map((p) => canonicalProtocol(p)));
    assert.equal(schemas.length, canon.size);
    for (const s of schemas) {
      assert.ok(s.title, `title for ${s.protocol}`);
      assert.ok(["partner", "native", "mcp_bridge"].includes(s.ingress));
      assert.ok(s.fields.length > 0, `fields for ${s.protocol}`);
      assert.ok(s.fields.some((f) => f.key === "allowWrite" && f.default === false) || s.protocol === "mcp_bridge", `allowWrite for ${s.protocol}`);
    }
  });

  it("aliases resolve to the canonical schema", () => {
    assert.equal(configSchemaFor("http").protocol, "openapi");
    assert.equal(configSchemaFor("pg").protocol, canonicalProtocol("pg"));
  });

  it("schema required checks accept every validConfig fixture (parity with validate.ts)", () => {
    for (const protocol of knownProtocols()) {
      const cfg = validConfig(protocol);
      assert.equal(checkRequiredBySchema(protocol, cfg), undefined, `${protocol} fixture should pass schema`);
      assert.deepEqual(missingRequiredFields(protocol, cfg), [], `${protocol} fixture has no missing fields`);
    }
  });

  it("empty config: schema rejects exactly where validate.ts rejects", () => {
    for (const protocol of knownProtocols()) {
      const canon = canonicalProtocol(protocol);
      const schemaOk = checkRequiredBySchema(protocol, {}) === undefined;
      const validateOk = validates(protocol, {});
      assert.equal(schemaOk, validateOk, `${protocol}: schema=${schemaOk} validate=${validateOk}`);
      if (EMPTY_OK.has(canon)) assert.equal(validateOk, true);
    }
  });

  it("marks secrets and lists missing required fields for prompts", () => {
    const s3 = configSchemaFor("s3");
    assert.equal(s3.fields.find((f) => f.key === "secretKey")?.secret, true);
    assert.equal(s3.fields.find((f) => f.key === "bucket")?.required, true);
    assert.deepEqual(missingRequiredFields("s3", {}).map((f) => f.key), ["bucket"]);
    assert.deepEqual(missingSecretFields("s3", { bucket: "b" }).map((f) => f.key), ["secretKey"]);
    const grpc = configSchemaFor("grpc");
    assert.deepEqual(grpc.fields.find((f) => f.key === "proto")?.oneOf, ["proto", "protoInline", "reflection"]);
    assert.deepEqual(missingRequiredFields("grpc", { reflection: true }).map((f) => f.key), ["target"]);
  });
});

describe("S1 REST /api/protocols + validate + test connection", { timeout: 30_000 }, () => {
  it("serves schemas, validates configs, test-connects without persisting", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "e2m-s1-"));
    const app = await startHttp({ dataDir, transport: { kind: "http", port: 0, host: "127.0.0.1" } });
    try {
      const base = app.http.url;
      const list = (await (await fetch(`${base}/api/protocols`)).json()) as { protocols: Array<{ protocol: string }> };
      assert.ok(list.protocols.some((p) => p.protocol === "redis"));

      const one = await fetch(`${base}/api/protocols/redis`);
      assert.equal(one.status, 200);
      const body = (await one.json()) as { schema: { protocol: string; fields: Array<{ key: string; secret?: boolean }> } };
      assert.equal(body.schema.protocol, "redis");
      assert.equal(body.schema.fields.find((f) => f.key === "password")?.secret, true);

      const missing = await fetch(`${base}/api/protocols/nope`);
      assert.equal(missing.status, 400);

      const bad = (await (
        await fetch(`${base}/api/protocols/kafka/validate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config: {} }) })
      ).json()) as { ok: boolean; missing: string[]; error: string };
      assert.equal(bad.ok, false);
      assert.deepEqual(bad.missing, ["brokers"]);
      assert.match(bad.error, /brokers/);

      const good = (await (
        await fetch(`${base}/api/protocols/sqlite/validate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config: { filename: ":memory:" } }) })
      ).json()) as { ok: boolean };
      assert.equal(good.ok, true);

      const test = await fetch(`${base}/api/adapters/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ protocol: "s3", config: { bucket: "b", endpoint: "memory://" } }),
      });
      assert.equal(test.status, 200);
      const tb = (await test.json()) as { ok: boolean; toolCount: number };
      assert.equal(tb.ok, true);
      assert.ok(tb.toolCount > 0);
      const adapters = (await (await fetch(`${base}/api/adapters`)).json()) as { adapters: unknown[] };
      assert.equal(adapters.adapters.length, 0, "test connection must not persist");

      const meta = await fetch(`${base}/api/adapters/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ protocol: "openapi", config: { spec: "http://169.254.169.254/latest/meta-data" } }),
      });
      assert.notEqual(meta.status, 200, "metadata target refused before connect");
    } finally {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("S2 support: masked secrets are not persisted on PUT", { timeout: 30_000 }, () => {
  it("PUT with •••• keeps the stored secret; nested auth merges", async () => {
    const { unmaskConfig } = await import("../src/control/rest.js");
    const { SECRET_MASK } = await import("../src/control/redact.js");
    const merged = unmaskConfig(
      { secretKey: "real", auth: { type: "bearer", token: "t0" }, bucket: "a" },
      { secretKey: SECRET_MASK, auth: { type: "bearer", token: SECRET_MASK }, bucket: "b" },
    );
    assert.deepEqual(merged, { secretKey: "real", auth: { type: "bearer", token: "t0" }, bucket: "b" });

    const dataDir = await mkdtemp(join(tmpdir(), "e2m-s2-"));
    const app = await startHttp({ dataDir, transport: { kind: "http", port: 0, host: "127.0.0.1" } });
    try {
      const base = app.http.url;
      await fetch(`${base}/api/adapters`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ protocol: "s3", name: "v", config: { bucket: "b", endpoint: "memory://", secretKey: "keepme" } }),
      });
      const put = await fetch(`${base}/api/adapters/${encodeURIComponent("s3:v")}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: { bucket: "c", secretKey: SECRET_MASK } }),
      });
      assert.equal(put.status, 200);
      const rec = app.registry.getRecord("s3:v")!;
      assert.equal(rec.config.secretKey, "keepme");
      assert.equal(rec.config.bucket, "c");
    } finally {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
