import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NfsAdapter, listenNfsLoopback, encodeRpcNull, decodeRpcAccepted } from "../src/adapters/nfs/index.js";
import { AdapterError } from "../src/runtime/errors.js";

describe("NFS honest subset", () => {
  it("simulator ping + list_exports", async () => {
    const a = new NfsAdapter("nfs:t");
    await a.connect({ simulator: true });
    const ping = (await a.invoke("ping", {})) as { ok: boolean; program: number };
    assert.equal(ping.ok, true);
    assert.equal(ping.program, 100003);
    const listed = (await a.invoke("list_exports", {})) as { exports: unknown[] };
    assert.ok(listed.exports.length >= 1);
    await a.disconnect();
  });

  it("live NFSv3 NULL ping; SHOWMOUNT stays E_UNSUPPORTED", async () => {
    const loop = await listenNfsLoopback();
    const a = new NfsAdapter("nfs:live");
    try {
      await a.connect({ host: "127.0.0.1", port: loop.port });
      const ping = (await a.invoke("ping", {})) as { ok: boolean };
      assert.equal(ping.ok, true);
      await assert.rejects(
        () => a.invoke("list_exports", {}),
        (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
      );
    } finally {
      await a.disconnect();
      await loop.close();
    }
  });

  it("RPC codec round-trip helpers", () => {
    const pkt = encodeRpcNull(1, 100003, 3);
    assert.ok(pkt.length > 4);
    const body = Buffer.alloc(28);
    body.writeUInt32BE(1, 0);
    body.writeUInt32BE(1, 4);
    body.writeUInt32BE(0, 8);
    const header = Buffer.alloc(4);
    header.writeUInt32BE((28 | 0x80000000) >>> 0, 0);
    assert.equal(decodeRpcAccepted(Buffer.concat([header, body])), true);
  });
});
