import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TftpAdapter, listenTftpLoopback, encodeTftpRequest, decodeTftp, TFTP_RRQ } from "../src/adapters/tftp/index.js";
import { AdapterError } from "../src/runtime/errors.js";

describe("TftpAdapter", () => {
  it("memory get; put gated by allowWrite", async () => {
    const adapter = new TftpAdapter("tftp.mem");
    await adapter.connect({ simulator: true });
    const got = (await adapter.invoke("get", { filename: "readme.txt" })) as { body: string };
    assert.equal(got.body, "hello tftp");
    await assert.rejects(
      () => adapter.invoke("put", { filename: "a.txt", body: "x" }),
      (err: unknown) => err instanceof AdapterError && /allowWrite/.test(String(err)),
    );
    await adapter.disconnect();
  });

  it("RFC1350 RRQ/WRQ loopback is not FTP", async () => {
    const loop = await listenTftpLoopback();
    const adapter = new TftpAdapter("tftp.live");
    try {
      await adapter.connect({ host: "127.0.0.1", port: loop.port, allowWrite: true, timeoutMs: 1500 });
      const got = (await adapter.invoke("get", { filename: "readme.txt" })) as { body: string };
      assert.equal(got.body, "hello tftp");
      await adapter.invoke("put", { filename: "new.txt", body: "fresh" });
      const again = (await adapter.invoke("get", { filename: "new.txt" })) as { body: string };
      assert.equal(again.body, "fresh");
      const pkt = encodeTftpRequest(TFTP_RRQ, "readme.txt");
      assert.equal(decodeTftp(pkt).opcode, TFTP_RRQ);
    } finally {
      await adapter.disconnect();
      await loop.close();
    }
  });
});
