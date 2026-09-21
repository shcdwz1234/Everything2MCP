import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { WebSocketServer } from "ws";
import { WebSocketAdapter } from "../src/adapters/websocket/index.js";

describe("WebSocketAdapter", () => {
  let port: number;
  let closeHttp: () => Promise<void>;

  before(async () => {
    const httpServer = createServer();
    const wss = new WebSocketServer({ server: httpServer });
    wss.on("connection", (socket) => {
      socket.on("message", (data, isBinary) => {
        socket.send(data, { binary: isBinary });
      });
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    port = (httpServer.address() as AddressInfo).port;
    closeHttp = () =>
      new Promise((resolve, reject) => {
        wss.close();
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
  });

  after(async () => {
    await closeHttp();
  });

  it("rejects missing url", async () => {
    const adapter = new WebSocketAdapter("bad");
    await assert.rejects(() => adapter.connect({}), /config\.url/);
  });

  it("sends and receive_once against a local echo server", async () => {
    const adapter = new WebSocketAdapter("echo");
    await adapter.connect({ url: `ws://127.0.0.1:${port}`, allowWrite: true });
    const tools = await adapter.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ["receive_once", "send"],
    );

    const sent = (await adapter.invoke("send", { payload: { hello: "ws" } })) as { ok: boolean };
    assert.equal(sent.ok, true);
    const got = (await adapter.invoke("receive_once", { timeoutMs: 500 })) as {
      data: string;
      binary: boolean;
    };
    assert.equal(got.binary, false);
    assert.equal(got.data, JSON.stringify({ hello: "ws" }));

    const health = await adapter.health();
    assert.equal(health.ok, true);
    await adapter.disconnect();
  });

  it("times out receive_once when no frame arrives", async () => {
    const adapter = new WebSocketAdapter("idle");
    await adapter.connect({ url: `ws://127.0.0.1:${port}` });
    await assert.rejects(
      () => adapter.invoke("receive_once", { timeoutMs: 40 }),
      /Timed out/,
    );
    await assert.rejects(() => adapter.invoke("nope", {}), /Unknown WebSocket tool/);
    await adapter.disconnect();
  });

  it("defaults allowWrite=false and blocks send; receive_once still works", async () => {
    const adapter = new WebSocketAdapter("ro");
    await adapter.connect({ url: `ws://127.0.0.1:${port}` });
    try {
      await assert.rejects(() => adapter.invoke("send", { payload: "x" }), /allowWrite/);
      await assert.rejects(() => adapter.invoke("receive_once", { timeoutMs: 30 }), /Timed out/);
    } finally {
      await adapter.disconnect();
    }
  });

  it("rejects tools before connect", async () => {
    const adapter = new WebSocketAdapter("idle");
    await assert.rejects(() => adapter.listTools(), /not connected/);
    const health = await adapter.health();
    assert.equal(health.ok, false);
  });
});
