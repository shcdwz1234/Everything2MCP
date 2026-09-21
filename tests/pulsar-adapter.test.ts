import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AdapterError } from "../src/runtime/errors.js";
import { createServer as createTcpServer } from "node:net";
import {
  PulsarAdapter,
  createMemoryPulsar,
  crc32c,
  CRC32C_CHECK,
  encodeOfficialCommandFrame,
  encodePulsarFrame,
  listenFakeOfficialPulsarBroker,
  listenFakePulsarBroker,
  parsePulsarTopic,
  hashPartition,
  isPulsarPartitionTopic,
  pulsarPartitionTopic,
  splitPulsarPayload,
  PULSAR_DEFAULT_CHUNK_SIZE,
  PULSAR_PAYLOAD_MAGIC,
  tryDecodeOfficialFrames,
  tryDecodePulsarFrames,
} from "../src/adapters/pulsar/index.js";

describe("PulsarAdapter", () => {
  it("rejects missing topic", async () => {
    await assert.rejects(() => new PulsarAdapter("x").connect({}), /topic/);
  });

  it("parses short and fully-qualified topic names", () => {
    assert.equal(parsePulsarTopic("orders").full, "persistent://public/default/orders");
    assert.equal(parsePulsarTopic("orders", "acme", "prod").full, "persistent://acme/prod/orders");
    const fq = parsePulsarTopic("persistent://t/ns/clicks");
    assert.equal(fq.tenant, "t");
    assert.equal(fq.namespace, "ns");
    assert.equal(fq.name, "clicks");
    assert.equal(isPulsarPartitionTopic("orders-partition-2"), true);
    assert.equal(isPulsarPartitionTopic("orders"), false);
    assert.equal(pulsarPartitionTopic("orders-partitions-4", 2), "persistent://public/default/orders-partitions-4-partition-2");
    assert.equal(hashPartition("alpha", 4), hashPartition("alpha", 4));
    assert.ok(hashPartition("alpha", 4) < 4);
    assert.deepEqual(splitPulsarPayload("abc", 256), ["abc"]);
    assert.deepEqual(splitPulsarPayload("ABCDEFGH", 8), ["ABCDEFGH"]);
    assert.deepEqual(splitPulsarPayload("ABCDEFGHI", 8), ["ABCDEFGH", "I"]);
    assert.deepEqual(splitPulsarPayload("你好世界", 6), ["你好", "世界"]);
    assert.equal(PULSAR_DEFAULT_CHUNK_SIZE, 256);
  });

  it("publish/consume_once/list on memory when allowWrite=true", async () => {
    const adapter = new PulsarAdapter("events");
    await adapter.connect({ topic: "orders", endpoint: "memory://", allowWrite: true });
    try {
      const names = (await adapter.listTools()).map((t) => t.name).sort();
      assert.deepEqual(names, [
        "consume_once",
        "list_namespaces",
        "list_topics",
        "lookup",
        "partitioned_metadata",
        "publish",
      ]);
      const sent = (await adapter.invoke("publish", { payload: { sku: "x" } })) as {
        messageId: string;
        topic: string;
      };
      assert.ok(sent.messageId);
      assert.equal(sent.topic, "persistent://public/default/orders");
      const listed = (await adapter.invoke("list_topics", {})) as { topics: string[] };
      assert.ok(listed.topics.includes("persistent://public/default/orders"));
      const ns = (await adapter.invoke("list_namespaces", {})) as { namespaces: string[] };
      assert.ok(ns.namespaces.includes("public/default"));
      const msg = (await adapter.invoke("consume_once", {})) as { payload: string; topic: string };
      assert.equal(JSON.parse(msg.payload).sku, "x");
      assert.equal(msg.topic, sent.topic);
      await assert.rejects(() => adapter.invoke("consume_once", { timeoutMs: 30 }), /Timed out/);
    } finally {
      await adapter.disconnect();
    }
  });

  it("defaults allowWrite=false and still allows consume/list", async () => {
    const mem = createMemoryPulsar("orders");
    await mem.publish("orders", "keep");
    const adapter = new PulsarAdapter("ro", async () => mem);
    await adapter.connect({ topic: "orders" });
    try {
      const rec = (await adapter.invoke("consume_once", {})) as { payload: string };
      assert.equal(rec.payload, "keep");
      await assert.rejects(
        () => adapter.invoke("publish", { payload: "nope" }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
      );
      const health = await adapter.health();
      assert.match(health.detail ?? "", /allowWrite=false/);
      await assert.rejects(() => adapter.invoke("nope", {}), /Unknown Pulsar tool/);
      await assert.rejects(
        () => adapter.invoke("lookup", {}),
        (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED" && /LOOKUP/i.test(err.message),
      );
      await assert.rejects(
        () => adapter.invoke("partitioned_metadata", {}),
        (err: unknown) =>
          err instanceof AdapterError && err.code === "E_UNSUPPORTED" && /PARTITIONED_METADATA/i.test(err.message),
      );
      await assert.rejects(
        () => adapter.invoke("publish", { payload: "x", batch: ["a", "b"] }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED" && /batch|chunk/i.test(err.message),
      );
      await assert.rejects(
        () => adapter.invoke("publish", { payload: "ABCDEFGH", chunk: true, chunkSize: 4 }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED" && /chunk:true|official/i.test(err.message),
      );
    } finally {
      await adapter.disconnect();
    }
  });

  it("keeps independent subscription cursors", async () => {
    const adapter = new PulsarAdapter("groups");
    await adapter.connect({ topic: "t", allowWrite: true, subscription: "a" });
    try {
      await adapter.invoke("publish", { payload: "one" });
      await adapter.invoke("publish", { payload: "two" });
      const a1 = (await adapter.invoke("consume_once", { subscription: "a" })) as { payload: string };
      const b1 = (await adapter.invoke("consume_once", { subscription: "b" })) as { payload: string };
      const a2 = (await adapter.invoke("consume_once", { subscription: "a" })) as { payload: string };
      assert.equal(a1.payload, "one");
      assert.equal(b1.payload, "one");
      assert.equal(a2.payload, "two");
    } finally {
      await adapter.disconnect();
    }
  });

  it("produce/consume over e2mcp-pulsar binary against an embedded fake broker", async () => {
    const broker = await listenFakePulsarBroker();
    const adapter = new PulsarAdapter("bin");
    try {
      await adapter.connect({
        topic: "orders",
        serviceUrl: broker.url,
        dialect: "e2p1",
        allowWrite: true,
      });
      const health = await adapter.health();
      assert.match(health.detail ?? "", /mode=binary/);
      const sent = (await adapter.invoke("publish", { payload: { sku: "bin" } })) as {
        messageId: string;
        topic: string;
      };
      assert.ok(sent.messageId);
      assert.equal(sent.topic, "persistent://public/default/orders");
      const listed = (await adapter.invoke("list_topics", {})) as { topics: string[] };
      assert.ok(listed.topics.includes(sent.topic));
      const msg = (await adapter.invoke("consume_once", {})) as { payload: string };
      assert.equal(JSON.parse(msg.payload).sku, "bin");
    } finally {
      await adapter.disconnect();
      await broker.close();
    }
  });

  it("encodes e2mcp-pulsar frames with E2P1 magic", () => {
    const buf = encodePulsarFrame({ type: "PING" });
    assert.equal(buf.subarray(0, 4).toString("ascii"), "E2P1");
    const { frames } = tryDecodePulsarFrames(buf);
    assert.equal(frames[0]?.type, "PING");
    assert.throws(
      () => tryDecodePulsarFrames(Buffer.from([0, 0, 0, 4, 1, 2, 3, 4])),
      (err: unknown) => err instanceof AdapterError && err.code === "E_PROTOCOL" && /E2P1|Apache PulsarApi/i.test(err.message),
    );
  });

  it("fails clearly when pulsar:// is not a PulsarApi peer (and e2p1 rejects TLS)", async () => {
    const adapter = new PulsarAdapter("mismatch");
    await assert.rejects(
      () => adapter.connect({ topic: "orders", serviceUrl: "pulsar+ssl://127.0.0.1:6651", dialect: "e2p1" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );

    const peers: import("node:net").Socket[] = [];
    const junk = createTcpServer((socket) => {
      peers.push(socket);
      socket.end(Buffer.alloc(16, 0x0a));
    });
    const port = await new Promise<number>((resolve, reject) => {
      junk.once("error", reject);
      junk.listen(0, "127.0.0.1", () => resolve((junk.address() as { port: number }).port));
    });
    try {
      await assert.rejects(
        () => adapter.connect({ topic: "orders", serviceUrl: `pulsar://127.0.0.1:${port}`, timeoutMs: 1500 }),
        (err: unknown) =>
          err instanceof AdapterError &&
          err.code === "E_PROTOCOL" &&
          /PulsarApi|frame size|handshake|socket closed|E2P1/i.test(err.message),
      );
    } finally {
      for (const s of peers) s.destroy();
      junk.close();
    }
  });

  it("CRC-32C matches the ITU check vector", () => {
    assert.equal(crc32c(Buffer.from("123456789")), CRC32C_CHECK);
  });

  it("encodes official PulsarApi command frames (not E2P1)", () => {
    const buf = encodeOfficialCommandFrame({
      type: "CONNECT",
      connect: { client_version: "everything2mcp", protocol_version: 12 },
    });
    assert.ok(buf.length > 8);
    assert.notEqual(buf.subarray(0, 4).toString("ascii"), "E2P1");
    const { frames } = tryDecodeOfficialFrames(buf);
    assert.equal(frames[0]?.command.type, "CONNECT");
    assert.equal(PULSAR_PAYLOAD_MAGIC, 0x0e01);
    assert.throws(
      () => tryDecodeOfficialFrames(encodePulsarFrame({ type: "PING" })),
      (err: unknown) => err instanceof AdapterError && err.code === "E_PROTOCOL" && /e2p1|E2P1/i.test(err.message),
    );
  });

  it("produce/consume over official PulsarApi against an embedded fake broker", async () => {
    const broker = await listenFakeOfficialPulsarBroker();
    const adapter = new PulsarAdapter("official");
    try {
      await adapter.connect({
        topic: "orders",
        serviceUrl: broker.url,
        allowWrite: true,
      });
      const health = await adapter.health();
      assert.match(health.detail ?? "", /mode=official/);
      const sent = (await adapter.invoke("publish", { payload: { sku: "api" } })) as {
        messageId: string;
        topic: string;
      };
      assert.ok(sent.messageId.includes(":"));
      assert.equal(sent.topic, "persistent://public/default/orders");
      const listed = (await adapter.invoke("list_topics", {})) as { topics: string[] };
      assert.ok(listed.topics.includes(sent.topic));
      const ns = (await adapter.invoke("list_namespaces", {})) as { namespaces: string[] };
      assert.ok(ns.namespaces.includes("public/default"));
      const msg = (await adapter.invoke("consume_once", {})) as { payload: string };
      assert.equal(JSON.parse(msg.payload).sku, "api");
    } finally {
      await adapter.disconnect();
      await broker.close();
    }
  });

  it("official path talking to an e2p1 fake asks for dialect=e2p1", async () => {
    const broker = await listenFakePulsarBroker();
    const adapter = new PulsarAdapter("cross");
    try {
      await assert.rejects(
        () => adapter.connect({ topic: "orders", serviceUrl: broker.url, timeoutMs: 1500 }),
        (err: unknown) =>
          err instanceof AdapterError && err.code === "E_PROTOCOL" && /dialect="e2p1"|E2P1|e2mcp-pulsar/i.test(err.message),
      );
    } finally {
      await broker.close();
    }
  });

  it("talks unsigned JSON HTTP to a local Pulsar-shaped fake", async () => {
    const visible: Array<{ messageId: string; payload: string; topic: string; publishTime: number }> = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const json = (code: number, body: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "GET" && parts[0] === "topics" && parts.length === 1) {
        json(200, { topics: ["persistent://public/default/orders"] });
        return;
      }
      if (req.method === "GET" && parts[0] === "namespaces") {
        json(200, { namespaces: ["public/default"] });
        return;
      }
      if (req.method === "POST" && parts[0] === "topics" && parts[2] === "messages") {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c as Buffer));
        req.on("end", () => {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { payload?: string };
          const topic = `persistent://public/default/${parts[1]}`;
          const msg = {
            messageId: "msg-http-1",
            payload: parsed.payload ?? "",
            topic,
            publishTime: Date.now(),
          };
          visible.push(msg);
          json(200, { messageId: msg.messageId, topic });
        });
        return;
      }
      if (req.method === "GET" && parts[0] === "topics" && parts[2] === "messages") {
        const msg = visible.shift();
        if (!msg) {
          res.writeHead(204);
          res.end();
          return;
        }
        json(200, msg);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        resolve(addr.port);
      });
    });
    const adapter = new PulsarAdapter("http");
    try {
      await adapter.connect({
        topic: "orders",
        serviceUrl: `http://127.0.0.1:${port}`,
        unsigned: true,
        allowWrite: true,
      });
      const sent = (await adapter.invoke("publish", { payload: "hi" })) as { messageId: string };
      assert.equal(sent.messageId, "msg-http-1");
      const listed = (await adapter.invoke("list_topics", {})) as { topics: string[] };
      assert.ok(listed.topics.length > 0);
      const got = (await adapter.invoke("consume_once", {})) as { payload: string };
      assert.equal(got.payload, "hi");
    } finally {
      await adapter.disconnect();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("official LOOKUP Connect / Failed / dead Redirect hop", async () => {
    const broker = await listenFakeOfficialPulsarBroker();
    const adapter = new PulsarAdapter("lookup");
    try {
      await adapter.connect({ topic: "orders", serviceUrl: broker.url, timeoutMs: 1500 });
      const frame = encodeOfficialCommandFrame({
        type: "LOOKUP",
        lookupTopic: { topic: "persistent://public/default/orders", request_id: 7, authoritative: false },
      });
      const decoded = tryDecodeOfficialFrames(frame);
      assert.equal(decoded.frames[0]?.command.type, "LOOKUP");

      const ok = (await adapter.invoke("lookup", {})) as {
        response: string;
        followed: boolean;
        hops?: number;
        brokerServiceUrl?: string;
        topic: string;
      };
      assert.equal(ok.response, "Connect");
      assert.equal(ok.followed, false);
      assert.equal(ok.hops, 0);
      assert.equal(ok.topic, "persistent://public/default/orders");
      assert.equal(ok.brokerServiceUrl, broker.url);

      await assert.rejects(
        () => adapter.invoke("lookup", { topic: "missing-topic" }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_NOT_FOUND" && /TopicNotFound/i.test(err.message),
      );

      await assert.rejects(
        () => adapter.invoke("lookup", { topic: "orders-redirect-dead" }),
        (err: unknown) =>
          err instanceof AdapterError && err.code === "E_PROTOCOL" && /connect failed|127\.0\.0\.1:1/i.test(err.message),
      );

      const hopLimited = new PulsarAdapter("lookup-zero");
      await hopLimited.connect({
        topic: "orders",
        serviceUrl: broker.url,
        timeoutMs: 800,
        maxLookupRedirects: 0,
      });
      try {
        await assert.rejects(
          () => hopLimited.invoke("lookup", { topic: "orders-redirect" }),
          (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED" && /hop limit/i.test(err.message),
        );
      } finally {
        await hopLimited.disconnect();
      }
      const health = await adapter.health();
      assert.match(health.detail ?? "", /lookup=wire/);
    } finally {
      await adapter.disconnect();
      await broker.close();
    }
  });

  it("official LOOKUP follows Redirect to the owner broker", async () => {
    const owner = await listenFakeOfficialPulsarBroker();
    const proxy = await listenFakeOfficialPulsarBroker("127.0.0.1", { redirectTarget: owner.url });
    const adapter = new PulsarAdapter("follow");
    try {
      await adapter.connect({ topic: "orders", serviceUrl: proxy.url, timeoutMs: 2500 });
      const result = (await adapter.invoke("lookup", { topic: "orders-redirect" })) as {
        response: string;
        followed: boolean;
        hops?: number;
        brokerServiceUrl?: string;
      };
      assert.equal(result.response, "Connect");
      assert.equal(result.followed, true);
      assert.equal(result.hops, 1);
      assert.equal(result.brokerServiceUrl, owner.url);
    } finally {
      await adapter.disconnect();
      await proxy.close();
      await owner.close();
    }
  });

  it("official LOOKUP follow migrates publish/consume to the owner broker", async () => {
    const owner = await listenFakeOfficialPulsarBroker();
    const proxy = await listenFakeOfficialPulsarBroker("127.0.0.1", { redirectTarget: owner.url });
    const publisher = new PulsarAdapter("migrate");
    const onOwner = new PulsarAdapter("owner-read");
    const onProxy = new PulsarAdapter("proxy-read");
    try {
      await publisher.connect({
        topic: "orders",
        serviceUrl: proxy.url,
        allowWrite: true,
        timeoutMs: 2500,
      });
      const look = (await publisher.invoke("lookup", { topic: "orders-redirect" })) as {
        followed: boolean;
        hops?: number;
      };
      assert.equal(look.followed, true);
      assert.equal(look.hops, 1);
      await publisher.invoke("publish", { topic: "orders-redirect", payload: "migrated" });

      await onOwner.connect({ topic: "orders-redirect", serviceUrl: owner.url, timeoutMs: 1500 });
      const msg = (await onOwner.invoke("consume_once", { timeoutMs: 1500 })) as { payload: string };
      assert.equal(msg.payload, "migrated");

      await onProxy.connect({ topic: "orders-redirect", serviceUrl: proxy.url, timeoutMs: 800 });
      await assert.rejects(
        () => onProxy.invoke("consume_once", { timeoutMs: 80 }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_TIMEOUT",
      );
    } finally {
      await publisher.disconnect();
      await onOwner.disconnect();
      await onProxy.disconnect();
      await proxy.close();
      await owner.close();
    }
  });

  it("official LOOKUP Redirect loop is E_UNSUPPORTED", async () => {
    const broker = await listenFakeOfficialPulsarBroker();
    const adapter = new PulsarAdapter("loop");
    try {
      await adapter.connect({ topic: "orders", serviceUrl: broker.url, timeoutMs: 1500 });
      await assert.rejects(
        () => adapter.invoke("lookup", { topic: "redirect-loop" }),
        (err: unknown) =>
          err instanceof AdapterError && err.code === "E_UNSUPPORTED" && /loop|hop limit/i.test(err.message),
      );
    } finally {
      await adapter.disconnect();
      await broker.close();
    }
  });

  it("official PARTITIONED_METADATA reports count; batch expands; chunk reassembles", async () => {
    const broker = await listenFakeOfficialPulsarBroker();
    const adapter = new PulsarAdapter("parts");
    try {
      await adapter.connect({ topic: "orders", serviceUrl: broker.url, timeoutMs: 2000, allowWrite: true });
      const none = (await adapter.invoke("partitioned_metadata", {})) as { partitions: number; response: string };
      assert.equal(none.response, "Success");
      assert.equal(none.partitions, 0);
      const parted = (await adapter.invoke("partitioned_metadata", { topic: "orders-partitions-4" })) as {
        partitions: number;
      };
      assert.equal(parted.partitions, 4);
      const named = (await adapter.invoke("partitioned_metadata", { topic: "orders-parted" })) as { partitions: number };
      assert.equal(named.partitions, 3);
      await assert.rejects(
        () => adapter.invoke("partitioned_metadata", { topic: "missing-topic" }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_NOT_FOUND",
      );

      const first = (await adapter.invoke("consume_once", { topic: "orders-batch-seed", timeoutMs: 1500 })) as {
        payload: string;
        batchSize?: number;
        batchIndex?: number;
      };
      assert.equal(first.payload, "alpha");
      assert.equal(first.batchSize, 2);
      assert.equal(first.batchIndex, 0);
      const second = (await adapter.invoke("consume_once", { topic: "orders-batch-seed", timeoutMs: 800 })) as {
        payload: string;
      };
      assert.equal(second.payload, "beta");

      const chunk = (await adapter.invoke("consume_once", { topic: "orders-chunk-seed", timeoutMs: 1500 })) as {
        payload: string;
      };
      assert.equal(chunk.payload, "AABB");

      const tooBig = "a".repeat(PULSAR_DEFAULT_CHUNK_SIZE * 8 + 1);
      await assert.rejects(
        () => adapter.invoke("publish", { payload: tooBig, chunk: true }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED" && /8 frames|chunkSize/i.test(err.message),
      );
    } finally {
      await adapter.disconnect();
      await broker.close();
    }
  });

  it("official publish routes to -partition-N and sends outbound batch frames", async () => {
    const broker = await listenFakeOfficialPulsarBroker();
    const adapter = new PulsarAdapter("route");
    try {
      await adapter.connect({ topic: "orders", serviceUrl: broker.url, timeoutMs: 2500, allowWrite: true });
      const key = "alpha";
      const expected = hashPartition(key, 4);
      const sent = (await adapter.invoke("publish", {
        topic: "orders-partitions-4",
        payload: "routed",
        key,
      })) as { topic: string; partition?: number };
      assert.equal(sent.partition, expected);
      assert.equal(sent.topic, `persistent://public/default/orders-partitions-4-partition-${expected}`);

      const again = (await adapter.invoke("publish", {
        topic: "orders-partitions-4",
        payload: "again",
        key,
      })) as { partition?: number };
      assert.equal(again.partition, expected);

      const leaf = (await adapter.invoke("publish", {
        topic: sent.topic,
        payload: "leaf",
      })) as { topic: string; partition?: number };
      assert.equal(leaf.topic, sent.topic);
      assert.equal(leaf.partition, expected);

      const got = (await adapter.invoke("consume_once", { topic: "orders-partitions-4", timeoutMs: 2000 })) as {
        payload: string;
        topic: string;
      };
      assert.ok(["routed", "again", "leaf"].includes(got.payload), got.payload);
      assert.match(got.topic, /-partition-\d+$/);

      const batched = (await adapter.invoke("publish", {
        topic: "orders-batch-out",
        payload: "ignored",
        batch: ["gamma", "delta"],
      })) as { batchSize?: number; topic: string };
      assert.equal(batched.batchSize, 2);
      const b1 = (await adapter.invoke("consume_once", { topic: "orders-batch-out", timeoutMs: 1500 })) as {
        payload: string;
        batchSize?: number;
        batchIndex?: number;
      };
      assert.equal(b1.payload, "gamma");
      assert.equal(b1.batchSize, 2);
      assert.equal(b1.batchIndex, 0);
      const b2 = (await adapter.invoke("consume_once", { topic: "orders-batch-out", timeoutMs: 800 })) as {
        payload: string;
      };
      assert.equal(b2.payload, "delta");

      const chunked = (await adapter.invoke("publish", {
        topic: "orders-chunk-out",
        payload: "ignored",
        chunks: ["CC", "DD"],
      })) as { chunks?: number };
      assert.equal(chunked.chunks, 2);
      const reassembled = (await adapter.invoke("consume_once", { topic: "orders-chunk-out", timeoutMs: 1500 })) as {
        payload: string;
      };
      assert.equal(reassembled.payload, "CCDD");
    } finally {
      await adapter.disconnect();
      await broker.close();
    }
  });

  it("official CONNECT sends token/JWT and rejects a missing token", async () => {
    const broker = await listenFakeOfficialPulsarBroker("127.0.0.1", { requireAuthToken: "s3cret" });
    const denied = new PulsarAdapter("auth-denied");
    try {
      await assert.rejects(
        () => denied.connect({ topic: "orders", serviceUrl: broker.url, timeoutMs: 1500 }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_AUTH" && /token/i.test(err.message),
      );
      const ok = new PulsarAdapter("auth-ok");
      await ok.connect({ topic: "orders", serviceUrl: broker.url, token: "s3cret", timeoutMs: 1500 });
      try {
        const look = (await ok.invoke("lookup", {})) as { response: string };
        assert.equal(look.response, "Connect");
      } finally {
        await ok.disconnect();
      }
    } finally {
      await denied.disconnect().catch(() => undefined);
      await broker.close();
    }
  });

  it("produce/consume over official pulsar+ssl:// against a TLS fake broker", async () => {
    const dir = await mkdtemp(join(tmpdir(), "e2mcp-pulsar-tls-"));
    const keyPath = join(dir, "key.pem");
    const certPath = join(dir, "cert.pem");
    try {
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-keyout",
          keyPath,
          "-out",
          certPath,
          "-days",
          "1",
          "-nodes",
          "-subj",
          "/CN=127.0.0.1",
        ],
        { stdio: "pipe" },
      );
    } catch {
      await rm(dir, { recursive: true, force: true });
      if (!existsSync("/usr/bin/openssl") && !existsSync("/bin/openssl")) {
        return;
      }
      throw new Error("openssl failed to mint a hermetic Pulsar TLS cert");
    }
    const key = await readFile(keyPath);
    const cert = await readFile(certPath);
    const broker = await listenFakeOfficialPulsarBroker("127.0.0.1", { tls: { key, cert } });
    const adapter = new PulsarAdapter("official-tls");
    try {
      assert.match(broker.url, /^pulsar\+ssl:\/\//);
      await adapter.connect({
        topic: "orders",
        serviceUrl: broker.url,
        allowWrite: true,
        tlsInsecure: true,
      });
      await adapter.invoke("publish", { payload: "tls" });
      const msg = (await adapter.invoke("consume_once", {})) as { payload: string };
      assert.equal(msg.payload, "tls");
    } finally {
      await adapter.disconnect();
      await broker.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("official chunk:true splits UTF-8 at chunkSize and consume_once reassembles", async () => {
    const broker = await listenFakeOfficialPulsarBroker();
    const adapter = new PulsarAdapter("implicit");
    try {
      await adapter.connect({ topic: "orders", serviceUrl: broker.url, timeoutMs: 2500, allowWrite: true });
      const small = (await adapter.invoke("publish", {
        topic: "orders-chunk-small",
        payload: "tiny",
        chunk: true,
        chunkSize: 32,
      })) as { chunks?: number };
      assert.equal(small.chunks, undefined);
      const tiny = (await adapter.invoke("consume_once", { topic: "orders-chunk-small", timeoutMs: 1500 })) as {
        payload: string;
      };
      assert.equal(tiny.payload, "tiny");

      const sent = (await adapter.invoke("publish", {
        topic: "orders-chunk-implicit",
        payload: "ABCDEFGH",
        chunk: true,
        chunkSize: 4,
      })) as { chunks?: number };
      assert.equal(sent.chunks, 2);
      const got = (await adapter.invoke("consume_once", { topic: "orders-chunk-implicit", timeoutMs: 1500 })) as {
        payload: string;
      };
      assert.equal(got.payload, "ABCDEFGH");
    } finally {
      await adapter.disconnect();
      await broker.close();
    }
  });
});
