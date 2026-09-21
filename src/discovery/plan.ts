import { knownProtocols } from "../runtime/bootstrap.js";

export interface PlanStep {
  tool: string;
  arguments: Record<string, unknown>;
  why: string;
}

export interface ProtocolRecommendation {
  protocol: string;
  confidence: number;
  reason: string;
  exampleConfig: Record<string, unknown>;
}

export interface BridgePlan {
  goal: string;
  host?: string;
  recommendations: ProtocolRecommendation[];
  steps: PlanStep[];
  notes: string[];
}

const RULES: Array<{ protocol: string; re: RegExp; reason: string; config: (host?: string) => Record<string, unknown> }> =
  [
    {
      protocol: "openapi",
      re: /openapi|swagger|rest\b|http api|oas3|json api|openapi 规范/i,
      reason: "Goal mentions REST/OpenAPI/Swagger",
      config: (host) => ({ spec: host ? `http://${host}/openapi.json` : "./openapi.json" }),
    },
    {
      protocol: "graphql",
      re: /graphql|gql\b/i,
      reason: "Goal mentions GraphQL",
      config: (host) => ({ url: host ? `http://${host}/graphql` : "http://127.0.0.1:4000/graphql", allowWrite: false }),
    },
    {
      protocol: "soap",
      re: /soap|wsdl/i,
      reason: "Goal mentions SOAP/WSDL",
      config: (host) => ({ wsdl: host ? `http://${host}/?wsdl` : "./service.wsdl" }),
    },
    {
      protocol: "grpc",
      re: /grpc|protobuf|proto3|reflection/i,
      reason: "Goal mentions gRPC/protobuf",
      config: (host) =>
        host ? { target: `${host}:50051`, reflection: true } : { proto: "./service.proto", target: "127.0.0.1:50051" },
    },
    {
      protocol: "sparkplug",
      re: /sparkplug/i,
      reason: "Goal mentions Sparkplug B",
      config: (host) => ({ url: `mqtt://${host ?? "127.0.0.1"}:1883`, groupId: "IIoT", edgeNode: "node1" }),
    },
    {
      protocol: "mqtt",
      re: /mqtt|iot broker|topic\b/i,
      reason: "Goal mentions MQTT",
      config: (host) => ({ url: `mqtt://${host ?? "127.0.0.1"}:1883` }),
    },
    {
      protocol: "asyncapi",
      re: /asyncapi|async api|event[- ]driven/i,
      reason: "Goal mentions AsyncAPI",
      config: () => ({ spec: "./asyncapi.yaml" }),
    },
    {
      protocol: "amqp",
      re: /amqp|rabbitmq/i,
      reason: "Goal mentions AMQP/RabbitMQ",
      config: (host) => ({ url: `amqp://${host ?? "127.0.0.1"}:5672`, allowWrite: false }),
    },
    {
      protocol: "kafka",
      re: /kafka/i,
      reason: "Goal mentions Kafka",
      config: (host) => ({ brokers: [`${host ?? "127.0.0.1"}:9092`] }),
    },
    {
      protocol: "nats",
      re: /nats|jetstream/i,
      reason: "Goal mentions NATS",
      config: (host) => ({ url: `nats://${host ?? "127.0.0.1"}:4222`, allowWrite: false }),
    },
    {
      protocol: "redis",
      re: /redis/i,
      reason: "Goal mentions Redis",
      config: (host) => ({ url: `redis://${host ?? "127.0.0.1"}:6379` }),
    },
    {
      protocol: "modbus",
      re: /modbus/i,
      reason: "Goal mentions Modbus",
      config: (host) => ({ host: host ?? "127.0.0.1", port: 502 }),
    },
    {
      protocol: "opcua",
      re: /opc-?ua|opcua/i,
      reason: "Goal mentions OPC-UA",
      config: (host) => ({ endpoint: `opc.tcp://${host ?? "127.0.0.1"}:4840`, allowWrite: false }),
    },
    {
      protocol: "coap",
      re: /coap/i,
      reason: "Goal mentions CoAP",
      config: (host) => ({ host: host ?? "127.0.0.1", port: 5683 }),
    },
    {
      protocol: "jsonrpc",
      re: /json-?rpc/i,
      reason: "Goal mentions JSON-RPC",
      config: (host) => ({ url: host ? `http://${host}/jsonrpc` : "http://127.0.0.1/jsonrpc" }),
    },
    {
      protocol: "xmlrpc",
      re: /xml-?rpc/i,
      reason: "Goal mentions XML-RPC",
      config: (host) => ({ url: host ? `http://${host}/RPC2` : "http://127.0.0.1/RPC2" }),
    },
    {
      protocol: "websocket",
      re: /web\s*socket|\bws\b|\bwss\b/i,
      reason: "Goal mentions WebSocket",
      config: (host) => ({ url: `ws://${host ?? "127.0.0.1"}:8080` }),
    },
    {
      protocol: "ldap",
      re: /ldap|active directory|目录服务/i,
      reason: "Goal mentions LDAP",
      config: (host) => ({ url: `ldap://${host ?? "127.0.0.1"}:389` }),
    },
    {
      protocol: "smtp",
      re: /smtp|email|邮件/i,
      reason: "Goal mentions SMTP/email",
      config: (host) => ({ host: host ?? "127.0.0.1", port: 587 }),
    },
    {
      protocol: "fix",
      re: /\bfix\b|newordersingle/i,
      reason: "Goal mentions FIX",
      config: () => ({ sender: "AGENT", target: "BROKER" }),
    },
    {
      protocol: "bacnet",
      re: /bacnet/i,
      reason: "Goal mentions BACnet",
      config: (host) => ({ host: host ?? "127.0.0.1", port: 47808, udp: true, allowWrite: false }),
    },
    {
      protocol: "ethernetip",
      re: /ethernet\/?ip|\benip\b|\bcip\b|list identity|rockwell|compactlogix|controllogix/i,
      reason: "Goal mentions EtherNet/IP / CIP",
      config: (host) => ({ host: host ?? "127.0.0.1", port: 44818, tcp: true, allowWrite: false }),
    },
    {
      protocol: "s7",
      re: /\bs7\b|s7comm|siemens|iso-tcp|step7|tia portal/i,
      reason: "Goal mentions Siemens S7",
      config: (host) => ({ host: host ?? "127.0.0.1", port: 102, rack: 0, slot: 1, tcp: true, allowWrite: false }),
    },
    {
      protocol: "mtconnect",
      re: /mtconnect|mtc agent/i,
      reason: "Goal mentions MTConnect",
      config: (host) => ({ url: `http://${host ?? "127.0.0.1"}:5000` }),
    },
    {
      protocol: "sqlite",
      re: /sqlite/i,
      reason: "Goal mentions SQLite",
      config: () => ({ filename: ":memory:", allowWrite: false }),
    },
    {
      protocol: "postgres",
      re: /postgres|postgresql|\bpgsql\b/i,
      reason: "Goal mentions PostgreSQL",
      config: (host) => ({ url: `postgres://${host ?? "127.0.0.1"}:5432/postgres`, allowWrite: false }),
    },
    {
      protocol: "mysql",
      re: /mysql|mariadb/i,
      reason: "Goal mentions MySQL/MariaDB",
      config: (host) => ({ url: `mysql://${host ?? "127.0.0.1"}:3306/mysql`, allowWrite: false }),
    },
    {
      protocol: "sqlserver",
      re: /sql\s*server|mssql|azure sql/i,
      reason: "Goal mentions SQL Server",
      config: (host) => ({ url: `sqlserver://${host ?? "127.0.0.1"}:1433`, simulator: true, allowWrite: false }),
    },
    {
      protocol: "duckdb",
      re: /duckdb/i,
      reason: "Goal mentions DuckDB",
      config: () => ({ simulator: true, allowWrite: false }),
    },
    {
      protocol: "mongodb",
      re: /mongo(db)?/i,
      reason: "Goal mentions MongoDB",
      config: (host) => ({ url: `mongodb://${host ?? "127.0.0.1"}:27017`, allowWrite: false }),
    },
    {
      protocol: "elasticsearch",
      re: /elastic(search)?|opensearch/i,
      reason: "Goal mentions Elasticsearch/OpenSearch",
      config: (host) => ({ url: `http://${host ?? "127.0.0.1"}:9200`, allowWrite: false }),
    },
    {
      protocol: "clickhouse",
      re: /clickhouse/i,
      reason: "Goal mentions ClickHouse",
      config: (host) => ({ url: `http://${host ?? "127.0.0.1"}:8123`, allowWrite: false }),
    },
    {
      protocol: "neo4j",
      re: /neo4j|cypher/i,
      reason: "Goal mentions Neo4j",
      config: (host) => ({ url: `http://${host ?? "127.0.0.1"}:7474`, allowWrite: false }),
    },
    {
      protocol: "qdrant",
      re: /qdrant|vector db|向量/i,
      reason: "Goal mentions Qdrant / vectors",
      config: (host) => ({ url: `http://${host ?? "127.0.0.1"}:6333`, allowWrite: false }),
    },
    {
      protocol: "sql",
      re: /\bsql\b/i,
      reason: "Goal mentions generic SQL — prefer sqlite/postgres/mysql protocol ids",
      config: () => ({ driver: "sqlite", filename: ":memory:", allowWrite: false }),
    },
    {
      protocol: "s3",
      re: /\bs3\b|minio|object store/i,
      reason: "Goal mentions S3/MinIO",
      config: (host) => ({
        bucket: "data",
        endpoint: host ? `http://${host}:9000` : "memory://",
        unsigned: Boolean(host),
        simulator: !host,
        allowWrite: false,
      }),
    },
    {
      protocol: "gcs",
      re: /\bgcs\b|google cloud storage|fake-gcs/i,
      reason: "Goal mentions Google Cloud Storage",
      config: (host) => ({
        bucket: "data",
        endpoint: host ? `http://${host}:4443` : "memory://",
        unsigned: Boolean(host),
        simulator: !host,
        allowWrite: false,
      }),
    },
    {
      protocol: "oss",
      re: /\baliyun oss\b|\boss bucket\b|alibaba (cloud )?oss/i,
      reason: "Goal mentions Aliyun OSS",
      config: (host) => ({
        bucket: "data",
        endpoint: host ? `http://${host}:80` : "memory://",
        unsigned: Boolean(host),
        simulator: !host,
        allowWrite: false,
      }),
    },
    {
      protocol: "influx",
      re: /influx/i,
      reason: "Goal mentions InfluxDB",
      config: (host) => ({
        url: host ? `http://${host}:8086` : "memory://",
        bucket: "metrics",
        org: "local",
        allowWrite: false,
      }),
    },
    {
      protocol: "prometheus",
      re: /prometheus|promql|remote_write/i,
      reason: "Goal mentions Prometheus",
      config: (host) => ({ url: `http://${host ?? "127.0.0.1"}:9090`, timeoutMs: 2500, allowWrite: false }),
    },
    {
      protocol: "sqs",
      re: /\bsqs\b|amazon sqs|cloud queue/i,
      reason: "Goal mentions SQS / cloud queue",
      config: (host) => ({
        queue: "orders",
        endpoint: host ? `http://${host}:4566` : "memory://",
        unsigned: Boolean(host),
        allowWrite: false,
      }),
    },
    {
      protocol: "snmp",
      re: /\bsnmp\b|sysdescr|mib-2/i,
      reason: "Goal mentions SNMP",
      config: (host) => ({ host: host ?? "127.0.0.1", port: 161, community: "public", allowWrite: false }),
    },
    {
      protocol: "webdav",
      re: /webdav|\bdav\b|propfind/i,
      reason: "Goal mentions WebDAV",
      config: (host) => ({ url: `http://${host ?? "127.0.0.1"}/dav`, allowWrite: false }),
    },
    {
      protocol: "caldav",
      re: /caldav|calendar-query|vevent|\bics\b/i,
      reason: "Goal mentions CalDAV",
      config: (host) => ({ url: `http://${host ?? "127.0.0.1"}:5232`, allowWrite: false }),
    },
    {
      protocol: "carddav",
      re: /carddav|addressbook|vcard/i,
      reason: "Goal mentions CardDAV",
      config: (host) => ({ url: `http://${host ?? "127.0.0.1"}:5232`, allowWrite: false }),
    },
    {
      protocol: "beanstalkd",
      re: /beanstalkd|beanstalk\b/i,
      reason: "Goal mentions Beanstalkd",
      config: (host) => ({ host: host ?? "127.0.0.1", port: 11300, allowWrite: false }),
    },
    {
      protocol: "zookeeper",
      re: /zookeeper|\bzk\b/i,
      reason: "Goal mentions ZooKeeper",
      config: (host) => ({ host: host ?? "127.0.0.1", port: 2181, allowWrite: false }),
    },
    {
      protocol: "dns",
      re: /\bdns\b|name server|resolve a record/i,
      reason: "Goal mentions DNS",
      config: (host) => ({ host: host ?? "127.0.0.1", port: 53, allowWrite: false }),
    },
    {
      protocol: "cassandra",
      re: /cassandra|\bcql\b/i,
      reason: "Goal mentions Cassandra / CQL",
      config: (host) => ({ host: host ?? "127.0.0.1", port: 9042, allowWrite: false }),
    },
    {
      protocol: "couchdb",
      re: /couchdb|couch\b/i,
      reason: "Goal mentions CouchDB",
      config: (host) => ({ url: `http://${host ?? "127.0.0.1"}:5984`, allowWrite: false }),
    },
    {
      protocol: "whois",
      re: /\bwhois\b/i,
      reason: "Goal mentions WHOIS",
      config: (host) => ({ host: host ?? "127.0.0.1", port: 43 }),
    },
    {
      protocol: "solr",
      re: /\bsolr\b/i,
      reason: "Goal mentions Solr",
      config: (host) => ({ url: `http://${host ?? "127.0.0.1"}:8983`, allowWrite: false }),
    },
    {
      protocol: "rabbitmq",
      re: /rabbitmq management|management api|rabbitmq http/i,
      reason: "Goal mentions RabbitMQ management HTTP (not AMQP wire)",
      config: (host) => ({ url: `http://${host ?? "127.0.0.1"}:15672`, vhost: "/", allowWrite: false }),
    },
    {
      protocol: "kubernetes",
      re: /kubernetes|\bk8s\b|kube api/i,
      reason: "Goal mentions Kubernetes API (read-only subset)",
      config: (host) => ({ url: `http://${host ?? "127.0.0.1"}:6443`, namespace: "default" }),
    },
    {
      protocol: "ftp",
      re: /\bftp\b|file transfer/i,
      reason: "Goal mentions FTP",
      config: (host) => ({ host: host ?? "127.0.0.1", port: 21, allowWrite: false }),
    },
    {
      protocol: "etcd",
      re: /\betcd\b/i,
      reason: "Goal mentions etcd",
      config: (host) => ({ url: `http://${host ?? "127.0.0.1"}:2379`, allowWrite: false }),
    },
    {
      protocol: "imap",
      re: /\bimap\b|mailboxes?|inbox/i,
      reason: "Goal mentions IMAP mailbox read",
      config: (host) => ({ host: host ?? "127.0.0.1", port: 143, allowWrite: false }),
    },
    {
      protocol: "pop3",
      re: /\bpop3\b|\bpop\b/i,
      reason: "Goal mentions POP3",
      config: (host) => ({ host: host ?? "127.0.0.1", port: 110, allowWrite: false }),
    },
    {
      protocol: "consul",
      re: /\bconsul\b/i,
      reason: "Goal mentions Consul",
      config: (host) => ({ url: `http://${host ?? "127.0.0.1"}:8500`, allowWrite: false }),
    },
    {
      protocol: "azureblob",
      re: /azure\s*blob|azurite|\bblob storage\b/i,
      reason: "Goal mentions Azure Blob",
      config: (host) => ({
        container: "data",
        endpoint: host ? `http://${host}:10000` : "memory://",
        unsigned: Boolean(host),
        allowWrite: false,
      }),
    },
    {
      protocol: "sftp",
      re: /\bsftp\b/i,
      reason: "Goal mentions SFTP (SSH file transfer, not FTP)",
      config: (host) => ({ host: host ?? "127.0.0.1", port: 22, allowWrite: false }),
    },
    {
      protocol: "memcached",
      re: /memcached|memcache\b/i,
      reason: "Goal mentions Memcached",
      config: (host) => ({ host: host ?? "127.0.0.1", port: 11211, allowWrite: false }),
    },
    {
      protocol: "tftp",
      re: /\btftp\b/i,
      reason: "Goal mentions TFTP",
      config: (host) => ({ host: host ?? "127.0.0.1", port: 69, allowWrite: false }),
    },
    {
      protocol: "pulsar",
      re: /pulsar/i,
      reason: "Goal mentions Apache Pulsar",
      config: (host) => ({
        topic: "events",
        serviceUrl: host ? `http://${host}:8080` : "memory://",
        tenant: "public",
        namespace: "default",
        allowWrite: false,
      }),
    },
  ];

