import { encodeStartup, decodeFrame, OPCODE_READY, OPCODE_AUTHENTICATE } from "../adapters/cassandra/wire.js";
import { encodeTftpRequest, decodeTftp, TFTP_DATA, TFTP_ERROR } from "../adapters/tftp/index.js";
import { encodeGet, SYS_DESCR, decodeSnmp, PDU_RESPONSE } from "../adapters/snmp/codec.js";
import { looksLikeMtConnect } from "../adapters/mtconnect/index.js";
import { decodeListIdentityReply, encodeListIdentityRequest } from "../adapters/ethernetip/codec.js";
import { encodeCotpCr, isCotpCc } from "../adapters/s7/codec.js";
import { encodeWhoIs, decodeIAm } from "../adapters/bacnet/codec.js";
import { encodeRead, FC } from "../adapters/modbus/codec.js";
import { decodeAck, encodeHello } from "../adapters/opcua/hello.js";
import { fetchSafe } from "../runtime/ssrf.js";
import type { DiscoveryCandidate } from "../runtime/types.js";
import { encodeDnsQuery } from "./dnssd.js";
import { tcpExchange, udpExchange } from "./net.js";

export interface HttpResult {
  status: number;
  contentType: string;
  body: string;
  headers: Record<string, string>;
}

export async function httpGet(url: string, timeoutMs: number): Promise<HttpResult | undefined> {
  try {
    const res = await fetchSafe(url, { method: "GET", timeoutMs });
    const body = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return {
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      body: body.slice(0, 8000),
      headers,
    };
  } catch {
    return undefined;
  }
}

export async function httpPost(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<HttpResult | undefined> {
  try {
    const res = await fetchSafe(url, { method: "POST", headers, body, timeoutMs });
    const text = await res.text();
    const hdrs: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      hdrs[key.toLowerCase()] = value;
    });
    return {
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      body: text.slice(0, 8000),
      headers: hdrs,
    };
  } catch {
    return undefined;
  }
}

function candidate(
  protocol: string,
  url: string,
  hint: string,
  extra: Partial<DiscoveryCandidate> = {},
): DiscoveryCandidate {
  return { protocol, url, hint, status: extra.status ?? 1, ...extra };
}

