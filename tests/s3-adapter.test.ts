import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, it } from "node:test";
import { AdapterError } from "../src/runtime/errors.js";
import { S3Adapter, createMemoryS3 } from "../src/adapters/s3/index.js";
import { verifyAwsV4 } from "../src/adapters/sigv4.js";

describe("S3Adapter (P2 MinIO)", () => {
  it("rejects missing bucket", async () => {
    await assert.rejects(() => new S3Adapter("x").connect({}), /bucket/);
  });

  it("list/get/put/delete on the memory bucket when allowWrite=true", async () => {
    const adapter = new S3Adapter("bucket");
    await adapter.connect({ bucket: "artifacts", endpoint: "memory://", allowWrite: true });
    try {
      const names = (await adapter.listTools()).map((t) => t.name).sort();
      assert.deepEqual(names, ["delete", "get", "list", "put"]);
      await adapter.invoke("put", { key: "notes/hello.txt", body: "hi", contentType: "text/plain" });
      const listed = (await adapter.invoke("list", { prefix: "notes/" })) as {
        objects: Array<{ key: string; size: number }>;
      };
      assert.equal(listed.objects.length, 1);
      assert.equal(listed.objects[0]?.key, "notes/hello.txt");
      const got = (await adapter.invoke("get", { key: "notes/hello.txt" })) as { body: string };
      assert.equal(got.body, "hi");
      const del = (await adapter.invoke("delete", { key: "notes/hello.txt" })) as { deleted: boolean };
      assert.equal(del.deleted, true);
      await assert.rejects(() => adapter.invoke("get", { key: "notes/hello.txt" }), /not found/);
    } finally {
      await adapter.disconnect();
    }
  });

  it("defaults allowWrite=false and still allows list/get", async () => {
    const mem = createMemoryS3("artifacts");
    await mem.put("a.txt", "keep", "text/plain");
    const adapter = new S3Adapter("ro", async () => mem);
    await adapter.connect({ bucket: "artifacts" });
    try {
      const got = (await adapter.invoke("get", { key: "a.txt" })) as { body: string };
      assert.equal(got.body, "keep");
      await assert.rejects(
        () => adapter.invoke("put", { key: "b.txt", body: "nope" }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
      );
      await assert.rejects(
        () => adapter.invoke("delete", { key: "a.txt" }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
      );
      const health = await adapter.health();
      assert.match(health.detail ?? "", /allowWrite=false/);
    } finally {
      await adapter.disconnect();
    }
  });

  it("talks unsigned path-style HTTP to a local MinIO-shaped fake", async () => {
    const store = new Map<string, { body: string; type: string }>();
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const key = parts.slice(1).join("/");
      if (req.method === "GET" && !key) {
        const prefix = url.searchParams.get("prefix") ?? "";
        const items = [...store.entries()].filter(([k]) => k.startsWith(prefix));
        const xml = `<?xml version="1.0"?><ListBucketResult>${items
          .map(([k, v]) => `<Contents><Key>${k}</Key><Size>${Buffer.byteLength(v.body)}</Size></Contents>`)
          .join("")}</ListBucketResult>`;
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(xml);
        return;
      }
      if (req.method === "GET" && key) {
        const hit = store.get(key);
        if (!hit) {
          res.writeHead(404);
          res.end("NoSuchKey");
          return;
        }
        res.writeHead(200, { "content-type": hit.type });
        res.end(hit.body);
        return;
      }
      if (req.method === "PUT" && key) {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          store.set(key, {
            body: Buffer.concat(chunks).toString("utf8"),
            type: String(req.headers["content-type"] ?? "application/octet-stream"),
          });
          res.writeHead(200);
          res.end();
        });
        return;
      }
      if (req.method === "DELETE" && key) {
        store.delete(key);
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
    const adapter = new S3Adapter("minio");
    try {
      await adapter.connect({
        bucket: "artifacts",
        endpoint: `http://127.0.0.1:${port}`,
        unsigned: true,
        allowWrite: true,
        simulator: false,
      });
      await adapter.invoke("put", { key: "docs/a.txt", body: "minio" });
      const listed = (await adapter.invoke("list", { prefix: "docs/" })) as {
        objects: Array<{ key: string; size: number }>;
      };
      assert.equal(listed.objects[0]?.key, "docs/a.txt");
      assert.equal(listed.objects[0]?.size, 5);
      const got = (await adapter.invoke("get", { key: "docs/a.txt" })) as { body: string };
      assert.equal(got.body, "minio");
      await adapter.invoke("delete", { key: "docs/a.txt" });
      await assert.rejects(() => adapter.invoke("get", { key: "docs/a.txt" }), AdapterError);
    } finally {
      await adapter.disconnect();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it("signs PUT/GET/LIST with SigV4 against a verifying fake", async () => {
    const accessKey = "AKIATESTKEY";
    const secretKey = "testsecret";
    const store = new Map<string, string>();
    const seen: string[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const key = parts.slice(1).join("/");
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const extra: Record<string, string> = {};
        if (req.headers["content-type"]) extra["content-type"] = String(req.headers["content-type"]);
        const ok = verifyAwsV4(
          {
            method: req.method ?? "GET",
            url: url.toString(),
            body: body || undefined,
            headers: extra,
            amzDate: String(req.headers["x-amz-date"] ?? ""),
            authorization: String(req.headers.authorization ?? ""),
          },
          accessKey,
          secretKey,
        );
        if (!ok) {
          res.writeHead(403);
          res.end("SignatureDoesNotMatch");
          return;
        }
        seen.push(`${req.method} ${url.pathname}`);
        if (req.method === "GET" && !key) {
          const prefix = url.searchParams.get("prefix") ?? "";
          const items = [...store.entries()].filter(([k]) => k.startsWith(prefix));
          res.writeHead(200, { "content-type": "application/xml" });
          res.end(
            `<?xml version="1.0"?><ListBucketResult>${items
              .map(([k, v]) => `<Contents><Key>${k}</Key><Size>${Buffer.byteLength(v)}</Size></Contents>`)
              .join("")}</ListBucketResult>`,
          );
          return;
        }
        if (req.method === "GET" && key) {
          const hit = store.get(key);
          if (!hit) {
            res.writeHead(404);
            res.end("NoSuchKey");
            return;
          }
          res.writeHead(200);
          res.end(hit);
          return;
        }
        if (req.method === "PUT" && key) {
          store.set(key, body);
          res.writeHead(200);
          res.end();
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
    const adapter = new S3Adapter("sigv4");
    try {
      await adapter.connect({
        bucket: "artifacts",
        endpoint: `http://127.0.0.1:${port}`,
        accessKey,
        secretKey,
        region: "us-east-1",
        allowWrite: true,
        simulator: false,
      });
      const health = await adapter.health();
      assert.match(health.detail ?? "", /mode=sigv4/);
      await adapter.invoke("put", { key: "docs/a.txt", body: "signed" });
      const listed = (await adapter.invoke("list", { prefix: "docs/" })) as { objects: Array<{ key: string }> };
      assert.equal(listed.objects[0]?.key, "docs/a.txt");
      const got = (await adapter.invoke("get", { key: "docs/a.txt" })) as { body: string };
      assert.equal(got.body, "signed");
      assert.ok(seen.some((s) => s.startsWith("PUT")));
      assert.ok(seen.some((s) => s.startsWith("GET")));
    } finally {
      await adapter.disconnect();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
