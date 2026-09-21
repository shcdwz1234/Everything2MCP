import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { scanHost } from "../src/discovery/scan.js";
import { encodeGet, SYS_DESCR, decodeSnmp, encodeSnmpV2c, PDU_RESPONSE } from "../src/adapters/snmp/codec.js";
import { encodeSsdpMsearch, mdnsDiscover, parseSsdpResponse, ssdpUnicastSearch } from "../src/discovery/ssdp.js";
import { looksLikeNetworkRange } from "../src/discovery/probe.js";
import { AdapterError } from "../src/runtime/errors.js";
import { fingerprintEtcd, fingerprintSnmp, httpGet } from "../src/discovery/fingerprint.js";

describe("Phase N discovery (SSDP unicast / SNMP / etcd)", () => {
  it("mdns multicast browse stays E_UNSUPPORTED; CIDR still refused", async () => {
    assert.throws(() => mdnsDiscover(), (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED");
    assert.equal(looksLikeNetworkRange("10.0.0.0/8"), true);
    await assert.rejects(
      () => ssdpUnicastSearch({ host: "10.0.0.0/8", timeoutMs: 200 }),
      (err: unknown) => err instanceof AdapterError,
    );
  });

  it("parses SSDP 200 and unicast M-SEARCH on loopback", async () => {
    const packet = encodeSsdpMsearch("127.0.0.1", 1900);
    assert.match(packet.toString("utf8"), /M-SEARCH/);
    assert.doesNotMatch(packet.toString("utf8"), /239\.255\.255\.250/);

    const parsed = parseSsdpResponse(
      Buffer.from("HTTP/1.1 200 OK\r\nLOCATION: http://127.0.0.1:9/root.xml\r\nST: upnp:rootdevice\r\n\r\n"),
    );
    assert.equal(parsed?.location, "http://127.0.0.1:9/root.xml");

    const socket = createSocket("udp4");
    await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", () => resolve()));
    const port = socket.address().port;
    socket.on("message", (msg, rinfo) => {
      assert.match(msg.toString("utf8"), /M-SEARCH/);
      socket.send(
        Buffer.from("HTTP/1.1 200 OK\r\nLOCATION: http://127.0.0.1:9/device.xml\r\nST: upnp:rootdevice\r\nSERVER: e2mcp/0.1\r\n\r\n"),
        rinfo.port,
        rinfo.address,
      );
    });
    try {
      const hit = await ssdpUnicastSearch({ host: "127.0.0.1", port, timeoutMs: 800 });
      assert.equal(hit?.url, "http://127.0.0.1:9/device.xml");
      assert.equal(hit?.protocol, "openapi");
      const scanned = await scanHost({
        host: "127.0.0.1",
        port,
        onlyGivenPort: true,
        protocols: ["ssdp"],
        timeoutMs: 800,
      });
      assert.ok(scanned.some((c) => String(c.detail ?? "").includes("upnp:rootdevice")));
    } finally {
      socket.close();
    }
  });

  it("fingerprints SNMPv2c GetResponse and etcd /version", async () => {
    const udp = createSocket("udp4");
    await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", () => resolve()));
    const snmpPort = udp.address().port;
    udp.on("message", (msg, rinfo) => {
      const req = decodeSnmp(msg);
      assert.equal(req.varbinds[0]?.oid, SYS_DESCR);
      udp.send(
        encodeSnmpV2c({
          community: "public",
          pduType: PDU_RESPONSE,
          requestId: req.requestId,
          errorStatus: 0,
          errorIndex: 0,
          varbinds: [{ oid: SYS_DESCR, type: "octet", value: "e2mcp" }],
        }),
        rinfo.port,
        rinfo.address,
      );
    });
    const http = createServer((req, res) => {
      if (req.url === "/version") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ etcdserver: "3.5.0", etcdcluster: "3.5.0" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const etcdPort = await new Promise<number>((resolve) => {
      http.listen(0, "127.0.0.1", () => resolve((http.address() as { port: number }).port));
    });
    try {
      const snmp = await fingerprintSnmp("127.0.0.1", snmpPort, 800);
      assert.equal(snmp?.protocol, "snmp");
      assert.equal((snmp?.config as { allowWrite?: boolean }).allowWrite, false);
      assert.ok(encodeGet("public", SYS_DESCR).length > 10);

      const etcd = await fingerprintEtcd("127.0.0.1", etcdPort, 800, httpGet);
      assert.equal(etcd?.protocol, "etcd");
    } finally {
      udp.close();
      await new Promise<void>((r) => http.close(() => r()));
    }
  });
});
