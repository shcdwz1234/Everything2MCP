import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";
import { describe, it } from "node:test";
import { listenMemcachedLoopback } from "../src/adapters/memcached/index.js";
import { listenTftpLoopback } from "../src/adapters/tftp/index.js";
import { fingerprintMemcached, fingerprintSftp, fingerprintTftp } from "../src/discovery/fingerprint.js";
import { scanHost } from "../src/discovery/scan.js";
import { suggestFromCandidates } from "../src/discovery/suggest.js";

describe("Phase P discovery (SFTP / Memcached / TFTP)", () => {
  it("fingerprints SSH-2 banner as sftp", async () => {
    const ssh = createNetServer((socket) => {
      socket.write("SSH-2.0-e2mcp_sftp\r\n");
    });
    const port = await new Promise<number>((resolve) => {
      ssh.listen(0, "127.0.0.1", () => resolve((ssh.address() as { port: number }).port));
    });
    try {
      const hit = await fingerprintSftp("127.0.0.1", port, 800);
      assert.equal(hit?.protocol, "sftp");
      assert.equal((hit?.config as { allowWrite?: boolean }).allowWrite, false);
    } finally {
      ssh.close();
    }
  });

  it("fingerprints memcached STATS and TFTP DATA", async () => {
    const mc = await listenMemcachedLoopback();
    const tftp = await listenTftpLoopback();
    try {
      const mem = await fingerprintMemcached("127.0.0.1", mc.port, 800);
      assert.equal(mem?.protocol, "memcached");
      const tf = await fingerprintTftp("127.0.0.1", tftp.port, 800);
      assert.equal(tf?.protocol, "tftp");
      const scanned = await scanHost({
        host: "127.0.0.1",
        port: mc.port,
        onlyGivenPort: true,
        protocols: ["memcached"],
        timeoutMs: 800,
      });
      const suggestions = suggestFromCandidates(scanned);
      assert.equal(suggestions[0]?.protocol, "memcached");
      assert.equal((suggestions[0]?.config as { allowWrite?: boolean }).allowWrite, false);
    } finally {
      await mc.close();
      await tftp.close();
    }
  });
});
