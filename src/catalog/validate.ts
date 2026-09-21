import { hasProtocol, knownProtocols } from "../runtime/bootstrap.js";
import { AdapterError } from "../runtime/errors.js";
import type { JsonObject } from "../runtime/types.js";

const ALIAS: Record<string, string> = {
  http: "openapi",
  ws: "websocket",
  mariadb: "mysql",
  pg: "postgres",
  postgresql: "postgres",
  enip: "ethernetip",
  influxdb: "influx",
  k8s: "kubernetes",
};

export function canonicalProtocol(protocol: string): string {
  const p = protocol.toLowerCase().trim();
  return ALIAS[p] ?? p;
}

/** Human-readable required config for mcp_add. */
export const PROTOCOL_CONFIG_HELP: Record<string, string> = {
  openapi: "{ spec, baseUrl?, allowWrite? }",
  mqtt: "{ url, allowWrite? }",
  soap: "{ wsdl, endpoint?, soapVersion?, allowWrite? }",
  grpc: "{ proto | protoInline | reflection:true, target, allowWrite?, ca?|caFile?, cert?|certFile?, key?|keyFile? }",
  asyncapi: "{ spec, brokerUrl?, bind?, allowWrite? }",
  sparkplug: "{ url, groupId?, edgeNode?, hostId?, encoding?, allowWrite? }",
  websocket: "{ url, allowWrite? }",
  graphql: "{ url? | simulator:true | wsUrl?, allowWrite? }  (subscribe_once = graphql-ws; HTTP is query/mutate)",
  amqp: "{ url? | simulator:true, queue?, allowWrite? }  (publish/rpc 写闸; get/ack/nack)",
  kafka: "{ brokers, topic?, groupId?, groupInstanceId?, idempotent?, transactionalId? (recorded, unused), allowWrite? }",
  fix: "{ sender?, target?, allowWrite?  (logon/logout/NOS are writes; encode/decode/status are not) }",
  opcua: "{ endpoint, simulator?, allowWrite? }  (wait_data_change = memory monitored-item; subscribe_once 仍一次性)",
  modbus: "{ host, port?, mode?: tcp|rtu, unitId?, simulator?, allowWrite? }",
  coap: "{ host, port?, allowWrite? }",
  nats: "{ servers | url | simulator:true, allowWrite? }  (JetStream consumer/ack/interest 子集)",
  xmlrpc: "{ url, allowWrite? }",
  jsonrpc: "{ url, allowWrite? }",
  redis: "{ url, allowWrite? }",
  smtp: "{ host, from?, raw?, starttls?, allowWrite? }  (send_mail 写闸; noop 只读; raw:true 走 EHLO/MAIL/DATA; 不是 IMAP/POP3)",
  ldap: "{ url, base?, tls?, starttls?, allowWrite? }",
  bacnet: "{ host?, port?, deviceId?, devices?, udp?, allowWrite? }",
  ethernetip: "{ host?, port?, tcp?, tags?, allowWrite? }  (alias enip; CIP List Identity + local tags)",
  s7: "{ host?, port?, rack?, slot?, tcp?, allowWrite? }  (ISO-TCP/S7comm Read Var subset)",
  mtconnect: "{ url | fixture | xml }",
  sql: "{ driver: sqlite|postgres|mysql|sqlserver|duckdb, filename? | url?, allowWrite? }  (prefer specific protocol ids)",
  sqlite: "{ filename?, native?:true (optional better-sqlite3), allowWrite? }",
  postgres: "{ url? | simulator:true | native:true + url (optional pg), allowWrite? }",
  mysql: "{ url? | simulator:true | native:true + url (optional mysql2), allowWrite? }  (MariaDB compatible; alias mariadb)",
  sqlserver: "{ url? | simulator:true, allowWrite? }",
  duckdb: "{ filename? | simulator:true, allowWrite? }",
  mongodb: "{ url? | simulator:true, allowWrite? }  (无 url 内存; url 走 OP_MSG hello/find/insert/listCollections; 无 aggregation)",
  elasticsearch: "{ url? | simulator:true, allowWrite? }  (url 走 HTTP _cat/_search/_doc; 写闸)",
  opensearch: "{ url? | simulator:true, allowWrite? }  (ES 兼容 HTTP)",
  clickhouse: "{ url? | simulator:true, allowWrite? }  (HTTP POST query FORMAT JSONEachRow; INSERT/DDL 需 allowWrite)",
  neo4j: "{ url? | simulator:true, allowWrite? }  (http(s) /db/{db}/tx/commit; bolt 仍需注入 connectFn)",
  qdrant: "{ url? | simulator:true, allowWrite? }",
  s3: "{ bucket, endpoint?, allowWrite?, unsigned?, accessKey?, secretKey?, region?, simulator? }",
  gcs: "{ bucket, endpoint?, allowWrite?, unsigned?, token?, simulator? }",
  oss: "{ bucket, endpoint?, allowWrite?, unsigned?, accessKey?, secretKey?, simulator? }",
  influx: "{ bucket, url?, org?, token?, allowWrite? }  (alias influxdb; Flux + /api/v2/delete; not InfluxQL)",
  prometheus: "{ url? | simulator:true, timeoutMs?, allowWrite? }  (query/query_range; remote_write protobuf+snappy 需 allowWrite)",
  sqs: "{ queue, endpoint?, unsigned?, allowWrite? }",
  pulsar: "{ topic, serviceUrl? (memory:// | http + unsigned | pulsar:// official LOOKUP | pulsar:// + dialect=e2p1 | pulsar+ssl://), tenant?, namespace?, subscription?, unsigned?, dialect?, allowWrite? }",
  snmp: "{ host?, port?, community?, simulator?, allowWrite? }  (SNMPv2c Get/GetNext/walk/Set; not v3/USM)",
  webdav: "{ url?, simulator?, allowWrite? }  (PROPFIND/GET/PUT/DELETE/MKCOL)",
  ftp: "{ host?, port?, user?, password?, simulator?, allowWrite? }  (LIST/RETR/STOR/DELE; not SFTP/FTPS)",
  etcd: "{ url?, simulator?, allowWrite? }  (v3 HTTP KV range/put/delete; not watch/lease)",
  imap: "{ host?, port?, user?, password?, simulator?, allowWrite? }  (IMAP4rev1 LIST/SELECT/FETCH/SEARCH; APPEND/STORE/EXPUNGE 需 allowWrite; 不是 SMTP)",
  pop3: "{ host?, port?, user?, password?, simulator?, allowWrite? }  (STAT/LIST/RETR; DELE/RSET 需 allowWrite; 不是 SMTP)",
  consul: "{ url?, token?, simulator?, allowWrite? }  (HTTP KV + catalog/health; 写需 allowWrite; 无 Connect)",
  azureblob: "{ container, endpoint?, unsigned?, sasToken?, account?, accountKey?, simulator?, allowWrite? }  (SharedKey 子集或 SAS 查询串; 写需 allowWrite)",
  sftp: "{ host?, port?, user?, password?, simulator?, allowWrite? }  (SSH-2 SFTP; 不是 FTP)",
  memcached: "{ host?, port?, simulator?, allowWrite? }  (text GET/SET/DELETE/STATS)",
  tftp: "{ host?, port?, simulator?, allowWrite? }  (RFC1350 RRQ/WRQ; 不是 FTP/SFTP)",
  caldav: "{ url?, simulator?, allowWrite? }  (PROPFIND/REPORT time-range + freebusy; iTIP schedule E_UNSUPPORTED)",
  carddav: "{ url?, simulator?, allowWrite? }  (PROPFIND/REPORT addressbook-query/GET/PUT)",
  beanstalkd: "{ host?, port?, tube?, simulator?, allowWrite? }  (put/reserve/delete/stats)",
  zookeeper: "{ host?, port?, simulator?, allowWrite? }  (ruok + get/create + watch_once + multi; ACL/SASL E_UNSUPPORTED)",
  dns: "{ host?, port?, simulator?, timeoutMs? }  (unicast A/AAAA/TXT/PTR; 无 AXFR / 无组播)",
  cassandra: "{ host? | url? | simulator:true, port?, allowWrite? }  (CQL 子集; native v4 STARTUP/QUERY; 写闸)",
  couchdb: "{ url? | simulator:true, allowWrite? }  (_all_dbs / _all_docs / GET / PUT; 写闸)",
  whois: "{ host? | url? | simulator:true, port? }  (TCP 43 只读 query)",
  solr: "{ url? | simulator:true, allowWrite? }  (select/update HTTP; 写闸; 不是 SolrCloud admin)",
  rabbitmq: "{ url? | simulator:true, vhost?, allowWrite? }  (management HTTP 15672; 不是 AMQP 0-9-1)",
  kubernetes: "{ url? | simulator:true, namespace?, token? }  (只读 list/get pods/services/configmaps; exec/apply E_UNSUPPORTED)",
};

