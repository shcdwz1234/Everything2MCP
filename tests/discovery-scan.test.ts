import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { scanHost } from "../src/discovery/scan.js";
import { encodeAck } from "../src/adapters/opcua/hello.js";
import { suggestFromCandidates } from "../src/discovery/suggest.js";
import { looksLikeNetworkRange } from "../src/discovery/probe.js";
import { AdapterError } from "../src/runtime/errors.js";

const spec = readFileSync(fileURLToPath(new URL("../examples/petstore.openapi.json", import.meta.url)), "utf8");

describe("discovery_scan_host", () => {
  let httpPort = 0;
  let httpServer: ReturnType<typeof createServer>;
  let redisPort = 0;
  let redisServer: ReturnType<typeof createNetServer>;

  before(async () => {
    httpServer = createServer((req, res) => {
      if (req.url === "/openapi.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(spec);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    httpPort = await listen(httpServer);
    redisServer = createNetServer((socket) => {
      socket.on("data", (buf) => {
        if (buf.toString().includes("PING")) socket.end("+PONG\r\n");
        else socket.end();
      });
    });
    redisPort = await listen(redisServer);
  });

  after(() => {
    httpServer.close();
    redisServer.close();
  });

  it("still refuses CIDR", () => {
    assert.equal(looksLikeNetworkRange("10.0.0.0/8"), true);
    assert.equal(looksLikeNetworkRange("192.168.0.0/16"), true);
    assert.equal(looksLikeNetworkRange("10.0.0.1-20"), true);
    assert.equal(looksLikeNetworkRange("10.0.0.1-10.0.0.255"), true);
    assert.equal(looksLikeNetworkRange("10.0.0.1,10.0.0.2"), true);
    assert.equal(looksLikeNetworkRange("10.0.0.*"), true);
    assert.equal(looksLikeNetworkRange("127.0.0.1"), false);
  });

  it("finds OpenAPI on a single host+port and suggests mcp_add", async () => {
    const candidates = await scanHost({
      host: "127.0.0.1",
      port: httpPort,
      onlyGivenPort: true,
      protocols: ["openapi"],
      timeoutMs: 1500,
    });
    assert.ok(candidates.some((c) => c.protocol === "openapi" && c.url.includes("/openapi.json")));
    const suggestions = suggestFromCandidates(candidates);
    assert.equal(suggestions[0]?.protocol, "openapi");
    assert.ok((suggestions[0]?.confidence ?? 0) >= 0.9);
    assert.equal((suggestions[0]?.config as { spec?: string }).spec?.includes("openapi.json"), true);
  });

  it("fingerprints Redis PING on a loopback fake", async () => {
    const candidates = await scanHost({
      host: "127.0.0.1",
      port: redisPort,
      onlyGivenPort: true,
      protocols: ["redis"],
      timeoutMs: 1500,
    });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.protocol, "redis");
  });

  it("fingerprints PostgreSQL SSLRequest and MySQL greeting", async () => {
    const pgServer = createNetServer((socket) => {
      socket.on("data", () => socket.end("N"));
    });
    const pgPort = await listen(pgServer);
    const myServer = createNetServer((socket) => {
      const payload = Buffer.concat([Buffer.from([0x0a]), Buffer.from("8.0.36\0")]);
      const hdr = Buffer.alloc(4);
      hdr.writeUIntLE(payload.length, 0, 3);
      socket.write(Buffer.concat([hdr, payload]));
    });
    const myPort = await listen(myServer);
    try {
      const pg = await scanHost({
        host: "127.0.0.1",
        port: pgPort,
        onlyGivenPort: true,
        protocols: ["postgres"],
        timeoutMs: 1500,
      });
      assert.equal(pg[0]?.protocol, "postgres");
      const suggestions = suggestFromCandidates(pg);
      assert.equal(suggestions[0]?.protocol, "postgres");
      assert.equal((suggestions[0]?.config as { allowWrite?: boolean }).allowWrite, false);

      const my = await scanHost({
        host: "127.0.0.1",
        port: myPort,
        onlyGivenPort: true,
        protocols: ["mysql"],
        timeoutMs: 1500,
      });
      assert.equal(my[0]?.protocol, "mysql");
    } finally {
      pgServer.close();
      myServer.close();
    }
  });

  it("blocks metadata hosts", async () => {
    await assert.rejects(
      () => scanHost({ host: "169.254.169.254", timeoutMs: 500, protocols: ["redis"] }),
      AdapterError,
    );
  });

  it("refuses CIDR / range hosts at scanHost", async () => {
    await assert.rejects(
      () => scanHost({ host: "10.0.0.0/8", timeoutMs: 200, protocols: ["redis"] }),
      (err: unknown) => err instanceof AdapterError && /range/i.test((err as Error).message),
    );
  });

  it("honors timeoutMs on a hanging TCP peer", async () => {
    const hanging = createNetServer((_socket) => {
      /* accept but never reply */
    });
    const port = await listen(hanging);
    try {
      const started = Date.now();
      const candidates = await scanHost({
        host: "127.0.0.1",
        port,
        onlyGivenPort: true,
        protocols: ["redis"],
        timeoutMs: 120,
      });
      const elapsed = Date.now() - started;
      assert.equal(candidates.length, 0);
      assert.ok(elapsed < 2500, `scan hung (${elapsed}ms)`);
    } finally {
      hanging.close();
    }
  });

  it("honors timeoutMs on a hanging HTTP OpenAPI probe", async () => {
    const hanging = createServer(() => {
      /* never respond */
    });
    const port = await listen(hanging);
    try {
      const started = Date.now();
      const candidates = await scanHost({
        host: "127.0.0.1",
        port,
        onlyGivenPort: true,
        protocols: ["openapi"],
        timeoutMs: 120,
      });
      const elapsed = Date.now() - started;
      assert.equal(candidates.length, 0);
      assert.ok(elapsed < 2500, `http scan hung (${elapsed}ms)`);
    } finally {
      hanging.close();
    }
  });

  it("fingerprints SQL Server TDS, MongoDB, Neo4j Bolt, ES, ClickHouse, Qdrant", async () => {
    const tds = createNetServer((socket) => {
      socket.on("data", () => socket.end(Buffer.from([0x04, 0x01, 0x00, 0x08])));
    });
    const mongo = createNetServer((socket) => {
      socket.on("data", () => socket.end(Buffer.from("ismaster maxBsonObjectSize")));
    });
    const bolt = createNetServer((socket) => {
      socket.on("data", () => socket.end(Buffer.from([0x00, 0x00, 0x00, 0x01])));
    });
    const es = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ tagline: "You Know, for Search" }));
    });
    const ch = createServer((_req, res) => {
      res.writeHead(200);
      res.end("Ok.\n");
    });
    const qd = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ title: "qdrant - vector search engine" }));
    });
    const tdsPort = await listen(tds);
    const mongoPort = await listen(mongo);
    const boltPort = await listen(bolt);
    const esPort = await listen(es);
    const chPort = await listen(ch);
    const qdPort = await listen(qd);
    try {
      const sqls = await scanHost({
        host: "127.0.0.1",
        port: tdsPort,
        onlyGivenPort: true,
        protocols: ["sqlserver"],
        timeoutMs: 1500,
      });
      assert.equal(sqls[0]?.protocol, "sqlserver");

      const md = await scanHost({
        host: "127.0.0.1",
        port: mongoPort,
        onlyGivenPort: true,
        protocols: ["mongodb"],
        timeoutMs: 1500,
      });
      assert.equal(md[0]?.protocol, "mongodb");
      assert.equal((suggestFromCandidates(md)[0]?.config as { allowWrite?: boolean }).allowWrite, false);

      const nj = await scanHost({
        host: "127.0.0.1",
        port: boltPort,
        onlyGivenPort: true,
        protocols: ["neo4j"],
        timeoutMs: 1500,
      });
      assert.equal(nj[0]?.protocol, "neo4j");

      const esHit = await scanHost({
        host: "127.0.0.1",
        port: esPort,
        onlyGivenPort: true,
        protocols: ["elasticsearch"],
        timeoutMs: 1500,
      });
      assert.equal(esHit[0]?.protocol, "elasticsearch");

      const chHit = await scanHost({
        host: "127.0.0.1",
        port: chPort,
        onlyGivenPort: true,
        protocols: ["clickhouse"],
        timeoutMs: 1500,
      });
      assert.equal(chHit[0]?.protocol, "clickhouse");

      const qdHit = await scanHost({
        host: "127.0.0.1",
        port: qdPort,
        onlyGivenPort: true,
        protocols: ["qdrant"],
        timeoutMs: 1500,
      });
      assert.equal(qdHit[0]?.protocol, "qdrant");
    } finally {
      tds.close();
      mongo.close();
      bolt.close();
      es.close();
      ch.close();
      qd.close();
    }
  });

  it("fingerprints MinIO on 9000-style health and Prometheus /-/healthy", async () => {
    const minio = createServer((req, res) => {
      if (req.url === "/minio/health/live") {
        res.writeHead(200);
        res.end();
        return;
      }
      res.writeHead(403, { "content-type": "application/xml" });
      res.end("<Error><Code>AccessDenied</Code><Message>MinIO</Message></Error>");
    });
    const prom = createServer((req, res) => {
      if (req.url === "/-/healthy") {
        res.writeHead(200);
        res.end("Prometheus Server is Healthy.");
        return;
      }
      if (req.url?.startsWith("/api/v1/status/buildinfo")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "success", data: { version: "2.53.0" } }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const minioPort = await listen(minio);
    const promPort = await listen(prom);
    try {
      const s3 = await scanHost({
        host: "127.0.0.1",
        port: minioPort,
        onlyGivenPort: true,
        protocols: ["s3"],
        timeoutMs: 1500,
      });
      assert.equal(s3[0]?.protocol, "s3");
      const s3sug = suggestFromCandidates(s3);
      assert.equal((s3sug[0]?.config as { allowWrite?: boolean }).allowWrite, false);
      assert.equal((s3sug[0]?.config as { unsigned?: boolean }).unsigned, true);

      const p = await scanHost({
        host: "127.0.0.1",
        port: promPort,
        onlyGivenPort: true,
        protocols: ["prometheus"],
        timeoutMs: 1500,
      });
      assert.equal(p[0]?.protocol, "prometheus");
      assert.equal((suggestFromCandidates(p)[0]?.config as { url?: string }).url?.includes(String(promPort)), true);
    } finally {
      minio.close();
      prom.close();
    }
  });

  it("fingerprints BACnet/IP via unicast Who-Is (not broadcast)", async () => {
    const { createSocket } = await import("node:dgram");
    const { decodeWhoIs, encodeIAm, bvlcFunction, BVLC_ORIGINAL_UNICAST_NPDU, BVLC_ORIGINAL_BROADCAST_NPDU } =
      await import("../src/adapters/bacnet/codec.js");
    const sock = createSocket("udp4");
    let sawBroadcast = false;
    sock.on("message", (msg, rinfo) => {
      const fn = bvlcFunction(msg);
      if (fn === BVLC_ORIGINAL_BROADCAST_NPDU) sawBroadcast = true;
      const who = decodeWhoIs(msg);
      if (!who) return;
      if (fn !== BVLC_ORIGINAL_UNICAST_NPDU) return;
      sock.send(encodeIAm({ deviceId: 8801, vendorId: 42 }), rinfo.port, rinfo.address);
    });
    const bacnetPort = await new Promise<number>((resolve) => {
      sock.bind(0, "127.0.0.1", () => {
        const addr = sock.address() as { port: number };
        resolve(addr.port);
      });
    });
    try {
      const hit = await scanHost({
        host: "127.0.0.1",
        port: bacnetPort,
        onlyGivenPort: true,
        protocols: ["bacnet"],
        timeoutMs: 800,
      });
      assert.equal(hit[0]?.protocol, "bacnet");
      assert.equal(sawBroadcast, false);
      const sug = suggestFromCandidates(hit);
      assert.equal(sug[0]?.protocol, "bacnet");
      const cfg = sug[0]?.config as { host?: string; port?: number; udp?: boolean; allowWrite?: boolean };
      assert.equal(cfg.host, "127.0.0.1");
      assert.equal(cfg.port, bacnetPort);
      assert.equal(cfg.udp, true);
      assert.equal(cfg.allowWrite, false);
    } finally {
      await new Promise<void>((resolve) => sock.close(() => resolve()));
    }
  });

  it("fingerprints EtherNet/IP List Identity, S7 COTP CC, and MTConnect /probe (unicast only)", async () => {
    const { createServer: createNetServer } = await import("node:net");
    const { encodeListIdentityReply, decodeEncapsulation, CMD_LIST_IDENTITY } = await import(
      "../src/adapters/ethernetip/codec.js"
    );
    const { encodeCotpCc } = await import("../src/adapters/s7/codec.js");
    const probeXml = readFileSync(fileURLToPath(new URL("../examples/mtconnect-probe.xml", import.meta.url)), "utf8");

    const enip = createNetServer((socket) => {
      socket.on("data", (buf) => {
        const enc = decodeEncapsulation(buf);
        if (enc?.command === CMD_LIST_IDENTITY) {
          socket.end(
            encodeListIdentityReply({
              vendorId: 1,
              deviceType: 14,
              productCode: 1,
              revision: "1.0",
              serial: 7,
              productName: "scan-plc",
              ip: "127.0.0.1",
              port: 44818,
            }),
          );
        }
      });
    });
    const s7 = createNetServer((socket) => {
      socket.on("data", (buf) => {
        if (buf[0] === 0x03 && buf[5] === 0xe0) socket.end(encodeCotpCc());
      });
    });
    const mtc = createServer((req, res) => {
      if (req.url === "/probe") {
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(probeXml);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const enipPort = await listen(enip);
    const s7Port = await listen(s7);
    const mtcPort = await listen(mtc);
    try {
      const cip = await scanHost({
        host: "127.0.0.1",
        port: enipPort,
        onlyGivenPort: true,
        protocols: ["ethernetip"],
        timeoutMs: 1500,
      });
      assert.equal(cip[0]?.protocol, "ethernetip");
      const cipCfg = suggestFromCandidates(cip)[0]?.config as { tcp?: boolean; allowWrite?: boolean; port?: number };
      assert.equal(cipCfg.tcp, true);
      assert.equal(cipCfg.allowWrite, false);
      assert.equal(cipCfg.port, enipPort);

      const siemens = await scanHost({
        host: "127.0.0.1",
        port: s7Port,
        onlyGivenPort: true,
        protocols: ["s7"],
        timeoutMs: 1500,
      });
      assert.equal(siemens[0]?.protocol, "s7");
      const s7cfg = suggestFromCandidates(siemens)[0]?.config as { tcp?: boolean; allowWrite?: boolean };
      assert.equal(s7cfg.tcp, true);
      assert.equal(s7cfg.allowWrite, false);

      const agent = await scanHost({
        host: "127.0.0.1",
        port: mtcPort,
        onlyGivenPort: true,
        protocols: ["mtconnect"],
        timeoutMs: 1500,
      });
      assert.equal(agent[0]?.protocol, "mtconnect");
      assert.equal(String(suggestFromCandidates(agent)[0]?.config.url).includes(String(mtcPort)), true);
    } finally {
      enip.close();
      s7.close();
      mtc.close();
    }
  });

  it("fingerprints Pulsar HTTP admin and TCP banner (single host, no CIDR)", async () => {
    const admin = createServer((req, res) => {
      if (req.url === "/admin/v2/brokers/ready") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const tcp = createNetServer((socket) => {
      socket.on("data", () => {
        socket.end("pulsar-broker");
      });
    });
    const adminPort = await listen(admin);
    const tcpPort = await listen(tcp);
    try {
      const httpHit = await scanHost({
        host: "127.0.0.1",
        port: adminPort,
        onlyGivenPort: true,
        protocols: ["pulsar"],
        timeoutMs: 1500,
      });
      assert.equal(httpHit[0]?.protocol, "pulsar");
      const httpCfg = suggestFromCandidates(httpHit)[0]?.config as {
        allowWrite?: boolean;
        topic?: string;
        serviceUrl?: string;
      };
      assert.equal(httpCfg.allowWrite, false);
      assert.equal(httpCfg.topic, "events");
      assert.ok(String(httpCfg.serviceUrl).includes(String(adminPort)));

      const tcpHit = await scanHost({
        host: "127.0.0.1",
        port: tcpPort,
        onlyGivenPort: true,
        protocols: ["pulsar"],
        timeoutMs: 1500,
      });
      assert.equal(tcpHit[0]?.protocol, "pulsar");
      assert.match(String(tcpHit[0]?.url), /pulsar:\/\//);
      assert.equal((suggestFromCandidates(tcpHit)[0]?.config as { allowWrite?: boolean }).allowWrite, false);

      await assert.rejects(
        () => scanHost({ host: "10.0.0.0/8", timeoutMs: 200, protocols: ["pulsar"] }),
        AdapterError,
      );
    } finally {
      admin.close();
      tcp.close();
    }
  });

  it("fingerprints GCS JSON API, Aliyun OSS headers, and InfluxDB /health (no CIDR)", async () => {
    const gcs = createServer((req, res) => {
      if (req.url === "/storage/v1/b") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ kind: "storage#buckets", items: [] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const oss = createServer((_req, res) => {
      res.writeHead(403, {
        "content-type": "application/xml",
        "x-oss-request-id": "0001",
        server: "AliyunOSS",
      });
      res.end("<Error><Code>AccessDenied</Code><Message>AliyunOSS</Message></Error>");
    });
    const influx = createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "influxdb", status: "pass", version: "2.7.0" }));
        return;
      }
      if (req.url === "/ping") {
        res.writeHead(204, { "x-influxdb-version": "2.7.0" });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const gcsPort = await listen(gcs);
    const ossPort = await listen(oss);
    const influxPort = await listen(influx);
    try {
      const g = await scanHost({
        host: "127.0.0.1",
        port: gcsPort,
        onlyGivenPort: true,
        protocols: ["gcs"],
        timeoutMs: 1500,
      });
      assert.equal(g[0]?.protocol, "gcs");
      const gcfg = suggestFromCandidates(g)[0]?.config as { allowWrite?: boolean; unsigned?: boolean; bucket?: string };
      assert.equal(gcfg.allowWrite, false);
      assert.equal(gcfg.unsigned, true);

      const o = await scanHost({
        host: "127.0.0.1",
        port: ossPort,
        onlyGivenPort: true,
        protocols: ["oss"],
        timeoutMs: 1500,
      });
      assert.equal(o[0]?.protocol, "oss");
      assert.equal((suggestFromCandidates(o)[0]?.config as { allowWrite?: boolean }).allowWrite, false);

      const inf = await scanHost({
        host: "127.0.0.1",
        port: influxPort,
        onlyGivenPort: true,
        protocols: ["influx"],
        timeoutMs: 1500,
      });
      assert.equal(inf[0]?.protocol, "influx");
      const icfg = suggestFromCandidates(inf)[0]?.config as { allowWrite?: boolean; bucket?: string };
      assert.equal(icfg.allowWrite, false);
      assert.equal(icfg.bucket, "metrics");

      await assert.rejects(
        () => scanHost({ host: "10.0.0.0/8", timeoutMs: 200, protocols: ["influx", "gcs", "oss"] }),
        AdapterError,
      );
    } finally {
      gcs.close();
      oss.close();
      influx.close();
    }
  });

  it("fingerprints Kafka, AMQP, and OPC UA on a single host (no CIDR)", async () => {
    const kafka = createNetServer((socket) => {
      socket.on("data", () => {
        const resp = Buffer.alloc(8);
        resp.writeInt32BE(4, 0);
        resp.writeInt32BE(7, 4);
        socket.end(resp);
      });
    });
    const amqp = createNetServer((socket) => {
      socket.on("data", () => socket.end(Buffer.from("AMQP\x00\x00\x09\x01")));
    });
    const opc = createNetServer((socket) => {
      socket.on("data", () => socket.end(encodeAck(0)));
    });
    const kafkaPort = await listen(kafka);
    const amqpPort = await listen(amqp);
    const opcPort = await listen(opc);
    try {
      const k = await scanHost({
        host: "127.0.0.1",
        port: kafkaPort,
        onlyGivenPort: true,
        protocols: ["kafka"],
        timeoutMs: 1500,
      });
      assert.equal(k[0]?.protocol, "kafka");
      assert.deepEqual((suggestFromCandidates(k)[0]?.config as { brokers?: string[]; allowWrite?: boolean }).allowWrite, false);

      const a = await scanHost({
        host: "127.0.0.1",
        port: amqpPort,
        onlyGivenPort: true,
        protocols: ["amqp"],
        timeoutMs: 1500,
      });
      assert.equal(a[0]?.protocol, "amqp");

      const o = await scanHost({
        host: "127.0.0.1",
        port: opcPort,
        onlyGivenPort: true,
        protocols: ["opcua"],
        timeoutMs: 1500,
      });
      assert.equal(o[0]?.protocol, "opcua");
      assert.match(String(o[0]?.url), /opc\.tcp:/);

      await assert.rejects(
        () => scanHost({ host: "10.0.0.0/8", timeoutMs: 200, protocols: ["kafka"] }),
        AdapterError,
      );
    } finally {
      kafka.close();
      amqp.close();
      opc.close();
    }
  });

  it("fingerprints SMTP 220 banner on a loopback fake (port 25 family)", async () => {
    const smtp = createNetServer((socket) => {
      socket.write("220 localhost ESMTP everything2mcp\r\n");
    });
    const smtpPort = await listen(smtp);
    try {
      const hits = await scanHost({
        host: "127.0.0.1",
        port: smtpPort,
        onlyGivenPort: true,
        protocols: ["smtp"],
        timeoutMs: 1500,
      });
      assert.equal(hits[0]?.protocol, "smtp");
      assert.match(String(hits[0]?.url), /^smtp:\/\//);
      const suggestions = suggestFromCandidates(hits);
      assert.equal(suggestions[0]?.protocol, "smtp");
      assert.equal((suggestions[0]?.config as { allowWrite?: boolean }).allowWrite, false);
    } finally {
      smtp.close();
    }
  });

  it("fingerprints FTP 220 banner and suggests allowWrite=false", async () => {
    const ftp = createNetServer((socket) => {
      socket.write("220 e2mcp FTP ready\r\n");
    });
    const ftpPort = await listen(ftp);
    try {
      const hits = await scanHost({
        host: "127.0.0.1",
        port: ftpPort,
        onlyGivenPort: true,
        protocols: ["ftp"],
        timeoutMs: 1500,
      });
      assert.equal(hits[0]?.protocol, "ftp");
      const suggestions = suggestFromCandidates(hits);
      assert.equal(suggestions[0]?.protocol, "ftp");
      assert.equal((suggestions[0]?.config as { allowWrite?: boolean }).allowWrite, false);
    } finally {
      ftp.close();
    }
  });

  it("finds OpenAPI on /.well-known/openapi.json", async () => {
    const well = createServer((req, res) => {
      if (req.url === "/.well-known/openapi.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(spec);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const port = await listen(well);
    try {
      const candidates = await scanHost({
        host: "127.0.0.1",
        port,
        onlyGivenPort: true,
        protocols: ["openapi"],
        timeoutMs: 1500,
      });
      assert.ok(candidates.some((c) => c.url.includes("/.well-known/openapi.json")));
    } finally {
      well.close();
    }
  });

  it("fingerprints WebDAV OPTIONS DAV header", async () => {
    const dav = createServer((req, res) => {
      if (req.method === "OPTIONS") {
        res.writeHead(200, { DAV: "1,2", Allow: "OPTIONS, GET, PROPFIND" });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const port = await listen(dav);
    try {
      const hits = await scanHost({
        host: "127.0.0.1",
        port,
        onlyGivenPort: true,
        protocols: ["webdav"],
        timeoutMs: 1500,
      });
      assert.ok(hits.some((c) => c.protocol === "webdav"));
      const suggestions = suggestFromCandidates(hits.filter((c) => c.protocol === "webdav"));
      assert.equal((suggestions[0]?.config as { allowWrite?: boolean }).allowWrite, false);
    } finally {
      dav.close();
    }
  });
});

function listen(server: { listen: (port: number, host: string, cb: () => void) => void; address: () => unknown }): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve(addr.port);
    });
  });
}