export async function fingerprintRedis(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<DiscoveryCandidate | undefined> {
  const buf = await tcpExchange(host, port, Buffer.from("*1\r\n$4\r\nPING\r\n"), timeoutMs);
  if (!buf) return undefined;
  const text = buf.toString("utf8");
  if (!/\+PONG|\$4\r\nPONG/i.test(text)) return undefined;
  return candidate("redis", `redis://${host}:${port}`, "mcp_add protocol=redis config.url=<url>", {
    status: 1,
    title: "Redis PING",
    confidence: 0.92,
    detail: text.slice(0, 80),
    config: { url: `redis://${host}:${port}` },
  });
}

export function mqttConnectPacket(clientId = "e2mcp"): Buffer {
  const proto = Buffer.from([0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, 0x04, 0x02, 0x00, 0x3c]);
  const id = Buffer.from(clientId, "utf8");
  const idLen = Buffer.alloc(2);
  idLen.writeUInt16BE(id.length, 0);
  const variable = Buffer.concat([proto, idLen, id]);
  return Buffer.concat([Buffer.from([0x10]), encodeRemaining(variable.length), variable]);
}

function encodeRemaining(n: number): Buffer {
  const bytes: number[] = [];
  let x = n;
  do {
    let encoded = x % 128;
    x = Math.floor(x / 128);
    if (x > 0) encoded |= 0x80;
    bytes.push(encoded);
  } while (x > 0);
  return Buffer.from(bytes);
}

export async function fingerprintMqtt(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<DiscoveryCandidate | undefined> {
  const buf = await tcpExchange(host, port, mqttConnectPacket(), timeoutMs);
  if (!buf || buf.length < 2) return undefined;
  if (buf[0] !== 0x20) return undefined;
  return candidate("mqtt", `mqtt://${host}:${port}`, "mcp_add protocol=mqtt config.url=<url>", {
    status: 1,
    title: "MQTT CONNACK",
    confidence: 0.88,
    config: { url: `mqtt://${host}:${port}` },
  });
}

export async function fingerprintNats(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<DiscoveryCandidate | undefined> {
  const buf = await tcpExchange(host, port, null, timeoutMs);
  if (!buf) return undefined;
  const text = buf.toString("utf8");
  if (!/^INFO\s+\{/i.test(text)) return undefined;
  return candidate("nats", `nats://${host}:${port}`, "mcp_add protocol=nats config.url=<url> config.allowWrite=false", {
    status: 1,
    title: "NATS INFO",
    confidence: 0.93,
    detail: text.slice(0, 200),
    config: { url: `nats://${host}:${port}`, servers: [`nats://${host}:${port}`], allowWrite: false },
  });
}

export async function fingerprintModbus(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<DiscoveryCandidate | undefined> {
  const req = encodeRead(1, 1, FC.ReadHoldingRegisters, 0, 1);
  const buf = await tcpExchange(host, port, req, timeoutMs);
  if (!buf || buf.length < 8) return undefined;
  const protoId = buf.readUInt16BE(2);
  if (protoId !== 0) return undefined;
  const unit = buf[6];
  const fc = buf[7];
  if (fc !== FC.ReadHoldingRegisters && fc !== FC.ReadHoldingRegisters + 0x80) return undefined;
  return candidate("modbus", `modbus://${host}:${port}`, "mcp_add protocol=modbus config.host=<host>", {
    status: 1,
    title: "Modbus TCP MBAP",
    confidence: 0.72,
    detail: `unit=${unit} fc=${fc}`,
    config: { host, port },
  });
}

/** CON GET /.well-known/core */
export function coapWellKnownPacket(): Buffer {
  const mid = Buffer.from([0x12, 0x34]);
  const header = Buffer.from([0x40, 0x01, mid[0]!, mid[1]!]);
  const opt1 = Buffer.concat([Buffer.from([0xbb]), Buffer.from(".well-known")]);
  const opt2 = Buffer.concat([Buffer.from([0x04]), Buffer.from("core")]);
  return Buffer.concat([header, opt1, opt2]);
}

export async function fingerprintCoap(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<DiscoveryCandidate | undefined> {
  const buf = await udpExchange(host, port, coapWellKnownPacket(), timeoutMs);
  if (!buf || buf.length < 4) return undefined;
  const ver = buf[0]! >> 6;
  if (ver !== 1) return undefined;
  return candidate("coap", `coap://${host}:${port}`, "mcp_add protocol=coap config.host=<host>", {
    status: 1,
    title: "CoAP",
    confidence: 0.7,
    config: { host, port },
  });
}

export async function fingerprintJsonRpc(
  origin: string,
  timeoutMs: number,
): Promise<DiscoveryCandidate | undefined> {
  const paths = ["/jsonrpc", "/rpc", "/api", "/"];
  const body = JSON.stringify({ jsonrpc: "2.0", method: "rpc.listMethods", id: 1 });
  for (const path of paths) {
    const url = `${origin}${path === "/" ? "/" : path}`;
    const res = await httpPost(url, body, { "content-type": "application/json" }, timeoutMs);
    if (!res) continue;
    if (res.status >= 500) continue;
    if (!/"jsonrpc"\s*:\s*"2\.0"|error|result/.test(res.body)) continue;
    return candidate("jsonrpc", url, "mcp_add protocol=jsonrpc config.url=<url>", {
      status: res.status,
      contentType: res.contentType,
      title: "JSON-RPC 2.0",
      confidence: 0.76,
      config: { url },
    });
  }
  return undefined;
}

export async function fingerprintXmlRpc(
  origin: string,
  timeoutMs: number,
): Promise<DiscoveryCandidate | undefined> {
  const paths = ["/RPC2", "/xmlrpc", "/rpc"];
  const envelope =
    '<?xml version="1.0"?><methodCall><methodName>system.listMethods</methodName><params></params></methodCall>';
  for (const path of paths) {
    const url = `${origin}${path}`;
    const res = await httpPost(url, envelope, { "content-type": "text/xml" }, timeoutMs);
    if (!res) continue;
    if (!/<methodResponse|<fault>/i.test(res.body)) continue;
    return candidate("xmlrpc", url, "mcp_add protocol=xmlrpc config.url=<url>", {
      status: res.status,
      contentType: res.contentType,
      title: "XML-RPC",
      confidence: 0.78,
      config: { url },
    });
  }
  return undefined;
}

export function postgresSslRequest(): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeInt32BE(8, 0);
  buf.writeInt32BE(80877103, 4);
  return buf;
}

export async function fingerprintPostgres(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<DiscoveryCandidate | undefined> {
  const buf = await tcpExchange(host, port, postgresSslRequest(), timeoutMs, 1);
  if (!buf || !buf.length) return undefined;
  const b = buf[0];
  if (b !== 0x4e && b !== 0x53 && b !== 0x45) return undefined;
  return candidate("postgres", `postgres://${host}:${port}`, "mcp_add protocol=postgres config.url=<url>", {
    title: "PostgreSQL",
    confidence: 0.9,
    config: { url: `postgres://${host}:${port}/postgres`, allowWrite: false },
  });
}

export async function fingerprintMysql(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<DiscoveryCandidate | undefined> {
  const buf = await tcpExchange(host, port, null, timeoutMs, 5);
  if (!buf || buf.length < 5) return undefined;
  if (buf[4] !== 0x0a) return undefined;
  const version = buf.subarray(5).toString("utf8").split("\0")[0] ?? "";
  return candidate("mysql", `mysql://${host}:${port}`, "mcp_add protocol=mysql config.url=<url>", {
    title: version ? `MySQL/MariaDB ${version}` : "MySQL/MariaDB",
    confidence: 0.9,
    detail: "MariaDB uses the same greeting",
    config: { url: `mysql://${host}:${port}/mysql`, allowWrite: false },
  });
}

export async function fingerprintSqlServer(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<DiscoveryCandidate | undefined> {
  const prelogin = Buffer.from([0x12, 0x01, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00]);
  const buf = await tcpExchange(host, port, prelogin, timeoutMs, 1);
  if (!buf || buf[0] !== 0x04) return undefined;
  return candidate("sqlserver", `sqlserver://${host}:${port}`, "mcp_add protocol=sqlserver config.url=<url>", {
    title: "SQL Server TDS",
    confidence: 0.7,
    config: { url: `sqlserver://${host}:${port}`, simulator: true, allowWrite: false },
  });
}

export function mongoIsMasterPacket(): Buffer {
  const bson = Buffer.concat([
    Buffer.from([0x13, 0x00, 0x00, 0x00]),
    Buffer.from([0x10]),
    Buffer.from("isMaster\0"),
    Buffer.from([0x01, 0x00, 0x00, 0x00]),
    Buffer.from([0x00]),
  ]);
  const body = Buffer.concat([
    Buffer.alloc(4),
    Buffer.from("admin.$cmd\0"),
    Buffer.alloc(4),
    Buffer.from([0x01, 0x00, 0x00, 0x00]),
    bson,
  ]);
  body.writeInt32LE(0, 0);
  const header = Buffer.alloc(16);
  const total = 16 + body.length;
  header.writeInt32LE(total, 0);
  header.writeInt32LE(1, 4);
  header.writeInt32LE(0, 8);
  header.writeInt32LE(2004, 12);
  return Buffer.concat([header, body]);
}

export async function fingerprintMongodb(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<DiscoveryCandidate | undefined> {
  const buf = await tcpExchange(host, port, mongoIsMasterPacket(), timeoutMs, 16);
  if (!buf) return undefined;
  const text = buf.toString("utf8");
  if (!/ismaster|helloOk|maxBsonObjectSize|MongoDB/i.test(text)) return undefined;
  return candidate("mongodb", `mongodb://${host}:${port}`, "mcp_add protocol=mongodb config.url=<url>", {
    title: "MongoDB",
    confidence: 0.86,
    config: { url: `mongodb://${host}:${port}`, allowWrite: false },
  });
}

export const NEO4J_BOLT_MAGIC = Buffer.from([0x60, 0x60, 0xb0, 0x17]);

export function neo4jHandshake(): Buffer {
  const versions = Buffer.alloc(16);
  versions.writeUInt32BE(0x00000001, 0);
  return Buffer.concat([NEO4J_BOLT_MAGIC, versions]);
}

export async function fingerprintNeo4j(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<DiscoveryCandidate | undefined> {
  const buf = await tcpExchange(host, port, neo4jHandshake(), timeoutMs, 4);
  if (!buf || buf.length < 4) return undefined;
  if (buf.length > 16) return undefined;
  const version = buf.readUInt32BE(0);
  if (version === 0 || version > 0x00ff0005) return undefined;
  return candidate("neo4j", `bolt://${host}:${port}`, "mcp_add protocol=neo4j config.url=<url>", {
    title: "Neo4j Bolt",
    confidence: 0.8,
    config: { url: `bolt://${host}:${port}`, allowWrite: false },
  });
}

export async function fingerprintElasticsearch(
  host: string,
  port: number,
  timeoutMs: number,
  get: typeof httpGet = httpGet,
): Promise<DiscoveryCandidate | undefined> {
  const url = `http://${host}:${port}/`;
  const res = await get(url, timeoutMs);
  if (!res) return undefined;
  if (!/"tagline"\s*:|"You Know, for Search"|opensearch|lucene_version/i.test(res.body)) return undefined;
  const proto = /opensearch/i.test(res.body) ? "opensearch" : "elasticsearch";
  return candidate(proto, url, `mcp_add protocol=${proto} config.url=<url>`, {
    status: res.status,
    title: proto,
    confidence: 0.88,
    config: { url: url.replace(/\/$/, ""), allowWrite: false },
  });
}

export async function fingerprintClickhouse(
  host: string,
  port: number,
  timeoutMs: number,
  get: typeof httpGet = httpGet,
): Promise<DiscoveryCandidate | undefined> {
  const url = `http://${host}:${port}/`;
  const res = await get(url, timeoutMs);
  if (!res) return undefined;
  if (!/^Ok\.\s*$/m.test(res.body) && !/ClickHouse/i.test(res.body)) return undefined;
  return candidate("clickhouse", url, "mcp_add protocol=clickhouse config.url=<url>", {
    status: res.status,
    title: "ClickHouse",
    confidence: 0.9,
    config: { url: url.replace(/\/$/, ""), allowWrite: false },
  });
}

export async function fingerprintQdrant(
  host: string,
  port: number,
  timeoutMs: number,
  get: typeof httpGet = httpGet,
): Promise<DiscoveryCandidate | undefined> {
  const url = `http://${host}:${port}/`;
  const res = await get(url, timeoutMs);
  if (!res) return undefined;
  if (!/qdrant/i.test(res.body)) return undefined;
  return candidate("qdrant", url, "mcp_add protocol=qdrant config.url=<url>", {
    status: res.status,
    title: "Qdrant",
    confidence: 0.9,
    config: { url: url.replace(/\/$/, ""), allowWrite: false },
  });
}

export async function fingerprintS3(
  host: string,
  port: number,
  timeoutMs: number,
  get: typeof httpGet = httpGet,
): Promise<DiscoveryCandidate | undefined> {
  const origin = `http://${host}:${port}`;
  const live = await get(`${origin}/minio/health/live`, timeoutMs);
  const root = await get(`${origin}/`, timeoutMs);
  const looksMinio =
    (live?.status === 200 && (!live.body || live.body.length < 200)) ||
    (root && /MinIO|AccessDenied|ListBucketResult|ListAllMyBucketsResult/i.test(root.body));
  if (!looksMinio) return undefined;
  return candidate("s3", origin, "mcp_add protocol=s3 config.bucket=<name> config.unsigned=true", {
    status: live?.status ?? root?.status ?? 1,
    title: "MinIO / S3",
    confidence: 0.86,
    config: { endpoint: origin, unsigned: true, allowWrite: false, simulator: false, bucket: "data" },
  });
}

export async function fingerprintBacnet(
  host: string,
  port: number,
  timeoutMs: number,
  exchange: typeof udpExchange = udpExchange,
): Promise<DiscoveryCandidate | undefined> {
  const buf = await exchange(host, port, encodeWhoIs({}), timeoutMs);
  if (!buf) return undefined;
  const iam = decodeIAm(buf);
  if (!iam) return undefined;
  return candidate("bacnet", `bacnet://${host}:${port}`, "mcp_add protocol=bacnet config.host=<host> config.udp=true", {
    status: 1,
    title: `BACnet device ${iam.deviceId}`,
    confidence: 0.9,
    detail: `I-Am deviceId=${iam.deviceId} vendorId=${iam.vendorId} maxApdu=${iam.maxApdu}`,
    config: {
      host,
      port,
      deviceId: iam.deviceId,
      udp: true,
      allowWrite: false,
    },
  });
}

export async function fingerprintEthernetIp(
  host: string,
  port: number,
  timeoutMs: number,
  exchange: typeof tcpExchange = tcpExchange,
): Promise<DiscoveryCandidate | undefined> {
  const buf = await exchange(host, port, encodeListIdentityRequest(), timeoutMs, 24);
  if (!buf) return undefined;
  const identity = decodeListIdentityReply(buf);
  if (!identity) return undefined;
  return candidate("ethernetip", `enip://${host}:${port}`, "mcp_add protocol=ethernetip config.host=<host> config.tcp=true", {
    status: 1,
    title: identity.productName || `CIP ${identity.vendorId}`,
    confidence: 0.9,
    detail: `List Identity vendor=${identity.vendorId} product=${identity.productName} serial=${identity.serial}`,
    config: { host, port, tcp: true, allowWrite: false },
  });
}

export async function fingerprintS7(
  host: string,
  port: number,
  timeoutMs: number,
  exchange: typeof tcpExchange = tcpExchange,
): Promise<DiscoveryCandidate | undefined> {
  const buf = await exchange(host, port, encodeCotpCr(0, 1), timeoutMs, 7);
  if (!buf || !isCotpCc(buf)) return undefined;
  return candidate("s7", `s7://${host}:${port}`, "mcp_add protocol=s7 config.host=<host> config.tcp=true", {
    status: 1,
    title: "Siemens S7 ISO-TCP",
    confidence: 0.88,
    detail: "COTP Connection Confirm on port 102-style ISO-on-TCP",
    config: { host, port, rack: 0, slot: 1, tcp: true, allowWrite: false },
  });
}

export async function fingerprintMtConnect(
  host: string,
  port: number,
  timeoutMs: number,
  get: typeof httpGet = httpGet,
): Promise<DiscoveryCandidate | undefined> {
  const origin = `http://${host}:${port}`;
  const probe = await get(`${origin}/probe`, timeoutMs);
  const body = probe?.body ?? "";
  if (!looksLikeMtConnect(body)) return undefined;
  return candidate("mtconnect", origin, "mcp_add protocol=mtconnect config.url=<url>", {
    status: probe?.status ?? 1,
    title: "MTConnect Agent",
    confidence: 0.9,
    config: { url: origin },
  });
}

export async function fingerprintPrometheus(
  host: string,
  port: number,
  timeoutMs: number,
  get: typeof httpGet = httpGet,
): Promise<DiscoveryCandidate | undefined> {
  const origin = `http://${host}:${port}`;
  const healthy = await get(`${origin}/-/healthy`, timeoutMs);
  const build = await get(`${origin}/api/v1/status/buildinfo`, timeoutMs);
  const phrase = Boolean(healthy && /Prometheus/i.test(healthy.body) && /Healthy/i.test(healthy.body));
  const buildHit = Boolean(build && /"status"\s*:\s*"success"/i.test(build.body) && /version/i.test(build.body));
  if (!phrase && !buildHit) return undefined;
  return candidate("prometheus", origin, "mcp_add protocol=prometheus config.url=<url> config.allowWrite=false", {
    status: healthy?.status ?? build?.status ?? 1,
    title: "Prometheus",
    confidence: 0.92,
    config: { url: origin, timeoutMs: 2500, allowWrite: false },
  });
}

/** Length-prefixed probe; real brokers may close. Fakes that echo "pulsar" match. */
export function pulsarLengthPrefixedProbe(): Buffer {
  const payload = Buffer.from("PULSAR");
  const buf = Buffer.alloc(4 + payload.length);
  buf.writeUInt32BE(payload.length, 0);
  payload.copy(buf, 4);
  return buf;
}

export async function fingerprintPulsar(
  host: string,
  port: number,
  timeoutMs: number,
  get: typeof httpGet = httpGet,
  exchange: typeof tcpExchange = tcpExchange,
): Promise<DiscoveryCandidate | undefined> {
  const origin = `http://${host}:${port}`;
  const ready = await get(`${origin}/admin/v2/brokers/ready`, timeoutMs);
  if (ready && ready.status >= 200 && ready.status < 300) {
    return pulsarCandidate(origin, `http://${host}:${port}`, "HTTP /admin/v2/brokers/ready", ready.status);
  }
  const clusters = await get(`${origin}/admin/v2/clusters`, timeoutMs);
  if (clusters && clusters.status >= 200 && clusters.status < 300 && /^\s*\[/.test(clusters.body)) {
    return pulsarCandidate(origin, `http://${host}:${port}`, "HTTP /admin/v2/clusters", clusters.status);
  }
  const metrics = await get(`${origin}/metrics`, timeoutMs);
  if (metrics && /pulsar_(broker|topics_|metadata_store)/i.test(metrics.body)) {
    return pulsarCandidate(origin, `http://${host}:${port}`, "HTTP /metrics pulsar_", metrics.status);
  }
  const buf = await exchange(host, port, pulsarLengthPrefixedProbe(), timeoutMs, 4);
  if (!buf || buf.length < 4) return undefined;
  if (!/pulsar/i.test(buf.toString("utf8"))) return undefined;
  return pulsarCandidate(
    `pulsar://${host}:${port}`,
    `pulsar://${host}:${port}`,
    "TCP length-prefix banner",
    1,
  );
}

function pulsarCandidate(
  url: string,
  serviceUrl: string,
  title: string,
  status: number,
): DiscoveryCandidate {
  return candidate("pulsar", url, "mcp_add protocol=pulsar config.topic=<name> config.allowWrite=false", {
    status,
    title: `Pulsar ${title}`,
    confidence: 0.86,
    config: { topic: "events", serviceUrl, allowWrite: false },
  });
}

export async function fingerprintGcs(
  host: string,
  port: number,
  timeoutMs: number,
  get: typeof httpGet = httpGet,
): Promise<DiscoveryCandidate | undefined> {
  const origin = `http://${host}:${port}`;
  const listed = await get(`${origin}/storage/v1/b`, timeoutMs);
  if (!listed) return undefined;
  if (!/storage#buckets|"kind"\s*:\s*"storage#/i.test(listed.body)) return undefined;
  return candidate("gcs", origin, "mcp_add protocol=gcs config.bucket=<name> config.unsigned=true", {
    status: listed.status,
    title: "GCS JSON API",
    confidence: 0.88,
    config: { bucket: "data", endpoint: origin, unsigned: true, allowWrite: false, simulator: false },
  });
}

export async function fingerprintOss(
  host: string,
  port: number,
  timeoutMs: number,
  get: typeof httpGet = httpGet,
): Promise<DiscoveryCandidate | undefined> {
  const origin = `http://${host}:${port}`;
  const root = await get(`${origin}/`, timeoutMs);
  if (!root) return undefined;
  const hdrs = root.headers ?? {};
  const ossHeader = Boolean(hdrs["x-oss-request-id"] || /aliyunoss/i.test(hdrs["server"] ?? ""));
  const ossBody = /AliyunOSS/i.test(root.body) || (/x-oss-/i.test(root.body) && /<Error>/i.test(root.body));
  if (!ossHeader && !ossBody) return undefined;
  return candidate("oss", origin, "mcp_add protocol=oss config.bucket=<name> config.unsigned=true", {
    status: root.status,
    title: "Aliyun OSS",
    confidence: 0.84,
    config: { bucket: "data", endpoint: origin, unsigned: true, allowWrite: false, simulator: false },
  });
}

export function kafkaApiVersionsProbe(): Buffer {
  const body = Buffer.alloc(10);
  body.writeInt16BE(18, 0);
  body.writeInt16BE(0, 2);
  body.writeInt32BE(7, 4);
  body.writeInt16BE(0, 8);
  const framed = Buffer.alloc(4 + body.length);
  framed.writeInt32BE(body.length, 0);
  body.copy(framed, 4);
  return framed;
}

export async function fingerprintKafka(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<DiscoveryCandidate | undefined> {
  const buf = await tcpExchange(host, port, kafkaApiVersionsProbe(), timeoutMs);
  if (!buf || buf.length < 8) return undefined;
  const correlation = buf.readInt32BE(4);
  const text = buf.toString("utf8");
  if (correlation !== 7 && !/kafka/i.test(text)) return undefined;
  return candidate("kafka", `kafka://${host}:${port}`, "mcp_add protocol=kafka config.brokers=<host:port> config.allowWrite=false", {
    status: 1,
    title: "Kafka ApiVersions",
    confidence: 0.8,
    config: { brokers: [`${host}:${port}`], allowWrite: false },
  });
}

export const AMQP_PROTOCOL_HEADER = Buffer.from([0x41, 0x4d, 0x51, 0x50, 0x00, 0x00, 0x09, 0x01]);

export async function fingerprintAmqp(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<DiscoveryCandidate | undefined> {
  const buf = await tcpExchange(host, port, AMQP_PROTOCOL_HEADER, timeoutMs);
  if (!buf || buf.length < 4) return undefined;
  const text = buf.toString("latin1");
  if (!text.startsWith("AMQP") && buf[0] !== 0x01) return undefined;
  return candidate("amqp", `amqp://${host}:${port}`, "mcp_add protocol=amqp config.url=<url> config.allowWrite=false", {
    status: 1,
    title: "AMQP handshake",
    confidence: 0.82,
    config: { url: `amqp://${host}:${port}`, allowWrite: false },
  });
}

export async function fingerprintOpcUa(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<DiscoveryCandidate | undefined> {
  const endpoint = `opc.tcp://${host}:${port}`;
  const buf = await tcpExchange(host, port, encodeHello(endpoint), timeoutMs);
  if (!buf) return undefined;
  const ack = decodeAck(buf);
  if (ack.messageType !== "ACK" && ack.messageType !== "ERR") return undefined;
  return candidate("opcua", endpoint, "mcp_add protocol=opcua config.endpoint=<url> config.allowWrite=false", {
    status: 1,
    title: `OPC UA ${ack.messageType}`,
    confidence: ack.ok ? 0.88 : 0.7,
    config: { endpoint, allowWrite: false },
  });
}

/** SMTP banner: servers speak first with `220 …`. Ports 25 / 587. */
export async function fingerprintSmtp(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<DiscoveryCandidate | undefined> {
  const buf = await tcpExchange(host, port, null, timeoutMs, 4);
  if (!buf) return undefined;
  const text = buf.toString("utf8");
  if (!/^220[\s-]/m.test(text)) return undefined;
  return candidate("smtp", `smtp://${host}:${port}`, "mcp_add protocol=smtp config.host=<host> config.allowWrite=false", {
    status: 1,
    title: "SMTP 220",
    confidence: port === 25 || port === 587 ? 0.9 : 0.75,
    detail: text.split(/\r?\n/)[0]?.slice(0, 120),
    config: { host, port, allowWrite: false },
  });
}

export async function fingerprintFtp(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<DiscoveryCandidate | undefined> {
  const buf = await tcpExchange(host, port, null, timeoutMs, 4);
  if (!buf) return undefined;
  const text = buf.toString("utf8");
  if (!/^220[\s-]/m.test(text)) return undefined;
  if (/smtp|esmtp|\bmail\b/i.test(text) && !/ftp/i.test(text)) return undefined;
  if (!/ftp|filezilla|vsftpd|proftpd|pure-ftpd|ready/i.test(text) && port !== 21) return undefined;
  return candidate("ftp", `ftp://${host}:${port}`, "mcp_add protocol=ftp config.host=<host> config.allowWrite=false", {
    status: 1,
    title: "FTP 220",
    confidence: port === 21 ? 0.9 : 0.72,
    detail: text.split(/\r?\n/)[0]?.slice(0, 120),
    config: { host, port, allowWrite: false },
  });
}

export async function fingerprintSnmp(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<DiscoveryCandidate | undefined> {
  const buf = await udpExchange(host, port, encodeGet("public", SYS_DESCR, 1), timeoutMs);
  if (!buf) return undefined;
  try {
    const msg = decodeSnmp(buf);
    if (msg.pduType !== PDU_RESPONSE) return undefined;
    const descr = msg.varbinds[0]?.value;
    return candidate("snmp", `snmp://${host}:${port}`, "mcp_add protocol=snmp config.host=<host> config.community=public", {
      status: 1,
      title: typeof descr === "string" && descr ? descr.slice(0, 80) : "SNMPv2c",
      confidence: 0.9,
      config: { host, port, community: "public", allowWrite: false },
    });
  } catch {
    return undefined;
  }
}

export async function fingerprintEtcd(
  host: string,
  port: number,
  timeoutMs: number,
  get: typeof httpGet = httpGet,
): Promise<DiscoveryCandidate | undefined> {
  const origin = `http://${host}:${port}`;
  const ver = await get(`${origin}/version`, timeoutMs);
  const health = await get(`${origin}/health`, timeoutMs);
  const hit =
    Boolean(ver && /etcdserver|etcdcluster/i.test(ver.body)) ||
    Boolean(health && /"health"\s*:\s*"true"/i.test(health.body));
  if (!hit) return undefined;
  return candidate("etcd", origin, "mcp_add protocol=etcd config.url=<url> config.allowWrite=false", {
    status: ver?.status ?? health?.status ?? 1,
    title: "etcd",
    confidence: 0.9,
    config: { url: origin, allowWrite: false },
  });
}

export async function fingerprintImap(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<DiscoveryCandidate | undefined> {
  const buf = await tcpExchange(host, port, null, timeoutMs, 4);
  if (!buf) return undefined;
  const text = buf.toString("utf8");
  if (!/^\*\s+OK/i.test(text)) return undefined;
  if (!/imap/i.test(text) && port !== 143 && port !== 993) return undefined;
  return candidate("imap", `imap://${host}:${port}`, "mcp_add protocol=imap config.host=<host> config.allowWrite=false", {
    status: 1,
    title: "IMAP4rev1",
    confidence: port === 143 || port === 993 ? 0.9 : 0.72,
    detail: text.split(/\r?\n/)[0]?.slice(0, 120),
    config: { host, port, allowWrite: false },
  });
}

export async function fingerprintPop3(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<DiscoveryCandidate | undefined> {
  const buf = await tcpExchange(host, port, null, timeoutMs, 4);
  if (!buf) return undefined;
  const text = buf.toString("utf8");
  if (!/^\+OK/i.test(text)) return undefined;
  if (!/pop/i.test(text) && port !== 110 && port !== 995) return undefined;
  return candidate("pop3", `pop3://${host}:${port}`, "mcp_add protocol=pop3 config.host=<host> config.allowWrite=false", {
    status: 1,
    title: "POP3",
    confidence: port === 110 || port === 995 ? 0.9 : 0.72,
    detail: text.split(/\r?\n/)[0]?.slice(0, 120),
    config: { host, port, allowWrite: false },
  });
}

export async function fingerprintConsul(
  host: string,
  port: number,
  timeoutMs: number,
  get: typeof httpGet = httpGet,
): Promise<DiscoveryCandidate | undefined> {
  const origin = `http://${host}:${port}`;
  const leader = await get(`${origin}/v1/status/leader`, timeoutMs);
  const self = await get(`${origin}/v1/agent/self`, timeoutMs);
  const hit =
    Boolean(leader && (/^\s*"/.test(leader.body) || /:\d+/.test(leader.body))) ||
    Boolean(self && /"Config"|"Member"|"consul"/i.test(self.body));
  if (!hit) return undefined;
  return candidate("consul", origin, "mcp_add protocol=consul config.url=<url> config.allowWrite=false", {
    status: leader?.status ?? self?.status ?? 1,
    title: "Consul",
    confidence: 0.9,
    config: { url: origin, allowWrite: false },
  });
}

export async function fingerprintAzureBlob(
  host: string,
  port: number,
  timeoutMs: number,
  get: typeof httpGet = httpGet,
): Promise<DiscoveryCandidate | undefined> {
  const origin = `http://${host}:${port}`;
  const res = await get(`${origin}/?restype=container&comp=list`, timeoutMs);
  if (!res) return undefined;
  const ms =
    Boolean(res.headers["x-ms-request-id"] || res.headers["x-ms-version"]) ||
    /azurite|windows-azure-blob|enumerationresults/i.test(`${res.headers.server ?? ""} ${res.body}`);
  if (!ms && port !== 10000) return undefined;
  if (!ms) return undefined;
  return candidate("azureblob", origin, "mcp_add protocol=azureblob config.container=<name> config.endpoint=<url> config.allowWrite=false", {
    status: res.status,
    title: "Azure Blob",
    confidence: port === 10000 ? 0.88 : 0.75,
    config: { endpoint: origin, container: "data", unsigned: true, allowWrite: false },
  });
}

export async function fingerprintSftp(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<DiscoveryCandidate | undefined> {
  const buf = await tcpExchange(host, port, Buffer.from("SSH-2.0-e2mcp\r\n"), timeoutMs, 8);
  if (!buf) return undefined;
  const text = buf.toString("utf8");
  if (!/^SSH-2\.0-/m.test(text)) return undefined;
  return candidate("sftp", `sftp://${host}:${port}`, "mcp_add protocol=sftp config.host=<host> config.allowWrite=false", {
    status: 1,
    title: "SSH-2 / SFTP",
    confidence: port === 22 ? 0.88 : 0.7,
    detail: text.split(/\r?\n/)[0]?.slice(0, 80),
    config: { host, port, allowWrite: false },
  });
}

export async function fingerprintMemcached(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<DiscoveryCandidate | undefined> {
  const buf = await tcpExchange(host, port, Buffer.from("stats\r\n"), timeoutMs, 4);
  if (!buf) return undefined;
  const text = buf.toString("utf8");
  if (!/^STAT\s+/m.test(text)) return undefined;
  return candidate("memcached", `memcached://${host}:${port}`, "mcp_add protocol=memcached config.host=<host> config.allowWrite=false", {
    status: 1,
    title: "Memcached",
    confidence: port === 11211 ? 0.92 : 0.75,
    config: { host, port, allowWrite: false },
  });
}

export async function fingerprintTftp(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<DiscoveryCandidate | undefined> {
  const buf = await udpExchange(host, port, encodeTftpRequest(1, "readme.txt"), timeoutMs);
  if (!buf) return undefined;
  const msg = decodeTftp(buf);
  if (msg.opcode !== TFTP_DATA && msg.opcode !== TFTP_ERROR) return undefined;
  return candidate("tftp", `tftp://${host}:${port}`, "mcp_add protocol=tftp config.host=<host> config.allowWrite=false", {
    status: 1,
    title: "TFTP",
    confidence: port === 69 ? 0.9 : 0.7,
    config: { host, port, allowWrite: false },
  });
}

export async function fingerprintWebDav(
  origin: string,
  timeoutMs: number,
  get: typeof httpGet = httpGet,
): Promise<DiscoveryCandidate | undefined> {
  for (const path of ["", "/dav", "/webdav"]) {
    try {
      const res = await fetchSafe(`${origin}${path || "/"}`, { method: "OPTIONS", timeoutMs });
      const dav = res.headers.get("dav") ?? "";
      const allow = res.headers.get("allow") ?? "";
      if (/1|2|dav/i.test(dav) || /PROPFIND|MKCOL/i.test(allow)) {
        const url = `${origin}${path}`;
        return candidate("webdav", url, "mcp_add protocol=webdav config.url=<url> config.allowWrite=false", {
          status: res.status,
          title: "WebDAV",
          confidence: 0.88,
          config: { url, allowWrite: false },
        });
      }
    } catch {
      /* try next path */
    }
    const fallback = await get(`${origin}${path || "/"}`, timeoutMs);
    if (fallback && /<[^>]*multistatus/i.test(fallback.body)) {
      const url = `${origin}${path}`;
      return candidate("webdav", url, "mcp_add protocol=webdav config.url=<url> config.allowWrite=false", {
        status: fallback.status,
        title: "WebDAV",
        confidence: 0.8,
        config: { url, allowWrite: false },
      });
    }
  }
  return undefined;
}

export async function fingerprintInflux(
  host: string,
  port: number,
  timeoutMs: number,
  get: typeof httpGet = httpGet,
): Promise<DiscoveryCandidate | undefined> {
  const origin = `http://${host}:${port}`;
  const health = await get(`${origin}/health`, timeoutMs);
  const ping = await get(`${origin}/ping`, timeoutMs);
  const healthHit = Boolean(health && /influxdb/i.test(health.body));
  const pingHit = Boolean(ping?.headers?.["x-influxdb-version"]);
  if (!healthHit && !pingHit) return undefined;
  return candidate("influx", origin, "mcp_add protocol=influx config.bucket=<name> config.allowWrite=false", {
    status: health?.status ?? ping?.status ?? 1,
    title: "InfluxDB",
    confidence: 0.9,
    config: { url: origin, bucket: "metrics", org: "local", allowWrite: false },
  });
}

export async function fingerprintCalDav(
  origin: string,
  timeoutMs: number,
): Promise<DiscoveryCandidate | undefined> {
  for (const path of ["", "/caldav", "/calendar", "/.well-known/caldav"]) {
    try {
      const res = await fetchSafe(`${origin}${path || "/"}`, { method: "OPTIONS", timeoutMs });
      const dav = res.headers.get("dav") ?? "";
      if (/calendar-access/i.test(dav)) {
        const url = `${origin}${path}`;
        return candidate("caldav", url, "mcp_add protocol=caldav config.url=<url> config.allowWrite=false", {
          status: res.status,
          title: "CalDAV",
          confidence: 0.9,
          config: { url, allowWrite: false },
        });
      }
    } catch {
      /* next */
    }
  }
  return undefined;
}

export async function fingerprintCardDav(
  origin: string,
  timeoutMs: number,
): Promise<DiscoveryCandidate | undefined> {
  for (const path of ["", "/carddav", "/addressbook", "/.well-known/carddav"]) {
    try {
      const res = await fetchSafe(`${origin}${path || "/"}`, { method: "OPTIONS", timeoutMs });
      const dav = res.headers.get("dav") ?? "";
      if (/addressbook/i.test(dav)) {
        const url = `${origin}${path}`;
        return candidate("carddav", url, "mcp_add protocol=carddav config.url=<url> config.allowWrite=false", {
          status: res.status,
          title: "CardDAV",
          confidence: 0.9,
          config: { url, allowWrite: false },
        });
      }
    } catch {
      /* next */
    }
  }
  return undefined;
}

export async function fingerprintBeanstalkd(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<DiscoveryCandidate | undefined> {
  const buf = await tcpExchange(host, port, Buffer.from("stats\r\n"), timeoutMs, 4);
  if (!buf) return undefined;
  const text = buf.toString("utf8");
  if (!/^OK\s+\d+/m.test(text) && !/current-jobs-ready/i.test(text)) return undefined;
  return candidate("beanstalkd", `beanstalkd://${host}:${port}`, "mcp_add protocol=beanstalkd config.host=<host> config.allowWrite=false", {
    status: 1,
    title: "Beanstalkd",
    confidence: port === 11300 ? 0.92 : 0.75,
    config: { host, port, allowWrite: false },
  });
}

export async function fingerprintZookeeper(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<DiscoveryCandidate | undefined> {
  const buf = await tcpExchange(host, port, Buffer.from("ruok"), timeoutMs, 4);
  if (!buf) return undefined;
  const text = buf.toString("utf8");
  if (!/imok/i.test(text)) return undefined;
  return candidate("zookeeper", `zookeeper://${host}:${port}`, "mcp_add protocol=zookeeper config.host=<host> config.allowWrite=false", {
    status: 1,
    title: "ZooKeeper",
    confidence: port === 2181 ? 0.9 : 0.7,
    config: { host, port, allowWrite: false },
  });
}

export async function fingerprintDns(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<DiscoveryCandidate | undefined> {
  const buf = await udpExchange(host, port, encodeDnsQuery(host.includes(".") ? host : "example.test", 1), timeoutMs);
  if (!buf || buf.length < 12) return undefined;
  const flags = buf.readUInt16BE(2);
  if ((flags & 0x8000) === 0) return undefined;
  return candidate("dns", `dns://${host}:${port}`, "mcp_add protocol=dns config.host=<host> config.allowWrite=false", {
    status: 1,
    title: "DNS",
    confidence: port === 53 ? 0.9 : 0.7,
    config: { host, port, allowWrite: false },
  });
}

export async function fingerprintCassandra(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<DiscoveryCandidate | undefined> {
  const buf = await tcpExchange(host, port, encodeStartup(), timeoutMs, 9);
  if (!buf) return undefined;
  const frame = decodeFrame(buf);
  if (!frame || (frame.opcode !== OPCODE_READY && frame.opcode !== OPCODE_AUTHENTICATE)) return undefined;
  return candidate("cassandra", `cassandra://${host}:${port}`, "mcp_add protocol=cassandra config.host=<host> config.allowWrite=false", {
    status: 1,
    title: frame.opcode === OPCODE_READY ? "Cassandra READY" : "Cassandra AUTHENTICATE",
    confidence: port === 9042 ? 0.92 : 0.75,
    config: { host, port, allowWrite: false },
  });
}

export async function fingerprintCouchdb(
  host: string,
  port: number,
  timeoutMs: number,
  get: typeof httpGet = httpGet,
): Promise<DiscoveryCandidate | undefined> {
  const url = `http://${host}:${port}/`;
  const res = await get(url, timeoutMs);
  if (!res) return undefined;
  if (!/"couchdb"\s*:\s*"Welcome"|CouchDB/i.test(res.body)) return undefined;
  return candidate("couchdb", url.replace(/\/$/, ""), "mcp_add protocol=couchdb config.url=<url> config.allowWrite=false", {
    status: res.status,
    title: "CouchDB",
    confidence: port === 5984 ? 0.92 : 0.78,
    config: { url: url.replace(/\/$/, ""), allowWrite: false },
  });
}

export async function fingerprintWhois(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<DiscoveryCandidate | undefined> {
  const buf = await tcpExchange(host, port, Buffer.from("example.test\r\n"), timeoutMs, 8);
  if (!buf) return undefined;
  const text = buf.toString("utf8");
  if (/^220[\s-]/m.test(text) && /smtp|esmtp|ftp/i.test(text)) return undefined;
  if (!/Domain Name:|No match for|Whois Server|Registrar:/i.test(text)) return undefined;
  return candidate("whois", `whois://${host}:${port}`, "mcp_add protocol=whois config.host=<host>", {
    status: 1,
    title: "WHOIS",
    confidence: port === 43 ? 0.9 : 0.7,
    detail: text.split(/\r?\n/)[0]?.slice(0, 120),
    config: { host, port },
  });
}

export async function fingerprintSolr(
  host: string,
  port: number,
  timeoutMs: number,
  get: typeof httpGet = httpGet,
): Promise<DiscoveryCandidate | undefined> {
  const origin = `http://${host}:${port}`;
  const sys = await get(`${origin}/solr/admin/info/system?wt=json`, timeoutMs);
  const root = await get(`${origin}/solr/`, timeoutMs);
  const hit =
    Boolean(sys && /solr_spec_version|lucene|solr_home/i.test(sys.body)) ||
    Boolean(root && /Solr|solr-spec-version/i.test(root.body));
  if (!hit) return undefined;
  return candidate("solr", origin, "mcp_add protocol=solr config.url=<url> config.allowWrite=false", {
    status: sys?.status ?? root?.status ?? 1,
    title: "Solr",
    confidence: port === 8983 ? 0.92 : 0.75,
    config: { url: origin, allowWrite: false },
  });
}

export async function fingerprintRabbitmq(
  host: string,
  port: number,
  timeoutMs: number,
  get: typeof httpGet = httpGet,
): Promise<DiscoveryCandidate | undefined> {
  const origin = `http://${host}:${port}`;
  const overview = await get(`${origin}/api/overview`, timeoutMs);
  if (!overview || !/rabbitmq_version|management_version/i.test(overview.body)) return undefined;
  return candidate("rabbitmq", origin, "mcp_add protocol=rabbitmq config.url=<url> config.allowWrite=false", {
    status: overview.status,
    title: "RabbitMQ management",
    confidence: port === 15672 ? 0.92 : 0.75,
    config: { url: origin, vhost: "/", allowWrite: false },
  });
}

export async function fingerprintKubernetes(
  host: string,
  port: number,
  timeoutMs: number,
  get: typeof httpGet = httpGet,
): Promise<DiscoveryCandidate | undefined> {
  const origin = `http://${host}:${port}`;
  const ver = await get(`${origin}/version`, timeoutMs);
  if (!ver || !/gitVersion|"major"\s*:/i.test(ver.body)) return undefined;
  return candidate("kubernetes", origin, "mcp_add protocol=kubernetes config.url=<url>", {
    status: ver.status,
    title: "Kubernetes API",
    confidence: port === 6443 ? 0.9 : 0.72,
    config: { url: origin, namespace: "default" },
  });
}

export async function fingerprintNeo4jHttp(
  host: string,
  port: number,
  timeoutMs: number,
  get: typeof httpGet = httpGet,
): Promise<DiscoveryCandidate | undefined> {
  const origin = `http://${host}:${port}`;
  const res = await get(`${origin}/`, timeoutMs);
  if (!res) return undefined;
  if (!/neo4j_version|"transaction"\s*:|bolt_direct/i.test(res.body)) return undefined;
  return candidate("neo4j", origin, "mcp_add protocol=neo4j config.url=<url> config.allowWrite=false", {
    status: res.status,
    title: "Neo4j HTTP",
    confidence: port === 7474 ? 0.9 : 0.75,
    config: { url: origin, allowWrite: false },
  });
}

