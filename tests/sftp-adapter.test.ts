import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SftpAdapter, listenSftpLoopback } from "../src/adapters/sftp/index.js";
import { AdapterError } from "../src/runtime/errors.js";

describe("SftpAdapter", () => {
  it("memory list/get; put/delete gated by allowWrite", async () => {
    const adapter = new SftpAdapter("sftp.mem");
    await adapter.connect({ simulator: true });
    const listed = (await adapter.invoke("list", {})) as { names: string[] };
    assert.ok(listed.names.includes("readme.txt"));
    const got = (await adapter.invoke("get", { path: "readme.txt" })) as { body: string };
    assert.equal(got.body, "hello sftp");
    await assert.rejects(
      () => adapter.invoke("put", { path: "a.txt", body: "x" }),
      (err: unknown) => err instanceof AdapterError && /allowWrite/.test(String(err)),
    );
    await adapter.disconnect();
  });

  it("ssh2 SFTP loopback list/get/put (not FTP)", async () => {
    const loop = await listenSftpLoopback({ user: "e2mcp", password: "sftp" });
    const adapter = new SftpAdapter("sftp.live");
    try {
      await adapter.connect({
        host: "127.0.0.1",
        port: loop.port,
        user: "e2mcp",
        password: "sftp",
        allowWrite: true,
        timeoutMs: 4000,
      });
      const listed = (await adapter.invoke("list", {})) as { names: string[] };
      assert.ok(listed.names.includes("readme.txt"));
      const got = (await adapter.invoke("get", { path: "readme.txt" })) as { body: string };
      assert.equal(got.body, "hello sftp");
      await adapter.invoke("put", { path: "new.txt", body: "fresh" });
      const again = (await adapter.invoke("get", { path: "new.txt" })) as { body: string };
      assert.equal(again.body, "fresh");
    } finally {
      await adapter.disconnect();
      await loop.close();
    }
  });
});
