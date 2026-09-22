import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SmbAdapter, listenSmb2Loopback, parseSmb2Dialect, buildSmb2Negotiate } from "../src/adapters/smb/index.js";
import { createAdapter, registerBuiltinAdapters } from "../src/adapters/index.js";
import { AdapterError } from "../src/runtime/errors.js";

registerBuiltinAdapters();

describe("SMB/CIFS honest MVP", () => {
  it("simulator list/get; cifs alias", async () => {
    assert.equal(createAdapter("cifs", "x").protocol, "smb");
    const a = new SmbAdapter("smb:t");
    await a.connect({ simulator: true });
    const listed = (await a.invoke("list", {})) as { files: string[] };
    assert.ok(listed.files.includes("readme.txt"));
    const got = (await a.invoke("get", { name: "readme.txt" })) as { body: string };
    assert.match(got.body, /smb/);
    await a.disconnect();
  });

  it("live TCP negotiate dialect; file ops stay E_UNSUPPORTED", async () => {
    const loop = await listenSmb2Loopback();
    const a = new SmbAdapter("smb:live");
    try {
      await a.connect({ host: "127.0.0.1", port: loop.port });
      const neg = (await a.invoke("negotiate", {})) as { dialect: string };
      assert.match(neg.dialect, /0x0311/i);
      await assert.rejects(
        () => a.invoke("list", {}),
        (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
      );
    } finally {
      await a.disconnect();
      await loop.close();
    }
  });

  it("builds an SMB2 negotiate frame", () => {
    const pkt = buildSmb2Negotiate();
    assert.ok(pkt.length > 8);
    assert.equal(parseSmb2Dialect(Buffer.from([0, 0, 0, 0])), undefined);
  });
});
