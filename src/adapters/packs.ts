/**
 * Optional grouping of protocol ids. Adapter implementations stay in flat
 * `src/adapters/<protocol>/` directories; packs are a catalog overlay only.
 */
export const ADAPTER_PACKS = {
  http: ["openapi", "http", "graphql", "soap", "webdav", "caldav", "carddav"],
  rpc: ["grpc", "xmlrpc", "jsonrpc"],
  messaging: ["mqtt", "amqp", "kafka", "nats", "websocket", "ws", "asyncapi", "sparkplug", "sqs", "pulsar", "imap", "pop3", "rabbitmq"],
  industrial: ["opcua", "modbus", "coap", "fix", "bacnet", "ethernetip", "enip", "s7", "mtconnect", "snmp"],
  data: [
    "sqlite",
    "postgres",
    "mysql",
    "mariadb",
    "sqlserver",
    "duckdb",
    "sql",
    "mongodb",
    "redis",
    "elasticsearch",
    "opensearch",
    "clickhouse",
    "neo4j",
    "qdrant",
    "s3",
    "gcs",
    "oss",
    "influx",
    "influxdb",
    "prometheus",
    "smtp",
    "ldap",
    "ftp",
    "etcd",
    "consul",
    "azureblob",
    "sftp",
    "memcached",
    "tftp",
    "beanstalkd",
    "zookeeper",
    "dns",
    "cassandra",
    "couchdb",
    "whois",
    "solr",
    "kubernetes",
    "k8s",
    "vault",
    "openbao",
    "aws_iam",
    "alertmanager",
    "pubsub",
    "jira",
  ],
  collab: ["feishu", "lark", "dingtalk", "wecom", "slack", "notion", "github", "partner", "mcp_bridge"],
  platform: [
    "os_info",
    "platform_fs",
    "platform_process",
    "platform_service",
    "docker",
    "podman",
    "journal",
    "smb",
    "cifs",
    "nfs",
    "browser",
  ],
} as const;

export type AdapterPack = keyof typeof ADAPTER_PACKS;

export function packForProtocol(protocol: string): AdapterPack | undefined {
  const p = protocol.toLowerCase();
  for (const pack of Object.keys(ADAPTER_PACKS) as AdapterPack[]) {
    const ids: readonly string[] = ADAPTER_PACKS[pack];
    if (ids.includes(p)) return pack;
  }
  return undefined;
}

export function protocolsInPack(pack: AdapterPack): readonly string[] {
  return ADAPTER_PACKS[pack];
}