export function validateRegistration(protocol: string, name: string, config: JsonObject): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    throw new AdapterError("E_INVALID_CONFIG", "name must match [A-Za-z0-9_-]{1,64}", {
      details: { name },
    });
  }
  const raw = protocol.toLowerCase().trim();
  if (!raw) {
    throw new AdapterError("E_INVALID_CONFIG", 'Missing required string argument "protocol"');
  }
  const proto = canonicalProtocol(raw);
  if (!hasProtocol(raw) && !hasProtocol(proto)) {
    throw new AdapterError(
      "E_UNKNOWN_PROTOCOL",
      `Unknown protocol "${protocol}". Known adapters: ${knownProtocols().join(", ")}`,
      { details: { known: knownProtocols() } },
    );
  }
  validateProtocolConfig(proto, config);
}

export function validateProtocolConfig(protocol: string, config: JsonObject): void {
  const p = canonicalProtocol(protocol);
  const keys = Object.keys(config);
  const has = (...names: string[]) => names.some((k) => present(config[k]));

  const missing = (need: string, example: string) => {
    throw new AdapterError(
      "E_INVALID_CONFIG",
      `${p} adapter requires ${need}. Example config: ${example}. Got keys: [${keys.join(", ") || "(none)"}]`,
      { protocol: p, details: { keys, example } },
    );
  };

  switch (p) {
    case "openapi":
      if (!has("spec", "specUrl", "specPath")) missing("config.spec (file path or URL)", PROTOCOL_CONFIG_HELP.openapi!);
      break;
    case "mqtt":
      if (!has("url", "brokerUrl")) missing("config.url (mqtt://host:port)", PROTOCOL_CONFIG_HELP.mqtt!);
      break;
    case "soap":
      if (!has("wsdl", "wsdlUrl")) missing("config.wsdl (file path or URL)", PROTOCOL_CONFIG_HELP.soap!);
      break;
    case "grpc":
      if (!has("proto", "protoInline", "protoPath") && config.reflection !== true) {
        missing("config.proto, config.protoInline, or config.reflection=true", PROTOCOL_CONFIG_HELP.grpc!);
      }
      if (!has("target")) missing("config.target (host:port)", PROTOCOL_CONFIG_HELP.grpc!);
      break;
    case "asyncapi":
      if (!has("spec", "asyncapi")) missing("config.spec (file path or URL)", PROTOCOL_CONFIG_HELP.asyncapi!);
      break;
    case "sparkplug":
      if (!has("url", "brokerUrl")) missing("config.url (mqtt://host:port)", PROTOCOL_CONFIG_HELP.sparkplug!);
      break;
    case "websocket":
      if (!has("url")) missing("config.url (ws:// or wss://)", PROTOCOL_CONFIG_HELP.websocket!);
      break;
    case "graphql":
      if (config.simulator !== true && !has("url", "endpoint", "wsUrl")) {
        missing("config.url or simulator:true or wsUrl", PROTOCOL_CONFIG_HELP.graphql!);
      }
      break;
    case "xmlrpc":
    case "jsonrpc":
    case "redis":
    case "ldap":
      if (!has("url", "endpoint")) missing("config.url", PROTOCOL_CONFIG_HELP[p]!);
      break;
    case "amqp":
      if (config.simulator !== true && !has("url")) missing("config.url (amqp://...) or simulator:true", PROTOCOL_CONFIG_HELP.amqp!);
      break;
    case "kafka": {
      const brokers = config.brokers;
      if (!Array.isArray(brokers) || brokers.filter((x) => typeof x === "string" && x.trim()).length === 0) {
        missing("config.brokers (non-empty string array)", PROTOCOL_CONFIG_HELP.kafka!);
      }
      break;
    }
    case "opcua":
      if (!has("endpoint", "url")) missing("config.endpoint (opc.tcp://host:port)", PROTOCOL_CONFIG_HELP.opcua!);
      break;
    case "modbus":
    case "coap":
    case "smtp":
      if (!has("host", "url")) missing(`config.host`, PROTOCOL_CONFIG_HELP[p]!);
      break;
    case "nats":
      if (
        config.simulator !== true &&
        !has("url", "server") &&
        !(Array.isArray(config.servers) && config.servers.length)
      ) {
        missing("config.servers or config.url or simulator:true", PROTOCOL_CONFIG_HELP.nats!);
      }
      break;
    case "fix":
      break;
    case "bacnet":
    case "ethernetip":
    case "s7":
    case "snmp":
    case "webdav":
    case "ftp":
    case "etcd":
    case "imap":
    case "pop3":
    case "consul":
    case "sftp":
    case "memcached":
    case "tftp":
    case "caldav":
    case "carddav":
    case "beanstalkd":
    case "zookeeper":
    case "dns":
    case "cassandra":
    case "couchdb":
    case "whois":
    case "solr":
    case "rabbitmq":
    case "kubernetes":
      break;
    case "mtconnect":
      if (!has("url", "baseUrl", "fixture", "probeFixture", "xml", "probeXml")) {
        missing("config.url, config.fixture, or config.xml", PROTOCOL_CONFIG_HELP.mtconnect!);
      }
      break;
    case "sql":
      if (!has("filename", "database", "path", "url", "dsn", "simulator") && !has("driver")) {
        missing("config.driver and/or config.filename (sqlite) or config.url", PROTOCOL_CONFIG_HELP.sql!);
      }
      break;
    case "sqlite":
      break;
    case "postgres":
    case "mysql":
    case "sqlserver":
    case "duckdb":
    case "mongodb":
    case "elasticsearch":
    case "opensearch":
    case "clickhouse":
    case "neo4j":
    case "qdrant":
      break;
    case "s3":
    case "gcs":
    case "oss":
      if (!has("bucket", "bucketName")) missing("config.bucket", PROTOCOL_CONFIG_HELP[p]!);
      break;
    case "azureblob":
      if (!has("container", "bucket", "bucketName")) missing("config.container", PROTOCOL_CONFIG_HELP.azureblob!);
      break;
    case "influx":
      if (!has("bucket", "bucketName")) missing("config.bucket", PROTOCOL_CONFIG_HELP.influx!);
      break;
    case "prometheus":
      if (config.simulator !== true && !has("url", "baseUrl")) {
        missing("config.url (http://host:9090) or simulator:true", PROTOCOL_CONFIG_HELP.prometheus!);
      }
      break;
    case "sqs":
      if (!has("queue", "queueUrl", "queueName")) missing("config.queue", PROTOCOL_CONFIG_HELP.sqs!);
      break;
    case "pulsar":
      if (!has("topic", "defaultTopic")) missing("config.topic", PROTOCOL_CONFIG_HELP.pulsar!);
      break;
    default:
      break;
  }
}

function present(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && value !== false;
}