export function planBridge(goal: string, hints: { host?: string } = {}): BridgePlan {
  const host = hints.host?.trim() || extractHost(goal);
  const matches = RULES.filter((r) => r.re.test(goal)).map((r) => ({
    protocol: r.protocol,
    confidence: 0.82,
    reason: r.reason,
    exampleConfig: r.config(host),
  }));
  const recommendations =
    matches.length > 0
      ? matches
      : [
          {
            protocol: "openapi",
            confidence: 0.4,
            reason: "No protocol keywords; default to scanning the host then OpenAPI",
            exampleConfig: { spec: host ? `http://${host}/openapi.json` : "./openapi.json" },
          },
        ];

  const steps: PlanStep[] = [];
  if (host) {
    steps.push({
      tool: "discovery_scan_host",
      arguments: { host },
      why: "Probe a single host (not a network range) for reachable protocols",
    });
    steps.push({
      tool: "mcp_add_from_discovery",
      arguments: { suggestion: "<discovery_scan_host.suggestions[0] — the object, not an index>" },
      why: "Register the highest-confidence suggestion (pass protocol+name+config)",
    });
  } else if (recommendations[0]) {
    const rec = recommendations[0];
    const hasSpec = typeof rec.exampleConfig.spec === "string" || typeof rec.exampleConfig.wsdl === "string";
    if (hasSpec && (rec.protocol === "openapi" || rec.protocol === "soap" || rec.protocol === "asyncapi")) {
      steps.push({
        tool: "schema_import",
        arguments: { source: rec.exampleConfig.spec ?? rec.exampleConfig.wsdl, register: true },
        why: "Import a local/remote spec and register it as business tools",
      });
    } else {
      steps.push({
        tool: "mcp_add",
        arguments: { protocol: rec.protocol, name: rec.protocol, config: rec.exampleConfig },
        why: rec.reason,
      });
    }
  }
  steps.push({
    tool: "mcp_health",
    arguments: { verbose: true },
    why: "Confirm the adapter is live and read any config-missing hints",
  });
  steps.push({
    tool: "mcp_explain_tool",
    arguments: { name: "<protocol.name.operation or a mcp_* management tool>" },
    why: "Inspect inputSchema before the first business call",
  });

  return {
    goal,
    host,
    recommendations,
    steps,
    notes: [
      `Known protocols: ${knownProtocols().join(", ")}`,
      "CIDR / range scans are never allowed (EVERYTHING2MCP_DISCOVERY_ALLOW_SCAN is ignored).",
      "Data-plane writes default allowWrite=false. Re-register with allowWrite=true only when you intend to mutate.",
      "MCP tools/list mixes layers: _meta.layer=management (mcp_*/discovery_*) vs business (protocol.name.op). Prefer mcp_list { layer: \"business\" }.",
    ],
  };
}

function extractHost(goal: string): string | undefined {
  const url = goal.match(/https?:\/\/([A-Za-z0-9.-]+)/i);
  if (url?.[1]) return url[1];
  const host = goal.match(/\bhost(?:name)?[:\s]+([A-Za-z0-9.-]+)/i);
  if (host?.[1]) return host[1];
  const ip = goal.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
  if (ip?.[1]) return ip[1];
  return undefined;
}
