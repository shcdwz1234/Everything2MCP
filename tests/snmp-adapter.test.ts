import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { describe, it } from "node:test";
import {
  PDU_GET,
  PDU_RESPONSE,
  SYS_DESCR,
  decodeSnmp,
  encodeGet,
  encodeSnmpV2c,
} from "../src/adapters/snmp/codec.js";
import { SnmpAdapter } from "../src/adapters/snmp/index.js";
import { AdapterError } from "../src/runtime/errors.js";

function listenSnmp(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const socket = createSocket("udp4");
    socket.on("message", (msg, rinfo) => {
      const req = decodeSnmp(msg);
      const vb = req.varbinds[0] ?? { oid: SYS_DESCR, type: "null" as const, value: "" };
      const reply = encodeSnmpV2c({
        community: req.community,
        pduType: PDU_RESPONSE,
        requestId: req.requestId,
        errorStatus: 0,
        errorIndex: 0,
        varbinds: [{ oid: vb.oid || SYS_DESCR, type: "octet", value: "loopback-agent" }],
      });
      socket.send(reply, rinfo.port, rinfo.address);
    });
    socket.bind(0, "127.0.0.1", () => {
      const addr = socket.address();
      const port = typeof addr === "object" ? addr.port : 0;
      resolve({ port, close: () => socket.close() });
    });
  });
}

describe("SnmpAdapter", () => {
  it("encodes and decodes GetRequest sysDescr.0", () => {
    const packet = encodeGet("public", SYS_DESCR, 7);
    const msg = decodeSnmp(packet);
    assert.equal(msg.community, "public");
    assert.equal(msg.pduType, PDU_GET);
    assert.equal(msg.requestId, 7);
    assert.equal(msg.varbinds[0]?.oid, SYS_DESCR);
  });

  it("memory get / walk / set gated by allowWrite", async () => {
    const adapter = new SnmpAdapter("snmp.lab");
    await adapter.connect({ simulator: true });
    const got = (await adapter.invoke("get", { oid: SYS_DESCR })) as { value: string };
    assert.match(String(got.value), /everything2mcp/);
    const walked = (await adapter.invoke("walk", { oid: "1.3.6.1.2.1.1" })) as { varbinds: unknown[] };
    assert.ok(walked.varbinds.length >= 1);
    await assert.rejects(
      () => adapter.invoke("set", { oid: SYS_DESCR, value: "nope" }),
      (err: unknown) => err instanceof AdapterError && /allowWrite/.test(String(err)),
    );
    await adapter.disconnect();

    const writer = new SnmpAdapter("snmp.w");
    await writer.connect({ simulator: true, allowWrite: true });
    const set = (await writer.invoke("set", { oid: SYS_DESCR, value: "mutated" })) as { value: string };
    assert.equal(set.value, "mutated");
    await writer.disconnect();
  });

  it("UDP loopback GetResponse", async () => {
    const loop = await listenSnmp();
    const adapter = new SnmpAdapter("snmp.udp");
    try {
      await adapter.connect({ host: "127.0.0.1", port: loop.port, community: "public", timeoutMs: 800 });
      const got = (await adapter.invoke("get", { oid: SYS_DESCR })) as { value: string };
      assert.equal(got.value, "loopback-agent");
    } finally {
      await adapter.disconnect();
      loop.close();
    }
  });

  it("rejects unknown tools", async () => {
    const adapter = new SnmpAdapter("snmp.x");
    await adapter.connect({ simulator: true });
    await assert.rejects(() => adapter.invoke("trap", {}), AdapterError);
    await adapter.disconnect();
  });
});
