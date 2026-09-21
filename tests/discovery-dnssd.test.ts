import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { describe, it } from "node:test";
import {
  decodeDnsMessage,
  encodeDnsName,
  encodeDnsPtrResponse,
  encodeDnsQuery,
  mdnsMulticastBrowse,
  mdnsUnicastQuery,
  MDNS_MULTICAST,
} from "../src/discovery/dnssd.js";
import { fingerprintConsul, fingerprintImap, fingerprintPop3, fingerprintAzureBlob, httpGet } from "../src/discovery/fingerprint.js";
import { scanHost } from "../src/discovery/scan.js";
import { suggestFromCandidates } from "../src/discovery/suggest.js";
import { AdapterError } from "../src/runtime/errors.js";

describe("Phase O discovery (DNS-SD unicast / IMAP / POP3 / Consul / Azure)", () => {
  it("mDNS multicast and CIDR stay E_UNSUPPORTED; codec round-trips PTR", () => {
    assert.throws(
      () => mdnsMulticastBrowse(),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
    const q = encodeDnsQuery("_imap._tcp.local");
    assert.ok(q.length > 12);
    const ptr = encodeDnsPtrResponse("_services._dns-sd._udp.local", "_imap._tcp.local");
    const decoded = decodeDnsMessage(ptr);
    assert.equal(decoded.answers[0]?.data, "_imap._tcp.local");
    const name = encodeDnsName("mail._imap._tcp.local");
    assert.ok(name[0] === 4);
  });

  it("unicast DNS-SD PTR on loopback maps to imap and feeds suggest", async () => {
    await assert.rejects(
      () => mdnsUnicastQuery({ host: "10.0.0.0/8", timeoutMs: 200 }),
      (err: unknown) => err instanceof AdapterError,
    );
    await assert.rejects(
      () => mdnsUnicastQuery({ host: MDNS_MULTICAST, timeoutMs: 200 }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );

    const socket = createSocket("udp4");
    await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", () => resolve()));
    const port = socket.address().port;
    socket.on("message", (msg, rinfo) => {
      const q = decodeDnsMessage(msg);
      assert.ok(q.id);
      socket.send(encodeDnsPtrResponse("_services._dns-sd._udp.local", "_imap._tcp.local", q.id), rinfo.port, rinfo.address);
    });
    try {
      const hit = await mdnsUnicastQuery({ host: "127.0.0.1", port, timeoutMs: 800 });
      assert.equal(hit?.protocol, "imap");
      assert.equal((hit?.config as { allowWrite?: boolean }).allowWrite, false);
      const scanned = await scanHost({
        host: "127.0.0.1",
        port,
        onlyGivenPort: true,
        protocols: ["mdns"],
        timeoutMs: 800,
      });
      assert.ok(scanned.some((c) => c.protocol === "imap"));
      const suggestions = suggestFromCandidates(scanned.filter((c) => c.protocol === "imap"));
      assert.equal(suggestions[0]?.protocol, "imap");
      assert.equal((suggestions[0]?.config as { allowWrite?: boolean }).allowWrite, false);
    } finally {
      socket.close();
    }
  });

  it("fingerprints IMAP / POP3 banners and Consul / Azure HTTP", async () => {
    const imap = createNetServer((socket) => {
      socket.write("* OK IMAP4rev1 e2mcp ready\r\n");
    });
    const pop = createNetServer((socket) => {
      socket.write("+OK POP3 e2mcp ready\r\n");
    });
    const imapPort = await listen(imap);
    const popPort = await listen(pop);

    const http = createServer((req, res) => {
      if (req.url === "/v1/status/leader") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('"127.0.0.1:8300"');
        return;
      }
      if ((req.url ?? "").includes("restype=container")) {
        res.writeHead(200, { "x-ms-request-id": "e2mcp", "content-type": "application/xml" });
        res.end("<EnumerationResults></EnumerationResults>");
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const httpPort = await listen(http);
    try {
      const imapHit = await fingerprintImap("127.0.0.1", imapPort, 800);
      assert.equal(imapHit?.protocol, "imap");
      assert.equal((imapHit?.config as { allowWrite?: boolean }).allowWrite, false);

      const popHit = await fingerprintPop3("127.0.0.1", popPort, 800);
      assert.equal(popHit?.protocol, "pop3");

      const consul = await fingerprintConsul("127.0.0.1", httpPort, 800, httpGet);
      assert.equal(consul?.protocol, "consul");

      const azure = await fingerprintAzureBlob("127.0.0.1", httpPort, 800, httpGet);
      assert.equal(azure?.protocol, "azureblob");
      assert.equal((azure?.config as { allowWrite?: boolean }).allowWrite, false);
    } finally {
      imap.close();
      pop.close();
      http.close();
    }
  });
});

function listen(server: { listen: (port: number, host: string, cb: () => void) => void; address: () => unknown }): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}
