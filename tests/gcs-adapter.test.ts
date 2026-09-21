import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, it } from "node:test";
import { AdapterError } from "../src/runtime/errors.js";
import { GcsAdapter, createMemoryGcs } from "../src/adapters/gcs/index.js";

describe("GcsAdapter", () => {
  it("rejects missing bucket", async () => {
    await assert.rejects(() => new GcsAdapter("x").connect({}), /bucket/);
  });

  it("list/get/put/delete on the memory bucket when allowWrite=true", async () => {
    const adapter = new GcsAdapter("bucket");
    await adapter.connect({ bucket: "artifacts", endpoint: "memory://", allowWrite: true });
    try {
      const names = (await adapter.listTools()).map((t) => t.name).sort();
      assert.deepEqual(names, ["delete", "get", "list", "put"]);
      await adapter.invoke("put", { key: "notes/hello.txt", body: "hi", contentType: "text/plain" });
      const listed = (await adapter.invoke("list", { prefix: "notes/" })) as {
        objects: Array<{ key: string; size: number }>;
      };
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
    const mem = createMemoryGcs("artifacts");
    await mem.put("a.txt", "keep", "text/plain");
    const adapter = new GcsAdapter("ro", async () => mem);
    await adapter.connect({ bucket: "artifacts" });
    try {
      const got = (await adapter.invoke("get", { key: "a.txt" })) as { body: string };
      assert.equal(got.body, "keep");
      await assert.rejects(
        () => adapter.invoke("put", { key: "b.txt", body: "nope" }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
      );
      const health = await adapter.health();
      assert.match(health.detail ?? "", /allowWrite=false/);
    } finally {
      await adapter.disconnect();
    }
  });

  it("rejects signed live GCS without unsigned mock", async () => {
    await assert.rejects(
      () =>
        new GcsAdapter("live").connect({
          bucket: "artifacts",
          endpoint: "https://storage.googleapis.com",
          simulator: false,
        }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
  });

  it("talks unsigned JSON HTTP to a fake-gcs-shaped server", async () => {
    const store = new Map<string, { body: string; type: string }>();
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const json = (code: number, body: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "GET" && url.pathname.endsWith("/o") && !url.searchParams.get("alt")) {
        const prefix = url.searchParams.get("prefix") ?? "";
        const items = [...store.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([name, v]) => ({ name, size: Buffer.byteLength(v.body), contentType: v.type }));
        json(200, { kind: "storage#objects", items });
        return;
      }
      if (req.method === "GET" && url.searchParams.get("alt") === "media") {
        const key = decodeURIComponent(url.pathname.split("/o/")[1] ?? "");
        const hit = store.get(key);
        if (!hit) {
          res.writeHead(404);
          res.end("not found");
          return;
        }
        res.writeHead(200, { "content-type": hit.type });
        res.end(hit.body);
        return;
      }
      if (req.method === "POST" && url.pathname.includes("/upload/storage/v1/b/")) {
        const key = url.searchParams.get("name") ?? "";
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c as Buffer));
        req.on("end", () => {
          store.set(key, {
            body: Buffer.concat(chunks).toString("utf8"),
            type: String(req.headers["content-type"] ?? "application/octet-stream"),
          });
          json(200, { name: key });
        });
        return;
      }
      if (req.method === "DELETE") {
        const key = decodeURIComponent(url.pathname.split("/o/")[1] ?? "");
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
    const adapter = new GcsAdapter("emu");
    try {
      await adapter.connect({
        bucket: "artifacts",
        endpoint: `http://127.0.0.1:${port}`,
        unsigned: true,
        allowWrite: true,
        simulator: false,
      });
      await adapter.invoke("put", { key: "docs/a.txt", body: "gcs" });
      const listed = (await adapter.invoke("list", { prefix: "docs/" })) as {
        objects: Array<{ key: string }>;
      };
      assert.equal(listed.objects[0]?.key, "docs/a.txt");
      const got = (await adapter.invoke("get", { key: "docs/a.txt" })) as { body: string };
      assert.equal(got.body, "gcs");
      await adapter.invoke("delete", { key: "docs/a.txt" });
      await assert.rejects(() => adapter.invoke("get", { key: "docs/a.txt" }), AdapterError);
    } finally {
      await adapter.disconnect();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it("sends Bearer token on the GCS JSON path", async () => {
    let auth = "";
    const store = new Map<string, string>();
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      auth = String(req.headers.authorization ?? "");
      if (!auth.startsWith("Bearer ")) {
        res.writeHead(401);
        res.end("login");
        return;
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "POST" && url.pathname.includes("/upload/")) {
        const key = url.searchParams.get("name") ?? "";
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c as Buffer));
        req.on("end", () => {
          store.set(key, Buffer.concat(chunks).toString("utf8"));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ name: key }));
        });
        return;
      }
      if (req.method === "GET" && url.searchParams.get("alt") === "media") {
        const key = decodeURIComponent(url.pathname.split("/o/")[1] ?? "");
        res.writeHead(200);
        res.end(store.get(key) ?? "");
        return;
      }
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ items: [...store.keys()].map((name) => ({ name, size: 1 })) }));
        return;
      }
      res.writeHead(204);
      res.end();
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
    const adapter = new GcsAdapter("oauth");
    try {
      await adapter.connect({
        bucket: "artifacts",
        endpoint: `http://127.0.0.1:${port}`,
        token: "ya29.test",
        allowWrite: true,
        simulator: false,
      });
      const health = await adapter.health();
      assert.match(health.detail ?? "", /mode=oauth/);
      await adapter.invoke("put", { key: "a.txt", body: "tok" });
      const got = (await adapter.invoke("get", { key: "a.txt" })) as { body: string };
      assert.equal(got.body, "tok");
      assert.equal(auth, "Bearer ya29.test");
    } finally {
      await adapter.disconnect();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
