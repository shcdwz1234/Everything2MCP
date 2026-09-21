import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { WebDavAdapter } from "../src/adapters/webdav/index.js";
import { AdapterError } from "../src/runtime/errors.js";

describe("WebDavAdapter", () => {
  it("memory propfind / get / write-gated put", async () => {
    const adapter = new WebDavAdapter("dav.mem");
    await adapter.connect({ simulator: true });
    const listed = (await adapter.invoke("propfind", { path: "/", depth: 1 })) as { entries: Array<{ href: string }> };
    assert.ok(listed.entries.some((e) => e.href === "/"));
    await adapter.invoke("mkcol", { path: "/docs" }).catch(() => undefined);
    await assert.rejects(
      () => adapter.invoke("put", { path: "/docs/a.txt", body: "hi" }),
      (err: unknown) => err instanceof AdapterError && /allowWrite/.test(String(err)),
    );
    await adapter.disconnect();

    const writer = new WebDavAdapter("dav.w");
    await writer.connect({ simulator: true, allowWrite: true });
    await writer.invoke("mkcol", { path: "/docs" });
    await writer.invoke("put", { path: "/docs/a.txt", body: "hi" });
    const got = (await writer.invoke("get", { path: "/docs/a.txt" })) as { body: string };
    assert.equal(got.body, "hi");
    await writer.invoke("delete", { path: "/docs/a.txt" });
    await assert.rejects(() => writer.invoke("get", { path: "/docs/a.txt" }), AdapterError);
    await writer.disconnect();
  });

  it("HTTP OPTIONS DAV header + PUT/GET against loopback", async () => {
    const files = new Map<string, string>([["/hello.txt", "dav-hi"]]);
    const server = createServer((req, res) => {
      const url = req.url ?? "/";
      if (req.method === "OPTIONS") {
        res.writeHead(200, { DAV: "1,2", Allow: "OPTIONS, GET, PUT, DELETE, PROPFIND, MKCOL" });
        res.end();
        return;
      }
      if (req.method === "PROPFIND") {
        res.writeHead(207, { "content-type": "application/xml" });
        res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>${url}</d:href><d:propstat><d:prop><d:resourcetype/></d:prop></d:propstat></d:response></d:multistatus>`);
        return;
      }
      if (req.method === "GET") {
        const body = files.get(url);
        if (body === undefined) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(body);
        return;
      }
      if (req.method === "PUT") {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          files.set(url, Buffer.concat(chunks).toString("utf8"));
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
    const adapter = new WebDavAdapter("dav.http");
    try {
      await adapter.connect({ url: `http://127.0.0.1:${port}`, allowWrite: true });
      const got = (await adapter.invoke("get", { path: "/hello.txt" })) as { body: string };
      assert.equal(got.body, "dav-hi");
      await adapter.invoke("put", { path: "/hello.txt", body: "upd" });
      const again = (await adapter.invoke("get", { path: "/hello.txt" })) as { body: string };
      assert.equal(again.body, "upd");
    } finally {
      await adapter.disconnect();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
