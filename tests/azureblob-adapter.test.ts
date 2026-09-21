import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, it } from "node:test";
import { AzureBlobAdapter } from "../src/adapters/azureblob/index.js";
import { signAzureBlob, verifyAzureBlob } from "../src/adapters/sigv4.js";
import { AdapterError } from "../src/runtime/errors.js";

describe("AzureBlobAdapter", () => {
  it("rejects missing container", async () => {
    await assert.rejects(() => new AzureBlobAdapter("x").connect({}), /container/);
  });

  it("memory list/get; put/delete gated by allowWrite", async () => {
    const adapter = new AzureBlobAdapter("az.ro");
    await adapter.connect({ container: "data", simulator: true });
    const empty = (await adapter.invoke("list", {})) as { objects: unknown[] };
    assert.deepEqual(empty.objects, []);
    await assert.rejects(
      () => adapter.invoke("put", { key: "a.txt", body: "nope" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
    await adapter.disconnect();

    const writer = new AzureBlobAdapter("az.w");
    await writer.connect({ container: "data", simulator: true, allowWrite: true });
    await writer.invoke("put", { key: "notes/hello.txt", body: "hi", contentType: "text/plain" });
    const listed = (await writer.invoke("list", { prefix: "notes/" })) as { objects: Array<{ key: string }> };
    assert.equal(listed.objects[0]?.key, "notes/hello.txt");
    const got = (await writer.invoke("get", { key: "notes/hello.txt" })) as { body: string };
    assert.equal(got.body, "hi");
    const del = (await writer.invoke("delete", { key: "notes/hello.txt" })) as { deleted: boolean };
    assert.equal(del.deleted, true);
    await writer.disconnect();
  });

  it("SharedKey HMAC-SHA256 subset signs and verifies; SAS is query-only", () => {
    const accountKey = Buffer.from("azure-test-key").toString("base64");
    const signed = signAzureBlob({
      method: "GET",
      account: "devstoreaccount1",
      container: "data",
      blob: "a.txt",
      date: "Tue, 22 Sep 2026 00:00:00 GMT",
      accountKey,
    });
    assert.match(signed.authorization, /^SharedKey devstoreaccount1:/);
    assert.equal(
      verifyAzureBlob(
        {
          method: "GET",
          account: "devstoreaccount1",
          container: "data",
          blob: "a.txt",
          date: "Tue, 22 Sep 2026 00:00:00 GMT",
          authorization: signed.authorization,
        },
        accountKey,
      ),
      true,
    );
    assert.equal(
      verifyAzureBlob(
        {
          method: "GET",
          account: "devstoreaccount1",
          container: "data",
          blob: "a.txt",
          date: "Tue, 22 Sep 2026 00:00:00 GMT",
          authorization: "SharedKey devstoreaccount1:nope",
        },
        accountKey,
      ),
      false,
    );
  });

  it("unsigned HTTP list/get/put against Azurite-shaped fake", async () => {
    const store = new Map<string, { body: string; type: string }>();
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const key = parts.slice(1).join("/");
      res.setHeader("x-ms-request-id", "e2mcp");
      if (req.method === "GET" && url.searchParams.get("comp") === "list") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const items = [...store.entries()].filter(([k]) => k.startsWith(prefix));
        const xml = `<?xml version="1.0"?><EnumerationResults><Blobs>${items
          .map(([k, v]) => `<Blob><Name>${k}</Name><Properties><Content-Length>${Buffer.byteLength(v.body)}</Content-Length></Properties></Blob>`)
          .join("")}</Blobs></EnumerationResults>`;
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(xml);
        return;
      }
      if (req.method === "GET" && key) {
        const hit = store.get(key);
        if (!hit) {
          res.writeHead(404);
          res.end("BlobNotFound");
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
          store.set(key, { body: Buffer.concat(chunks).toString("utf8"), type: req.headers["content-type"] ?? "text/plain" });
          res.writeHead(201);
          res.end();
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
    const adapter = new AzureBlobAdapter("az.http");
    try {
      await adapter.connect({
        container: "data",
        endpoint: `http://127.0.0.1:${port}`,
        unsigned: true,
        allowWrite: true,
      });
      await adapter.invoke("put", { key: "a.txt", body: "blob" });
      const listed = (await adapter.invoke("list", {})) as { objects: Array<{ key: string }> };
      assert.equal(listed.objects[0]?.key, "a.txt");
      const got = (await adapter.invoke("get", { key: "a.txt" })) as { body: string };
      assert.equal(got.body, "blob");
    } finally {
      await adapter.disconnect();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("SharedKey HTTP GET/PUT against a verifier loopback", async () => {
    const account = "devstoreaccount1";
    const accountKey = Buffer.from("azure-test-key").toString("base64");
    const store = new Map<string, string>();
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const container = parts[0] ?? "data";
      const blob = parts.slice(1).join("/") || undefined;
      const date = String(req.headers["x-ms-date"] ?? "");
      const authorization = String(req.headers.authorization ?? "");
      const contentType = typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : undefined;
      const method = url.searchParams.get("comp") === "list" ? "GET" : (req.method ?? "GET");
      const ok = verifyAzureBlob(
        { method, account, container, blob: url.searchParams.get("comp") === "list" ? undefined : blob, contentType, date, authorization },
        accountKey,
      );
      if (!ok) {
        res.writeHead(403);
        res.end("SignatureDoesNotMatch");
        return;
      }
      if (req.method === "GET" && url.searchParams.get("comp") === "list") {
        const xml = `<?xml version="1.0"?><EnumerationResults><Blobs>${[...store.keys()]
          .map((k) => `<Blob><Name>${k}</Name><Properties><Content-Length>${Buffer.byteLength(store.get(k) ?? "")}</Content-Length></Properties></Blob>`)
          .join("")}</Blobs></EnumerationResults>`;
        res.writeHead(200, { "x-ms-request-id": "e2mcp", "content-type": "application/xml" });
        res.end(xml);
        return;
      }
      if (req.method === "GET" && blob) {
        const hit = store.get(blob);
        if (!hit) {
          res.writeHead(404);
          res.end("BlobNotFound");
          return;
        }
        res.writeHead(200, { "x-ms-request-id": "e2mcp" });
        res.end(hit);
        return;
      }
      if (req.method === "PUT" && blob) {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          store.set(blob, Buffer.concat(chunks).toString("utf8"));
          res.writeHead(201, { "x-ms-request-id": "e2mcp" });
          res.end();
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
    const adapter = new AzureBlobAdapter("az.sharedkey");
    try {
      await adapter.connect({
        container: "data",
        endpoint: `http://127.0.0.1:${port}`,
        account,
        accountKey,
        allowWrite: true,
      });
      await adapter.invoke("put", { key: "signed.txt", body: "sk", contentType: "text/plain" });
      const got = (await adapter.invoke("get", { key: "signed.txt" })) as { body: string };
      assert.equal(got.body, "sk");
    } finally {
      await adapter.disconnect();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("live path without unsigned / sas / accountKey is E_UNSUPPORTED", async () => {
    await assert.rejects(
      () => new AzureBlobAdapter("live").connect({ container: "data", endpoint: "http://127.0.0.1:10000" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
  });
});
