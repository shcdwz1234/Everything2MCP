import { looksLikeNetworkRange, probeHost } from "./probe.js";
import { AdapterError } from "../runtime/errors.js";
import { assertHostAllowed } from "../runtime/ssrf.js";
import type { DiscoveryCandidate } from "../runtime/types.js";
import { listGrpcServices } from "../adapters/grpc/reflection.js";
import {
  fingerprintBacnet,
  fingerprintClickhouse,
  fingerprintCoap,
  fingerprintElasticsearch,
  fingerprintEthernetIp,
  fingerprintGcs,
  fingerprintInflux,
  fingerprintJsonRpc,
  fingerprintModbus,
  fingerprintMongodb,
  fingerprintMqtt,
  fingerprintMtConnect,
  fingerprintKafka,
  fingerprintAmqp,
  fingerprintOpcUa,
  fingerprintMysql,
  fingerprintNats,
  fingerprintNeo4j,
  fingerprintOss,
  fingerprintPostgres,
  fingerprintPrometheus,
  fingerprintPulsar,
  fingerprintQdrant,
  fingerprintRedis,
  fingerprintS3,
  fingerprintS7,
  fingerprintSmtp,
  fingerprintSqlServer,
  fingerprintXmlRpc,
  fingerprintFtp,
  fingerprintSnmp,
  fingerprintEtcd,
  fingerprintWebDav,
  fingerprintImap,
  fingerprintPop3,
  fingerprintConsul,
  fingerprintAzureBlob,
  fingerprintSftp,
  fingerprintMemcached,
  fingerprintTftp,
  fingerprintCalDav,
  fingerprintCardDav,
  fingerprintBeanstalkd,
  fingerprintZookeeper,
  fingerprintDns,
  fingerprintCassandra,
  fingerprintCouchdb,
  fingerprintWhois,
  fingerprintNeo4jHttp,
  fingerprintSolr,
  fingerprintRabbitmq,
  fingerprintKubernetes,
  httpGet,
  httpPost,
} from "./fingerprint.js";
import { ssdpUnicastSearch } from "./ssdp.js";
import { mdnsUnicastQuery } from "./dnssd.js";

export const WELL_KNOWN_PORTS = {
  http: [80, 8080, 8000],
  https: [443, 8443],
  grpc: [50051],
  redis: [6379],
  mqtt: [1883],
  modbus: [502],
  coap: [5683],
  nats: [4222],
  postgres: [5432],
  mysql: [3306],
  sqlserver: [1433],
  mongodb: [27017],
  elasticsearch: [9200],
  clickhouse: [8123],
  neo4j: [7687],
  qdrant: [6333],
  s3: [9000],
  prometheus: [9090],
  kafka: [9092],
  amqp: [5672],
  opcua: [4840],
  pulsar: [6650, 8080],
  gcs: [4443],
  influx: [8086],
  bacnet: [47808],
  ethernetip: [44818],
  s7: [102],
  mtconnect: [5000, 80],
  smtp: [25, 587],
  ftp: [21],
  snmp: [161],
  etcd: [2379],
  ssdp: [1900],
  imap: [143],
  pop3: [110],
  consul: [8500],
  azureblob: [10000],
  mdns: [5353],
  sftp: [22],
  memcached: [11211],
  tftp: [69],
  caldav: [5232],
  carddav: [5232],
  beanstalkd: [11300],
  zookeeper: [2181],
  dns: [53],
  cassandra: [9042],
  couchdb: [5984],
  whois: [43],
  neo4jHttp: [7474],
  solr: [8983],
  rabbitmq: [15672],
  kubernetes: [6443],
} as const;

export interface ScanOptions {
  host: string;
  port?: number;
  https?: boolean;
  protocols?: string[];
  timeoutMs: number;
  /** When true, only the given port is probed (HTTP + whatever protocol matches that port). */
  onlyGivenPort?: boolean;
  transports?: ScanTransports;
}

