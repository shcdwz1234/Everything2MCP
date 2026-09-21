import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FtpAdapter, listenFtpLoopback } from "../src/adapters/ftp/index.js";
import { AdapterError } from "../src/runtime/errors.js";

describe("FtpAdapter", () => {
  it("memory list / retr / stor gated by allowWrite", async () => {
    const adapter = new FtpAdapter("ftp.mem");
    await adapter.connect({ simulator: true });
    const listed = (await adapter.invoke("list", {})) as { names: string[] };
    assert.deepEqual(listed.names, []);
    await assert.rejects(
      () => adapter.invoke("stor", { path: "a.txt", body: "x" }),
      (err: unknown) => err instanceof AdapterError && /allowWrite/.test(String(err)),
    );
    await adapter.disconnect();

    const writer = new FtpAdapter("ftp.w");
    await writer.connect({ simulator: true, allowWrite: true });
    await writer.invoke("stor", { path: "a.txt", body: "hello" });
    const got = (await writer.invoke("retr", { path: "a.txt" })) as { body: string };
    assert.equal(got.body, "hello");
    await writer.invoke("dele", { path: "a.txt" });
    await assert.rejects(() => writer.invoke("retr", { path: "a.txt" }), AdapterError);
    await writer.disconnect();
  });

  it("PASV loopback LIST/RETR/STOR", async () => {
    const loop = await listenFtpLoopback();
    const adapter = new FtpAdapter("ftp.live");
    try {
      await adapter.connect({ host: "127.0.0.1", port: loop.port, allowWrite: true, timeoutMs: 1500 });
      const listed = (await adapter.invoke("list", {})) as { names: string[] };
      assert.ok(listed.names.some((n) => n.includes("readme.txt")));
      const got = (await adapter.invoke("retr", { path: "readme.txt" })) as { body: string };
      assert.equal(got.body, "hello ftp");
      await adapter.invoke("stor", { path: "new.txt", body: "fresh" });
      const again = (await adapter.invoke("retr", { path: "new.txt" })) as { body: string };
      assert.equal(again.body, "fresh");
    } finally {
      await adapter.disconnect();
      await loop.close();
    }
  });
});
