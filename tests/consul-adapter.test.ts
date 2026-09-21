import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { ConsulAdapter } from "../src/adapters/consul/index.js";
import { AdapterError } from "../src/runtime/errors.js";

describe("ConsulAdapter", () => {
  it("memory KV/catalog; put/delete gated by allowWrite", async () => {
    const adapter = new ConsulAdapter("consul.mem");
    await adapter.connect({ simulator: true });
    const missing = (await adapter.invoke("kv_get", { key: "app/x" })) as { missing?: boolean };
    assert.equal(missing.missing, true);
    const catalog = (await adapter.invoke("catalog_services", {})) as { services: string[] };
    assert.ok(catalog.services.includes("consul"));
    const health = (await adapter.invoke("health_service", { service: "consul" })) as {
      checks: Array<{ status: string }>;
    };
    assert.equal(health.checks[0]?.status, "passing");
    await assert.rejects(
      () => adapter.invoke("kv_put", { key: "app/x", value: "1" }),
      (err: unknown) => err instanceof AdapterError && /allowWrite/.test(String(err)),
    );
    await adapter.disconnect();

    const writer = new ConsulAdapter("consul.w");
    await writer.connect({ simulator: true, allowWrite: true });
    await writer.invoke("kv_put", { key: "app/x", value: "1" });
    const got = (await writer.invoke("kv_get", { key: "app/x" })) as { value: string };
    assert.equal(got.value, "1");
    const del = (await writer.invoke("kv_delete", { key: "app/x" })) as { deleted: boolean };
    assert.equal(del.deleted, true);
    await writer.disconnect();
  });

  it("HTTP /v1/kv + catalog against loopback", async () => {
    const kv = new Map<string, string>();
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.method === "GET" && url.pathname === "/v1/catalog/services") {
          res.end(JSON.stringify({ consul: [] }));
          return;
        }
        if (req.method === "GET" && url.pathname.startsWith("/v1/health/service/")) {
          res.end(JSON.stringify([{ Service: { Service: "consul", Address: "127.0.0.1" }, Checks: [{ Status: "passing" }] }]));
          return;
        }
        const m = url.pathname.match(/^\/v1\/kv\/(.+)$/);
        if (m) {
          const key = decodeURIComponent(m[1]!);
          if (req.method === "PUT") {
            kv.set(key, Buffer.concat(chunks).toString("utf8"));
            res.end("true");
            return;
          }
          if (req.method === "DELETE") {
            const ok = kv.delete(key);
            res.statusCode = ok ? 200 : 404;
            res.end(ok ? "true" : "");
            return;
          }
          const value = kv.get(key);
          if (value === undefined) {
            res.statusCode = 404;
            res.end("");
            return;
          }
          res.end(JSON.stringify([{ Key: key, Value: Buffer.from(value, "utf8").toString("base64") }]));
          return;
        }
        res.statusCode = 404;
        res.end("{}");
      });
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
    const adapter = new ConsulAdapter("consul.http");
    try {
      await adapter.connect({ url: `http://127.0.0.1:${port}`, allowWrite: true });
      await adapter.invoke("kv_put", { key: "k", value: "v" });
      const got = (await adapter.invoke("kv_get", { key: "k" })) as { value: string };
      assert.equal(got.value, "v");
      const catalog = (await adapter.invoke("catalog_services", {})) as { services: string[] };
      assert.ok(catalog.services.includes("consul"));
    } finally {
      await adapter.disconnect();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