export interface ScanTransports {
  httpGet?: typeof httpGet;
  httpPost?: typeof httpPost;
  redis?: typeof fingerprintRedis;
  mqtt?: typeof fingerprintMqtt;
  nats?: typeof fingerprintNats;
  modbus?: typeof fingerprintModbus;
  coap?: typeof fingerprintCoap;
  jsonrpc?: typeof fingerprintJsonRpc;
  xmlrpc?: typeof fingerprintXmlRpc;
  grpcList?: (target: string, timeoutMs: number) => Promise<string[] | undefined>;
  postgres?: typeof fingerprintPostgres;
  mysql?: typeof fingerprintMysql;
  sqlserver?: typeof fingerprintSqlServer;
  mongodb?: typeof fingerprintMongodb;
  elasticsearch?: typeof fingerprintElasticsearch;
  clickhouse?: typeof fingerprintClickhouse;
  neo4j?: typeof fingerprintNeo4j;
  qdrant?: typeof fingerprintQdrant;
  s3?: typeof fingerprintS3;
  prometheus?: typeof fingerprintPrometheus;
  kafka?: typeof fingerprintKafka;
  amqp?: typeof fingerprintAmqp;
  opcua?: typeof fingerprintOpcUa;
  pulsar?: typeof fingerprintPulsar;
  gcs?: typeof fingerprintGcs;
  oss?: typeof fingerprintOss;
  influx?: typeof fingerprintInflux;
  bacnet?: typeof fingerprintBacnet;
  ethernetip?: typeof fingerprintEthernetIp;
  s7?: typeof fingerprintS7;
  mtconnect?: typeof fingerprintMtConnect;
  smtp?: typeof fingerprintSmtp;
  ftp?: typeof fingerprintFtp;
  snmp?: typeof fingerprintSnmp;
  etcd?: typeof fingerprintEtcd;
  webdav?: typeof fingerprintWebDav;
  ssdp?: typeof ssdpUnicastSearch;
  imap?: typeof fingerprintImap;
  pop3?: typeof fingerprintPop3;
  consul?: typeof fingerprintConsul;
  azureblob?: typeof fingerprintAzureBlob;
  mdns?: typeof mdnsUnicastQuery;
  sftp?: typeof fingerprintSftp;
  memcached?: typeof fingerprintMemcached;
  tftp?: typeof fingerprintTftp;
  caldav?: typeof fingerprintCalDav;
  carddav?: typeof fingerprintCardDav;
  beanstalkd?: typeof fingerprintBeanstalkd;
  zookeeper?: typeof fingerprintZookeeper;
  dns?: typeof fingerprintDns;
  cassandra?: typeof fingerprintCassandra;
  couchdb?: typeof fingerprintCouchdb;
  whois?: typeof fingerprintWhois;
  neo4jHttp?: typeof fingerprintNeo4jHttp;
  solr?: typeof fingerprintSolr;
  rabbitmq?: typeof fingerprintRabbitmq;
  kubernetes?: typeof fingerprintKubernetes;
}

const ALL_PROTOCOLS = [
  "openapi",
  "soap",
  "graphql",
  "grpc",
  "redis",
  "mqtt",
  "modbus",
  "coap",
  "nats",
  "jsonrpc",
  "xmlrpc",
  "postgres",
  "mysql",
  "sqlserver",
  "mongodb",
  "elasticsearch",
  "opensearch",
  "clickhouse",
  "neo4j",
  "qdrant",
  "s3",
  "prometheus",
  "kafka",
  "amqp",
  "opcua",
  "pulsar",
  "gcs",
  "oss",
  "influx",
  "bacnet",
  "ethernetip",
  "enip",
  "s7",
  "mtconnect",
  "smtp",
  "ftp",
  "snmp",
  "etcd",
  "webdav",
  "ssdp",
  "imap",
  "pop3",
  "consul",
  "azureblob",
  "mdns",
  "sftp",
  "memcached",
  "tftp",
  "caldav",
  "carddav",
  "beanstalkd",
  "zookeeper",
  "dns",
  "cassandra",
  "couchdb",
  "whois",
  "solr",
  "rabbitmq",
  "kubernetes",
  "k8s",
];

