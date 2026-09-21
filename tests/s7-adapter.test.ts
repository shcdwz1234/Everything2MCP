import assert from "node:assert/strict";
import { createServer } from "node:net";
import { describe, it } from "node:test";
import { AdapterError } from "../src/runtime/errors.js";
import { createS7PduPeer, createS7Simulator, S7Adapter } from "../src/adapters/s7/index.js";
import {
  decodeReadVar,
  encodeCotpCr,
  encodeReadVar,
  isCotpCc,
  parseAddress,
} from "../src/adapters/s7/codec.js";

function listenS7(): Promise<{ port: number; close: () => Promise<void> }> {
  const peer = createS7PduPeer(createS7Simulator({}));
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      socket.on("data", (buf) => {
        void peer.onRequest(buf).then((reply) => {
          if (reply) socket.write(reply);
        });
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        port: addr.port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

describe("S7 codec", () => {
  it("parses DB/M/I/Q addresses and round-trips Read Var", () => {
    assert.deepEqual(parseAddress("DB1.DBW0"), {
      area: "DB",
      db: 1,
      byte: 0,
      bit: 0,
      type: "INT",
      count: 1,
    });
    assert.equal(parseAddress("MW10").byte, 10);
    const req = encodeReadVar(parseAddress("DB1.DBW0"));
    const decoded = decodeReadVar(req);
    assert.equal(decoded?.area, "DB");
    assert.equal(decoded?.byte, 0);
    const cr = encodeCotpCr(0, 1);
    assert.equal(cr[0], 0x03);
    assert.equal(cr[5], 0xe0);
  });
});

describe("S7Adapter", () => {
  it("rejects tools before connect", async () => {
    const adapter = new S7Adapter("plc");
    assert.equal((await adapter.health()).ok, false);
    await assert.rejects(() => adapter.listTools(), AdapterError);
  });

  it("reads DB/M from the memory image", async () => {
    const adapter = new S7Adapter("plc");
    await adapter.connect({});
    const tools = (await adapter.listTools()).map((t) => t.name);
    assert.deepEqual(tools, ["read", "list_areas", "write"]);
    const dbw = (await adapter.invoke("read", { address: "DB1.DBW0" })) as { value: number };
    assert.equal(dbw.value, 42);
    const mw = (await adapter.invoke("read", { address: "MW10" })) as { value: number };
    assert.equal(mw.value, 7);
    const areas = (await adapter.invoke("list_areas", {})) as { areas: unknown[] };
    assert.ok(areas.areas.length >= 3);
    await adapter.disconnect();
  });

  it("defaults allowWrite=false and gates write", async () => {
    const adapter = new S7Adapter("plc");
    await adapter.connect({});
    await assert.rejects(() => adapter.invoke("write", { address: "MW10", value: 1 }), /allowWrite/);
    await adapter.disconnect();
  });

  it("write mutates when allowWrite=true", async () => {
    const adapter = new S7Adapter("plc");
    await adapter.connect({ allowWrite: true });
    await adapter.invoke("write", { address: "MW10", value: 99 });
    const mw = (await adapter.invoke("read", { address: "MW10" })) as { value: number };
    assert.equal(mw.value, 99);
    await adapter.disconnect();
  });

  it("ISO-TCP COTP + Read Var against a loopback mock PDU", async () => {
    const fake = await listenS7();
    const adapter = new S7Adapter("plc");
    try {
      await adapter.connect({ host: "127.0.0.1", port: fake.port, tcp: true, rack: 0, slot: 1 });
      const dbw = (await adapter.invoke("read", { address: "DB1.DBW0" })) as { value: number; transport: string };
      assert.equal(dbw.value, 42);
      assert.equal(dbw.transport, "iso-tcp");
      assert.equal(isCotpCc(Buffer.from([0x03, 0x00, 0x00, 0x07, 0x02, 0xd0, 0x00])), true);
    } finally {
      await adapter.disconnect();
      await fake.close();
    }
  });
});
