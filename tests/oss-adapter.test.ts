import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, it } from "node:test";
import { AdapterError } from "../src/runtime/errors.js";
import { OssAdapter, createMemoryOss } from "../src/adapters/oss/index.js";
import { verifyOss } from "../src/adapters/sigv4.js";

describe("OssAdapter", () => {
  it("rejects missing bucket", async () => {
    await assert.rejects(() => new OssAdapter("x").connect({}), /bucket/);
  });

  it("list/get/put/delete on the memory bucket when allowWrite=true", async () => {
    const adapter = new OssAdapter("bucket");
    await adapter.connect({ bucket: "artifacts", endpoint: "memory://", allowWrite: true });
    try {
      const names = (await adapter.listTools()).map((t) => t.name).sort();
      assert.deepEqual(names, ["delete", "get", "list", "put"]);
      await adapter.invoke("put", { key: "notes/hello.txt", body: "hi" });
      const listed = (await adapter.invoke("list", { prefix: "notes/" })) as {
        objects: Array<{ key: string }>;
      };
      assert.equal(listed.objects[0]?.key, "notes/hello.txt");
      const got = (await adapter.invoke("get", { key: "notes/hello.txt" })) as { body: string };
      assert.equal(got.body, "hi");
      await adapter.invoke("delete", { key: "notes/hello.txt" });
      await assert.rejects(() => adapter.invoke("get", { key: "notes/hello.txt" }), /not found/);
    } finally {
      await adapter.disconnect();
    }
  });

  it("defaults allowWrite=false and still allows list/get", async () => {
    const mem = createMemoryOss("artifacts");
    await mem.put("a.txt", "keep");
    const adapter = new OssAdapter("ro", async () => mem);
    await adapter.connect({ bucket: "artifacts" });
    try {
      const got = (await adapter.invoke("get", { key: "a.txt" })) as { body: string };
      assert.equal(got.body, "keep");
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

  it("talks unsigned path-style HTTP to an OSS-shaped fake", async () => {
    const store = new Map<string, { body: string; type: string }>();
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const key = parts.slice(1).join("/");
      res.setHeader("x-oss-request-id", "0001");
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
        req.on("data", (c) => chunks.push(c as Buffer));
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
    const adapter = new OssAdapter("aliyun");
    try {
      await adapter.connect({
        bucket: "artifacts",
        endpoint: `http://127.0.0.1:${port}`,
        unsigned: true,
        allowWrite: true,
        simulator: false,
      });
      await adapter.invoke("put", { key: "docs/a.txt", body: "oss" });
      const listed = (await adapter.invoke("list", { prefix: "docs/" })) as {
        objects: Array<{ key: string; size: number }>;
      };
      assert.equal(listed.objects[0]?.key, "docs/a.txt");
      const got = (await adapter.invoke("get", { key: "docs/a.txt" })) as { body: string };
      assert.equal(got.body, "oss");
      await adapter.invoke("delete", { key: "docs/a.txt" });
      await assert.rejects(() => adapter.invoke("get", { key: "docs/a.txt" }), AdapterError);
    } finally {
      await adapter.disconnect();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it("signs OSS AccessKey HMAC-SHA1 against a verifying fake", async () => {
    const accessKey = "LTAITEST";
    const secretKey = "osssecret";
    const store = new Map<string, string>();
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const key = parts.slice(1).join("/") || undefined;
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        const ok = verifyOss(
          {
            method: req.method ?? "GET",
            bucket: "artifacts",
            key,
            contentType: req.method === "PUT" ? String(req.headers["content-type"] ?? "") : undefined,
            date: String(req.headers.date ?? ""),
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
        const body = Buffer.concat(chunks).toString("utf8");
        if (req.method === "PUT" && key) {
          store.set(key, body);
          res.writeHead(200);
          res.end();
          return;
        }
        if (req.method === "GET" && key) {
          res.writeHead(200);
          res.end(store.get(key) ?? "");
          return;
        }
        if (req.method === "GET") {
          res.writeHead(200, { "content-type": "application/xml" });
          res.end(
            `<?xml version="1.0"?><ListBucketResult>${[...store.keys()]
              .map((k) => `<Contents><Key>${k}</Key><Size>1</Size></Contents>`)
              .join("")}</ListBucketResult>`,
          );
          return;
        }
        res.writeHead(204);
        res.end();
      });
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
    const adapter = new OssAdapter("signed");
    try {
      await adapter.connect({
        bucket: "artifacts",
        endpoint: `http://127.0.0.1:${port}`,
        accessKey,
        secretKey,
        allowWrite: true,
        simulator: false,
      });
      const health = await adapter.health();
      assert.match(health.detail ?? "", /mode=oss-sign/);
      await adapter.invoke("put", { key: "docs/a.txt", body: "ak" });
      const listed = (await adapter.invoke("list", {})) as { objects: Array<{ key: string }> };
      assert.equal(listed.objects[0]?.key, "docs/a.txt");
      const got = (await adapter.invoke("get", { key: "docs/a.txt" })) as { body: string };
      assert.equal(got.body, "ak");
    } finally {
      await adapter.disconnect();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