export async function scanHost(opts: ScanOptions): Promise<DiscoveryCandidate[]> {
  if (looksLikeNetworkRange(opts.host)) {
    throw new AdapterError("E_UNSUPPORTED", "Host looks like a range; single host/IP only");
  }
  await assertHostAllowed(opts.host);
  const wanted = new Set((opts.protocols?.length ? opts.protocols : ALL_PROTOCOLS).map((p) => p.toLowerCase()));
  const t: Required<ScanTransports> = {
    httpGet: opts.transports?.httpGet ?? httpGet,
    httpPost: opts.transports?.httpPost ?? httpPost,
    redis: opts.transports?.redis ?? fingerprintRedis,
    mqtt: opts.transports?.mqtt ?? fingerprintMqtt,
    nats: opts.transports?.nats ?? fingerprintNats,
    modbus: opts.transports?.modbus ?? fingerprintModbus,
    coap: opts.transports?.coap ?? fingerprintCoap,
    jsonrpc: opts.transports?.jsonrpc ?? fingerprintJsonRpc,
    xmlrpc: opts.transports?.xmlrpc ?? fingerprintXmlRpc,
    grpcList:
      opts.transports?.grpcList ??
      (async (target, timeoutMs) => {
        try {
          return await listGrpcServices(target, { timeoutMs });
        } catch {
          return undefined;
        }
      }),
    postgres: opts.transports?.postgres ?? fingerprintPostgres,
    mysql: opts.transports?.mysql ?? fingerprintMysql,
    sqlserver: opts.transports?.sqlserver ?? fingerprintSqlServer,
    mongodb: opts.transports?.mongodb ?? fingerprintMongodb,
    elasticsearch: opts.transports?.elasticsearch ?? fingerprintElasticsearch,
    clickhouse: opts.transports?.clickhouse ?? fingerprintClickhouse,
    neo4j: opts.transports?.neo4j ?? fingerprintNeo4j,
    qdrant: opts.transports?.qdrant ?? fingerprintQdrant,
    s3: opts.transports?.s3 ?? fingerprintS3,
    prometheus: opts.transports?.prometheus ?? fingerprintPrometheus,
    kafka: opts.transports?.kafka ?? fingerprintKafka,
    amqp: opts.transports?.amqp ?? fingerprintAmqp,
    opcua: opts.transports?.opcua ?? fingerprintOpcUa,
    pulsar: opts.transports?.pulsar ?? fingerprintPulsar,
    gcs: opts.transports?.gcs ?? fingerprintGcs,
    oss: opts.transports?.oss ?? fingerprintOss,
    influx: opts.transports?.influx ?? fingerprintInflux,
    bacnet: opts.transports?.bacnet ?? fingerprintBacnet,
    ethernetip: opts.transports?.ethernetip ?? fingerprintEthernetIp,
    s7: opts.transports?.s7 ?? fingerprintS7,
    mtconnect: opts.transports?.mtconnect ?? fingerprintMtConnect,
    smtp: opts.transports?.smtp ?? fingerprintSmtp,
    ftp: opts.transports?.ftp ?? fingerprintFtp,
    snmp: opts.transports?.snmp ?? fingerprintSnmp,
    etcd: opts.transports?.etcd ?? fingerprintEtcd,
    webdav: opts.transports?.webdav ?? fingerprintWebDav,
    ssdp: opts.transports?.ssdp ?? ssdpUnicastSearch,
    imap: opts.transports?.imap ?? fingerprintImap,
    pop3: opts.transports?.pop3 ?? fingerprintPop3,
    consul: opts.transports?.consul ?? fingerprintConsul,
    azureblob: opts.transports?.azureblob ?? fingerprintAzureBlob,
    mdns: opts.transports?.mdns ?? mdnsUnicastQuery,
    sftp: opts.transports?.sftp ?? fingerprintSftp,
    memcached: opts.transports?.memcached ?? fingerprintMemcached,
    tftp: opts.transports?.tftp ?? fingerprintTftp,
    caldav: opts.transports?.caldav ?? fingerprintCalDav,
    carddav: opts.transports?.carddav ?? fingerprintCardDav,
    beanstalkd: opts.transports?.beanstalkd ?? fingerprintBeanstalkd,
    zookeeper: opts.transports?.zookeeper ?? fingerprintZookeeper,
    dns: opts.transports?.dns ?? fingerprintDns,
    cassandra: opts.transports?.cassandra ?? fingerprintCassandra,
    couchdb: opts.transports?.couchdb ?? fingerprintCouchdb,
    whois: opts.transports?.whois ?? fingerprintWhois,
    neo4jHttp: opts.transports?.neo4jHttp ?? fingerprintNeo4jHttp,
    solr: opts.transports?.solr ?? fingerprintSolr,
    rabbitmq: opts.transports?.rabbitmq ?? fingerprintRabbitmq,
    kubernetes: opts.transports?.kubernetes ?? fingerprintKubernetes,
  };

  const jobs: Array<Promise<DiscoveryCandidate | undefined | DiscoveryCandidate[]>> = [];
  const timeoutMs = opts.timeoutMs;

  const httpPorts = httpPortsFor(opts);
  if (wanted.has("openapi") || wanted.has("soap") || wanted.has("graphql") || wanted.has("http") || wanted.has("webdav") || wanted.has("caldav") || wanted.has("carddav")) {
    for (const { port, https } of httpPorts) {
      jobs.push(
        probeHost({
          host: opts.host,
          port,
          https,
          protocols: [...wanted],
          timeoutMs,
        }).catch(() => []),
      );
    }
  }

  const originFor = (port: number, https: boolean) =>
    `${https ? "https" : "http"}://${formatHost(opts.host)}:${port}`;

  if (wanted.has("jsonrpc")) {
    for (const hp of httpPorts) {
      jobs.push(t.jsonrpc(originFor(hp.port, hp.https), timeoutMs));
    }
  }
  if (wanted.has("xmlrpc")) {
    for (const hp of httpPorts) {
      jobs.push(t.xmlrpc(originFor(hp.port, hp.https), timeoutMs));
    }
  }

  const protoPort = (defaults: readonly number[]) => {
    if (opts.onlyGivenPort && opts.port !== undefined) return [opts.port];
    if (opts.port !== undefined) return unique([opts.port, ...defaults]);
    return [...defaults];
  };

  if (wanted.has("redis")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.redis)) jobs.push(t.redis(opts.host, port, timeoutMs));
  }
  if (wanted.has("mqtt")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.mqtt)) jobs.push(t.mqtt(opts.host, port, timeoutMs));
  }
  if (wanted.has("nats")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.nats)) jobs.push(t.nats(opts.host, port, timeoutMs));
  }
  if (wanted.has("modbus")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.modbus)) jobs.push(t.modbus(opts.host, port, timeoutMs));
  }
  if (wanted.has("coap")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.coap)) jobs.push(t.coap(opts.host, port, timeoutMs));
  }
  if (wanted.has("grpc")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.grpc)) {
      jobs.push(
        (async () => {
          const services = await t.grpcList(`${opts.host}:${port}`, timeoutMs);
          if (!services?.length) return undefined;
          return {
            protocol: "grpc",
            url: `${opts.host}:${port}`,
            hint: "mcp_add protocol=grpc config.reflection=true config.target=<host:port>",
            status: 1,
            title: services.slice(0, 5).join(", "),
            confidence: 0.84,
            detail: `services=${services.join(",")}`,
            config: { target: `${opts.host}:${port}`, reflection: true },
          } satisfies DiscoveryCandidate;
        })(),
      );
    }
  }

  if (wanted.has("postgres")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.postgres)) jobs.push(t.postgres(opts.host, port, timeoutMs));
  }
  if (wanted.has("mysql")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.mysql)) jobs.push(t.mysql(opts.host, port, timeoutMs));
  }
  if (wanted.has("sqlserver")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.sqlserver)) jobs.push(t.sqlserver(opts.host, port, timeoutMs));
  }
  if (wanted.has("mongodb")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.mongodb)) jobs.push(t.mongodb(opts.host, port, timeoutMs));
  }
  if (wanted.has("elasticsearch") || wanted.has("opensearch")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.elasticsearch)) {
      jobs.push(t.elasticsearch(opts.host, port, timeoutMs, t.httpGet));
    }
  }
  if (wanted.has("clickhouse")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.clickhouse)) {
      jobs.push(t.clickhouse(opts.host, port, timeoutMs, t.httpGet));
    }
  }
  if (wanted.has("neo4j")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.neo4j)) jobs.push(t.neo4j(opts.host, port, timeoutMs));
    for (const port of protoPort(WELL_KNOWN_PORTS.neo4jHttp)) {
      jobs.push(t.neo4jHttp(opts.host, port, timeoutMs, t.httpGet));
    }
  }
  if (wanted.has("qdrant")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.qdrant)) jobs.push(t.qdrant(opts.host, port, timeoutMs, t.httpGet));
  }
  if (wanted.has("s3") || wanted.has("minio")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.s3)) {
      jobs.push(t.s3(opts.host, port, timeoutMs, t.httpGet));
    }
  }
  if (wanted.has("kafka")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.kafka)) jobs.push(t.kafka(opts.host, port, timeoutMs));
  }
  if (wanted.has("amqp")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.amqp)) jobs.push(t.amqp(opts.host, port, timeoutMs));
  }
  if (wanted.has("opcua")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.opcua)) jobs.push(t.opcua(opts.host, port, timeoutMs));
  }
  if (wanted.has("prometheus")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.prometheus)) {
      jobs.push(t.prometheus(opts.host, port, timeoutMs, t.httpGet));
    }
  }
  if (wanted.has("pulsar")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.pulsar)) {
      jobs.push(t.pulsar(opts.host, port, timeoutMs, t.httpGet));
    }
  }
  if (wanted.has("gcs")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.gcs)) {
      jobs.push(t.gcs(opts.host, port, timeoutMs, t.httpGet));
    }
  }
  if (wanted.has("oss")) {
    for (const hp of httpPorts) {
      jobs.push(t.oss(opts.host, hp.port, timeoutMs, t.httpGet));
    }
  }
  if (wanted.has("influx") || wanted.has("influxdb")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.influx)) {
      jobs.push(t.influx(opts.host, port, timeoutMs, t.httpGet));
    }
  }
  if (wanted.has("bacnet")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.bacnet)) {
      jobs.push(t.bacnet(opts.host, port, timeoutMs));
    }
  }
  if (wanted.has("ethernetip") || wanted.has("enip")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.ethernetip)) {
      jobs.push(t.ethernetip(opts.host, port, timeoutMs));
    }
  }
  if (wanted.has("s7")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.s7)) {
      jobs.push(t.s7(opts.host, port, timeoutMs));
    }
  }
  if (wanted.has("mtconnect")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.mtconnect)) {
      jobs.push(t.mtconnect(opts.host, port, timeoutMs, t.httpGet));
    }
  }
  if (wanted.has("smtp")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.smtp)) jobs.push(t.smtp(opts.host, port, timeoutMs));
  }
  if (wanted.has("ftp")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.ftp)) jobs.push(t.ftp(opts.host, port, timeoutMs));
  }
  if (wanted.has("snmp")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.snmp)) jobs.push(t.snmp(opts.host, port, timeoutMs));
  }
  if (wanted.has("etcd")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.etcd)) {
      jobs.push(t.etcd(opts.host, port, timeoutMs, t.httpGet));
    }
  }
  if (wanted.has("webdav") || wanted.has("dav")) {
    for (const hp of httpPorts) {
      jobs.push(t.webdav(originFor(hp.port, hp.https), timeoutMs, t.httpGet));
    }
  }
  if (wanted.has("ssdp") || wanted.has("upnp")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.ssdp)) {
      jobs.push(t.ssdp({ host: opts.host, port, timeoutMs }));
    }
  }
  if (wanted.has("imap")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.imap)) jobs.push(t.imap(opts.host, port, timeoutMs));
  }
  if (wanted.has("pop3")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.pop3)) jobs.push(t.pop3(opts.host, port, timeoutMs));
  }
  if (wanted.has("consul")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.consul)) {
      jobs.push(t.consul(opts.host, port, timeoutMs, t.httpGet));
    }
  }
  if (wanted.has("azureblob")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.azureblob)) {
      jobs.push(t.azureblob(opts.host, port, timeoutMs, t.httpGet));
    }
  }
  if (wanted.has("mdns") || wanted.has("dnssd")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.mdns)) {
      jobs.push(t.mdns({ host: opts.host, port, timeoutMs }));
    }
  }
  if (wanted.has("sftp")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.sftp)) jobs.push(t.sftp(opts.host, port, timeoutMs));
  }
  if (wanted.has("memcached")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.memcached)) jobs.push(t.memcached(opts.host, port, timeoutMs));
  }
  if (wanted.has("tftp")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.tftp)) jobs.push(t.tftp(opts.host, port, timeoutMs));
  }
  if (wanted.has("caldav")) {
    for (const hp of httpPorts) jobs.push(t.caldav(originFor(hp.port, hp.https), timeoutMs));
    for (const port of protoPort(WELL_KNOWN_PORTS.caldav)) {
      jobs.push(t.caldav(`http://${formatHost(opts.host)}:${port}`, timeoutMs));
    }
  }
  if (wanted.has("carddav")) {
    for (const hp of httpPorts) jobs.push(t.carddav(originFor(hp.port, hp.https), timeoutMs));
    for (const port of protoPort(WELL_KNOWN_PORTS.carddav)) {
      jobs.push(t.carddav(`http://${formatHost(opts.host)}:${port}`, timeoutMs));
    }
  }
  if (wanted.has("beanstalkd")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.beanstalkd)) jobs.push(t.beanstalkd(opts.host, port, timeoutMs));
  }
  if (wanted.has("zookeeper") || wanted.has("zk")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.zookeeper)) jobs.push(t.zookeeper(opts.host, port, timeoutMs));
  }
  if (wanted.has("dns")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.dns)) jobs.push(t.dns(opts.host, port, timeoutMs));
  }
  if (wanted.has("cassandra")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.cassandra)) jobs.push(t.cassandra(opts.host, port, timeoutMs));
  }
  if (wanted.has("couchdb")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.couchdb)) {
      jobs.push(t.couchdb(opts.host, port, timeoutMs, t.httpGet));
    }
  }
  if (wanted.has("whois")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.whois)) jobs.push(t.whois(opts.host, port, timeoutMs));
  }
  if (wanted.has("solr")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.solr)) {
      jobs.push(t.solr(opts.host, port, timeoutMs, t.httpGet));
    }
  }
  if (wanted.has("rabbitmq")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.rabbitmq)) {
      jobs.push(t.rabbitmq(opts.host, port, timeoutMs, t.httpGet));
    }
  }
  if (wanted.has("kubernetes") || wanted.has("k8s")) {
    for (const port of protoPort(WELL_KNOWN_PORTS.kubernetes)) {
      jobs.push(t.kubernetes(opts.host, port, timeoutMs, t.httpGet));
    }
  }

  const settled = await Promise.all(jobs);
  const flat = settled.flatMap((item) => (Array.isArray(item) ? item : item ? [item] : []));
  return dedupe(flat);
}

function httpPortsFor(opts: ScanOptions): Array<{ port: number; https: boolean }> {
  if (opts.port !== undefined) {
    const https = Boolean(opts.https) || opts.port === 443 || opts.port === 8443;
    return [{ port: opts.port, https }];
  }
  if (opts.https) return WELL_KNOWN_PORTS.https.map((port) => ({ port, https: true }));
  return [
    ...WELL_KNOWN_PORTS.http.map((port) => ({ port, https: false })),
    { port: 443, https: true },
  ];
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function unique(nums: number[]): number[] {
  return [...new Set(nums)];
}

function dedupe(items: DiscoveryCandidate[]): DiscoveryCandidate[] {
  const seen = new Set<string>();
  const out: DiscoveryCandidate[] = [];
  for (const c of items) {
    const key = `${c.protocol}|${c.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
