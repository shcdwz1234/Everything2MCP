import assert from "node:assert/strict";
import { createServer } from "node:net";
import { describe, it } from "node:test";
import { AdapterError } from "../src/runtime/errors.js";
import { EthernetIpAdapter } from "../src/adapters/ethernetip/index.js";
import {
  CMD_LIST_IDENTITY,
  decodeEncapsulation,
  decodeListIdentityReply,
  encodeListIdentityReply,
  encodeListIdentityRequest,
} from "../src/adapters/ethernetip/codec.js";

function listenEnip(identity = {
  vendorId: 1,
  deviceType: 14,
  productCode: 54,
  revision: "2.1",
  serial: 99,
  productName: "fake-plc",
  ip: "127.0.0.1",
  port: 44818,
}): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      socket.on("data", (buf) => {
        const enc = decodeEncapsulation(buf);
        if (enc?.command === CMD_LIST_IDENTITY) socket.end(encodeListIdentityReply(identity));
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

describe("EtherNet/IP codec", () => {
  it("round-trips List Identity", () => {
    const req = encodeListIdentityRequest();
    const parsed = decodeEncapsulation(req);
    assert.equal(parsed?.command, CMD_LIST_IDENTITY);
    const reply = encodeListIdentityReply({
      vendorId: 1,
      deviceType: 14,
      productCode: 12,
      revision: "1.2",
      serial: 42,
      productName: "sim",
      ip: "10.0.0.8",
      port: 44818,
    });
    const id = decodeListIdentityReply(reply);
    assert.equal(id?.productName, "sim");
    assert.equal(id?.vendorId, 1);
    assert.equal(id?.serial, 42);
    assert.equal(id?.ip, "10.0.0.8");
  });
});

describe("EthernetIpAdapter", () => {
  it("rejects tools before connect", async () => {
    const adapter = new EthernetIpAdapter("line");
    assert.equal((await adapter.health()).ok, false);
    await assert.rejects(() => adapter.listTools(), AdapterError);
  });

  it("list_identities / read_tag on the memory table", async () => {
    const adapter = new EthernetIpAdapter("line");
    await adapter.connect({ productName: "cell-a", tags: [{ name: "Speed", type: "REAL", value: 3.5 }] });
    const tools = (await adapter.listTools()).map((t) => t.name);
    assert.deepEqual(tools, ["list_identities", "list_tags", "read_tag", "write_tag"]);
    const ids = (await adapter.invoke("list_identities", {})) as { identities: Array<{ productName: string }> };
    assert.equal(ids.identities[0]?.productName, "cell-a");
    const tag = (await adapter.invoke("read_tag", { name: "Speed" })) as { value: number };
    assert.equal(tag.value, 3.5);
    await adapter.disconnect();
  });

  it("defaults allowWrite=false and gates write_tag", async () => {
    const adapter = new EthernetIpAdapter("line");
    await adapter.connect({});
    await assert.rejects(() => adapter.invoke("write_tag", { name: "Heartbeat", value: 9 }), /allowWrite/);
    await adapter.disconnect();
  });

  it("write_tag mutates when allowWrite=true", async () => {
    const adapter = new EthernetIpAdapter("line");
    await adapter.connect({ allowWrite: true });
    await adapter.invoke("write_tag", { name: "Heartbeat", value: 9 });
    const tag = (await adapter.invoke("read_tag", { name: "Heartbeat" })) as { value: number };
    assert.equal(tag.value, 9);
    await adapter.disconnect();
  });

  it("fails on unknown tag", async () => {
    const adapter = new EthernetIpAdapter("line");
    await adapter.connect({});
    await assert.rejects(() => adapter.invoke("read_tag", { name: "Nope" }), AdapterError);
    await adapter.disconnect();
  });

  it("List Identity over TCP unicast (never a range scan)", async () => {
    const fake = await listenEnip();
    const adapter = new EthernetIpAdapter("line");
    try {
      await adapter.connect({ host: "127.0.0.1", port: fake.port, tcp: true });
      const ids = (await adapter.invoke("list_identities", {})) as {
        identities: Array<{ productName: string }>;
        transport: string;
      };
      assert.equal(ids.identities[0]?.productName, "fake-plc");
      assert.equal(ids.transport, "tcp-unicast");
    } finally {
      await adapter.disconnect();
      await fake.close();
    }
  });
});
