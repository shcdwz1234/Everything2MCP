import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, it } from "node:test";
import { AdapterError } from "../src/runtime/errors.js";
import { SqsAdapter, createMemorySqs } from "../src/adapters/sqs/index.js";

describe("SqsAdapter (P4)", () => {
  it("rejects missing queue", async () => {
    await assert.rejects(() => new SqsAdapter("x").connect({}), /queue/);
  });

  it("send/receive/delete on the memory queue when allowWrite=true", async () => {
    const adapter = new SqsAdapter("orders");
    await adapter.connect({ queue: "orders", endpoint: "memory://", allowWrite: true });
    try {
      const names = (await adapter.listTools()).map((t) => t.name).sort();
      assert.deepEqual(names, ["delete", "list_queues", "receive", "send"]);
      const sent = (await adapter.invoke("send", { body: "hello" })) as { messageId: string };
      assert.ok(sent.messageId);
      const listed = (await adapter.invoke("list_queues", {})) as { queues: string[] };
      assert.ok(listed.queues.includes("orders"));
      const rec = (await adapter.invoke("receive", {})) as {
        messages: Array<{ body: string; receiptHandle: string }>;
      };
      assert.equal(rec.messages.length, 1);
      assert.equal(rec.messages[0]?.body, "hello");
      const empty = (await adapter.invoke("receive", {})) as { messages: unknown[] };
      assert.equal(empty.messages.length, 0);
      await adapter.invoke("delete", { receiptHandle: rec.messages[0]!.receiptHandle });
      await assert.rejects(
        () => adapter.invoke("delete", { receiptHandle: rec.messages[0]!.receiptHandle }),
        /Unknown receipt/,
      );
    } finally {
      await adapter.disconnect();
    }
  });

  it("defaults allowWrite=false and still allows list/receive", async () => {
    const mem = createMemorySqs("orders");
    await mem.send("orders", "keep");
    const adapter = new SqsAdapter("ro", async () => mem);
    await adapter.connect({ queue: "orders" });
    try {
      const rec = (await adapter.invoke("receive", {})) as { messages: Array<{ body: string }> };
      assert.equal(rec.messages[0]?.body, "keep");
      await assert.rejects(
        () => adapter.invoke("send", { body: "nope" }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
      );
      await assert.rejects(
        () => adapter.invoke("delete", { receiptHandle: "rh-x" }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
      );
      const health = await adapter.health();
      assert.match(health.detail ?? "", /allowWrite=false/);
    } finally {
      await adapter.disconnect();
    }
  });

  it("talks unsigned JSON HTTP to a local SQS-shaped fake", async () => {
    const visible: Array<{ messageId: string; body: string }> = [];
    const inFlight = new Map<string, { messageId: string; body: string }>();
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const json = (code: number, body: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "GET" && parts.length === 1 && parts[0] === "queues") {
        json(200, { queues: ["orders"] });
        return;
      }
      if (req.method === "POST" && parts[2] === "messages") {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { body?: string };
          const messageId = `msg-${visible.length + 1}`;
          visible.push({ messageId, body: parsed.body ?? "" });
          json(200, { messageId });
        });
        return;
      }
      if (req.method === "GET" && parts[2] === "messages") {
        const msg = visible.shift();
        if (!msg) {
          json(200, { messages: [] });
          return;
        }
        const receiptHandle = `rh-${msg.messageId}`;
        inFlight.set(receiptHandle, msg);
        json(200, { messages: [{ ...msg, receiptHandle }] });
        return;
      }
      if (req.method === "DELETE" && parts[2] === "messages") {
        const rh = url.searchParams.get("ReceiptHandle") ?? "";
        if (!inFlight.delete(rh)) {
          json(404, { error: "not found" });
          return;
        }
        json(200, { deleted: true });
        return;
      }
      json(404, { error: "no" });
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        resolve(addr.port);
      });
    });
    const adapter = new SqsAdapter("http");
    try {
      await adapter.connect({
        queue: "orders",
        endpoint: `http://127.0.0.1:${port}`,
        unsigned: true,
        allowWrite: true,
      });
      await adapter.invoke("send", { body: "via-http" });
      const rec = (await adapter.invoke("receive", {})) as {
        messages: Array<{ body: string; receiptHandle: string }>;
      };
      assert.equal(rec.messages[0]?.body, "via-http");
      await adapter.invoke("delete", { receiptHandle: rec.messages[0]!.receiptHandle });
    } finally {
      await adapter.disconnect();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
