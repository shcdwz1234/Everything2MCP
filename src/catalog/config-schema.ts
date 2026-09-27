import type { JsonObject } from "../runtime/types.js";
import { canonicalProtocol } from "./validate.js";
import { knownProtocols } from "../runtime/bootstrap.js";
import { inferIngress, type IngressKind } from "./ingress.js";
import { packForProtocol } from "../adapters/packs.js";

/**
 * Per-adapter config schema (JSON-Schema-ish). Drives:
 * - the console "add" wizard form generation (required first, optional collapsed,
 *   secret masked, advanced hidden behind 高级),
 * - discovery "需要配置" prompts (only the missing required/secret fields),
 * - REST GET /api/protocols and the /api/settings/matrix payload,
 * - a light validation pass reused by validate.ts for required-field checks.
 *
 * This is intentionally small and additive: it never loosens existing
 * validateProtocolConfig behavior, it only provides UI/metadata + a
 * complementary required-any check.
 */

export type ConfigFieldType = "string" | "number" | "boolean" | "object" | "array";

export interface ConfigField {
  /** config key */
  key: string;
  type: ConfigFieldType;
  /** short human label (zh where helpful) */
  label?: string;
  description?: string;
  /** required to register (see requiredAny for either/or groups) */
  required?: boolean;
  /** credential — UI masks it and audit/REST redacts it */
  secret?: boolean;
  /** hidden behind the 高级 area by default */
  advanced?: boolean;
  default?: unknown;
  /** enum choices for pickers */
  enum?: Array<string | number>;
  placeholder?: string;
  /** member of an either/or required group (any one satisfies) */
  oneOf?: string[];
  /** for array/object typed helper text */
  itemsType?: ConfigFieldType;
}

export interface ConfigSchema {
  protocol: string;
  /** display title, e.g. "OpenAPI / REST" */
  title: string;
  /** southbound ingress bucket */
  ingress: IngressKind;
  /** catalog pack (http/data/messaging/...) for grouping cards */
  pack?: string;
  summary: string;
  fields: ConfigField[];
  /**
   * Either/or required groups: at least one key from each inner array must be
   * present. Mirrors validateProtocolConfig ("url | simulator:true", etc).
   */
  requiredAny?: string[][];
  /** true when {} is a valid config (simulator / all-optional adapters) */
  emptyOk: boolean;
  /** does this adapter open network targets (for blacklist/discovery)? */
  networked: boolean;
}

const ALLOW_WRITE: ConfigField = {
  key: "allowWrite",
  type: "boolean",
  label: "允许写操作 allowWrite",
  description: "默认 false。写路径必须显式打开；控制台不会替你打开。",
  default: false,
  advanced: false,
};

const SIMULATOR: ConfigField = {
  key: "simulator",
  type: "boolean",
  label: "模拟器 simulator",
  description: "无真实后端时用内存模拟器。",
  default: false,
  advanced: true,
};

const TIMEOUT: ConfigField = {
  key: "timeoutMs",
  type: "number",
  label: "超时 timeoutMs",
  advanced: true,
};

const HOST = (_port?: number): ConfigField => ({
  key: "host",
  type: "string",
  label: "主机 host",
  placeholder: "127.0.0.1",
});

const PORT = (def?: number): ConfigField => ({
  key: "port",
  type: "number",
  label: "端口 port",
  default: def,
  advanced: false,
});

const PASSWORD: ConfigField = { key: "password", type: "string", label: "密码 password", secret: true };
const URL_FIELD = (label = "URL", ph = ""): ConfigField => ({
  key: "url",
  type: "string",
  label,
  placeholder: ph,
});

/** Rich schemas for the common adapters. */
const RICH: Record<string, Omit<ConfigSchema, "protocol" | "ingress" | "pack" | "emptyOk" | "networked">> = {
  openapi: {
    title: "OpenAPI / REST",
    summary: "从 OpenAPI/Swagger spec 生成 REST 工具。",
    fields: [
      { key: "spec", type: "string", label: "Spec 文件或 URL", placeholder: "http://host/openapi.json 或 ./spec.json" },
      { key: "baseUrl", type: "string", label: "Base URL", description: "spec 里没有绝对 servers[] 时填写。" },
      { key: "auth", type: "object", label: "鉴权 auth", description: "{ type: bearer|apiKey|basic, token?/apiKey?/username?/password? }", advanced: true },
      { key: "headers", type: "object", label: "额外 headers", advanced: true },
      TIMEOUT,
      ALLOW_WRITE,
    ],
    requiredAny: [["spec", "specUrl", "specPath"]],
  },
  soap: {
    title: "SOAP / WSDL",
    summary: "从 WSDL 生成 SOAP 工具。",
    fields: [
      { key: "wsdl", type: "string", label: "WSDL 文件或 URL" },
      { key: "endpoint", type: "string", label: "Endpoint 覆盖", advanced: true },
      { key: "soapVersion", type: "string", label: "SOAP 版本", enum: ["1.1", "1.2"], advanced: true },
      ALLOW_WRITE,
    ],
    requiredAny: [["wsdl", "wsdlUrl"]],
  },
  graphql: {
    title: "GraphQL",
    summary: "GraphQL query/mutation，subscribe_once 走 graphql-ws。",
    fields: [
      URL_FIELD("HTTP endpoint", "http://host/graphql"),
      { key: "wsUrl", type: "string", label: "WS endpoint (subscription)", advanced: true },
      { key: "sdl", type: "string", label: "SDL 文件/内联", advanced: true },
      SIMULATOR,
      { key: "auth", type: "object", label: "鉴权 auth", advanced: true },
      ALLOW_WRITE,
    ],
    requiredAny: [["url", "endpoint", "wsUrl", "simulator"]],
  },
  grpc: {
    title: "gRPC",
    summary: "unary/stream/bidi。proto 或 server reflection。",
    fields: [
      { key: "target", type: "string", label: "目标 host:port", placeholder: "127.0.0.1:50051" },
      { key: "proto", type: "string", label: "proto 文件", description: "或用 reflection:true / protoInline。" },
      { key: "protoInline", type: "string", label: "proto 内联", advanced: true },
      { key: "reflection", type: "boolean", label: "Server reflection", default: false },
      { key: "tls", type: "boolean", label: "TLS", advanced: true },
      { key: "ca", type: "string", label: "CA PEM/路径", advanced: true },
      { key: "cert", type: "string", label: "客户端证书", advanced: true },
      { key: "key", type: "string", label: "客户端私钥", secret: true, advanced: true },
      { key: "tlsWatch", type: "boolean", label: "PEM 热重载", advanced: true },
      ALLOW_WRITE,
    ],
    requiredAny: [["target"], ["proto", "protoInline", "protoPath", "reflection"]],
  },
  mqtt: {
    title: "MQTT",
    summary: "MQTT 3/5 publish/subscribe。",
    fields: [
      URL_FIELD("Broker URL", "mqtt://host:1883"),
      { key: "username", type: "string", label: "用户名", advanced: false },
      PASSWORD,
      { key: "clientId", type: "string", label: "Client ID", advanced: true },
      { key: "topics", type: "array", label: "预订阅 topics", itemsType: "string", advanced: true },
      ALLOW_WRITE,
    ],
    requiredAny: [["url", "brokerUrl"]],
  },
  redis: {
    title: "Redis",
    summary: "Redis string/hash/list/stream/pubsub。",
    fields: [
      URL_FIELD("连接 URL", "redis://host:6379"),
      PASSWORD,
      ALLOW_WRITE,
    ],
    requiredAny: [["url", "endpoint"]],
  },
  postgres: {
    title: "PostgreSQL",
    summary: "只读 SQL；native:true 走可选 pg 驱动。",
    fields: [
      URL_FIELD("连接 URL", "postgres://user:pass@host:5432/db"),
      SIMULATOR,
      { key: "native", type: "boolean", label: "native 驱动 (pg)", advanced: true },
      { key: "poolMax", type: "number", label: "连接池上限", advanced: true },
      { key: "ssl", type: "boolean", label: "SSL", advanced: true },
      { key: "statementTimeoutMs", type: "number", label: "语句超时", advanced: true },
      ALLOW_WRITE,
    ],
  },
  mysql: {
    title: "MySQL / MariaDB",
    summary: "只读 SQL；native:true 走可选 mysql2。",
    fields: [
      URL_FIELD("连接 URL", "mysql://user:pass@host:3306/db"),
      SIMULATOR,
      { key: "native", type: "boolean", label: "native 驱动 (mysql2)", advanced: true },
      { key: "poolMax", type: "number", label: "连接池上限", advanced: true },
      ALLOW_WRITE,
    ],
  },
  sqlite: {
    title: "SQLite",
    summary: "本地文件或 :memory:。native:true 走可选 better-sqlite3。",
    fields: [
      { key: "filename", type: "string", label: "文件路径", placeholder: ":memory: 或 ./data.db" },
      { key: "native", type: "boolean", label: "native 驱动", advanced: true },
      ALLOW_WRITE,
    ],
  },
  sql: {
    title: "SQL 门面",
    summary: "driver 选择 sqlite/postgres/mysql/sqlserver/duckdb。建议直接用具体协议。",
    fields: [
      { key: "driver", type: "string", label: "driver", enum: ["sqlite", "postgres", "mysql", "sqlserver", "duckdb"] },
      { key: "filename", type: "string", label: "文件 (sqlite/duckdb)" },
      URL_FIELD("连接 URL", ""),
      SIMULATOR,
      ALLOW_WRITE,
    ],
    requiredAny: [["driver", "filename", "database", "path", "url", "dsn", "simulator"]],
  },
  kafka: {
    title: "Kafka",
    summary: "produce/consume_once/group_status。无真事务/EOS。",
    fields: [
      { key: "brokers", type: "array", label: "brokers", itemsType: "string", placeholder: "127.0.0.1:9092" },
      { key: "topic", type: "string", label: "默认 topic" },
      { key: "groupId", type: "string", label: "消费组", advanced: true },
      { key: "idempotent", type: "boolean", label: "idempotent", advanced: true },
      ALLOW_WRITE,
    ],
    requiredAny: [["brokers"]],
  },
  amqp: {
    title: "AMQP 0-9-1",
    summary: "get/ack/nack + publish/rpc（写闸）。",
    fields: [
      URL_FIELD("连接 URL", "amqp://host:5672"),
      { key: "queue", type: "string", label: "默认队列" },
      SIMULATOR,
      ALLOW_WRITE,
    ],
    requiredAny: [["url", "simulator"]],
  },
  websocket: {
    title: "WebSocket",
    summary: "原始 WebSocket 发送/接收。",
    fields: [
      URL_FIELD("WS URL", "ws:// 或 wss://"),
      { key: "protocols", type: "array", label: "子协议", itemsType: "string", advanced: true },
      { key: "headers", type: "object", label: "headers", advanced: true },
      ALLOW_WRITE,
    ],
    requiredAny: [["url"]],
  },
  modbus: {
    title: "Modbus",
    summary: "TCP/RTU 读写线圈与寄存器。",
    fields: [
      HOST(502),
      PORT(502),
      { key: "mode", type: "string", label: "模式", enum: ["tcp", "rtu"], default: "tcp" },
      { key: "unitId", type: "number", label: "Unit ID", advanced: true },
      SIMULATOR,
      ALLOW_WRITE,
    ],
    requiredAny: [["host", "url"]],
  },
  opcua: {
    title: "OPC-UA",
    summary: "read/browse + monitored item。",
    fields: [
      { key: "endpoint", type: "string", label: "Endpoint", placeholder: "opc.tcp://host:4840" },
      SIMULATOR,
      ALLOW_WRITE,
    ],
    requiredAny: [["endpoint", "url"]],
  },
  s3: {
    title: "S3 / MinIO",
    summary: "list/get/put/delete。SigV4 或 unsigned。",
    fields: [
      { key: "bucket", type: "string", label: "Bucket" },
      { key: "endpoint", type: "string", label: "Endpoint", placeholder: "https://s3.amazonaws.com 或 http://minio:9000" },
      { key: "region", type: "string", label: "Region", advanced: true },
      { key: "accessKey", type: "string", label: "Access Key", advanced: false },
      { key: "secretKey", type: "string", label: "Secret Key", secret: true },
      { key: "unsigned", type: "boolean", label: "unsigned (无签名)", advanced: true },
      SIMULATOR,
      ALLOW_WRITE,
    ],
    requiredAny: [["bucket", "bucketName"]],
  },
  mcp_bridge: {
    title: "MCP Server 桥接 (兜底)",
    summary: "导入 mcpServers JSON 作为兜底。live spawn 仍 E_UNSUPPORTED。",
    fields: [
      { key: "path", type: "string", label: "mcp.json 路径" },
      { key: "mcpServers", type: "object", label: "mcpServers 内联" },
      SIMULATOR,
    ],
    requiredAny: [["mcpServers", "servers", "path", "file"]],
  },
  jsonrpc: {
    title: "JSON-RPC",
    summary: "JSON-RPC 2.0 over HTTP。",
    fields: [URL_FIELD("Endpoint URL", "http://host/rpc"), ALLOW_WRITE],
    requiredAny: [["url", "endpoint"]],
  },
  xmlrpc: {
    title: "XML-RPC",
    summary: "XML-RPC over HTTP。",
    fields: [URL_FIELD("Endpoint URL", "http://host/RPC2"), ALLOW_WRITE],
    requiredAny: [["url", "endpoint"]],
  },
};

/**
 * requiredAny for protocols without a rich schema. Mirrors the
 * validateProtocolConfig switch in validate.ts (parity is tested).
 */
const GENERIC_REQUIRED: Record<string, string[][]> = {
  asyncapi: [["spec", "asyncapi"]],
  sparkplug: [["url", "brokerUrl"]],
  ldap: [["url", "endpoint"]],
  coap: [["host", "url"]],
  smtp: [["host", "url"]],
  nats: [["url", "server", "servers", "simulator"]],
  mtconnect: [["url", "baseUrl", "fixture", "probeFixture", "xml", "probeXml"]],
  gcs: [["bucket", "bucketName"]],
  oss: [["bucket", "bucketName"]],
  influx: [["bucket", "bucketName"]],
  azureblob: [["container", "bucket", "bucketName"]],
  prometheus: [["url", "baseUrl", "simulator"]],
  sqs: [["queue", "queueUrl", "queueName"]],
  pulsar: [["topic", "defaultTopic"]],
  partner: [["operations", "manifest", "capability_id"]],
};

/** Field templates keyed by the "type" family for the generic fallback. */
function genericFields(_protocol: string): ConfigField[] {
  const fields: ConfigField[] = [];
  // Networked host/port style adapters get host/port; url-style get url.
  fields.push(URL_FIELD("URL / endpoint", ""));
  fields.push({ key: "host", type: "string", label: "主机 host", advanced: true });
  fields.push({ key: "port", type: "number", label: "端口 port", advanced: true });
  fields.push({ key: "user", type: "string", label: "用户名 user", advanced: true });
  fields.push({ key: "password", type: "string", label: "密码 password", secret: true, advanced: true });
  fields.push({ key: "token", type: "string", label: "令牌 token", secret: true, advanced: true });
  fields.push(SIMULATOR);
  fields.push(ALLOW_WRITE);
  return fields;
}

const NON_NETWORKED = new Set([
  "sqlite",
  "duckdb",
  "os_info",
  "platform_fs",
  "platform_process",
  "platform_service",
  "journal",
  "aws_iam",
  "browser",
  "fix",
  "mtconnect",
]);

const EMPTY_OK_PROTOCOLS = new Set([
  "fix",
  "bacnet",
  "ethernetip",
  "s7",
  "sqlite",
  "postgres",
  "mysql",
  "sqlserver",
  "duckdb",
  "mongodb",
  "elasticsearch",
  "opensearch",
  "clickhouse",
  "neo4j",
  "qdrant",
  "snmp",
  "webdav",
  "ftp",
  "etcd",
  "imap",
  "pop3",
  "consul",
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
  "os_info",
  "platform_fs",
  "platform_process",
  "platform_service",
  "docker",
  "podman",
  "journal",
  "smb",
  "nfs",
  "vault",
  "aws_iam",
  "alertmanager",
  "pubsub",
  "jira",
  "browser",
  "feishu",
  "dingtalk",
  "wecom",
  "slack",
  "notion",
  "github",
]);

const cache = new Map<string, ConfigSchema>();

/** Build (and cache) the config schema for one protocol id (canonicalized). */
export function configSchemaFor(protocol: string): ConfigSchema {
  const canon = canonicalProtocol(protocol);
  const cached = cache.get(canon);
  if (cached) return cached;
  const rich = RICH[canon] ?? RICH[protocol.toLowerCase()];
  const ingress = inferIngress(canon);
  const pack = packForProtocol(canon);
  const emptyOk = EMPTY_OK_PROTOCOLS.has(canon);
  const networked = !NON_NETWORKED.has(canon);
  let schema: ConfigSchema;
  if (rich) {
    schema = {
      protocol: canon,
      ingress,
      pack,
      emptyOk: emptyOk || (rich.requiredAny ? rich.requiredAny.some((g) => g.includes("simulator")) : false),
      networked,
      ...rich,
    };
  } else {
    const requiredAny = GENERIC_REQUIRED[canon];
    const fields = genericFields(canon);
    for (const group of requiredAny ?? []) {
      const k = group[0]!;
      if (!fields.some((f) => f.key === k)) {
        fields.unshift({ key: k, type: k === "servers" || k === "operations" ? "array" : "string", label: k });
      } else {
        const f = fields.find((x) => x.key === k)!;
        f.advanced = false;
      }
    }
    schema = {
      protocol: canon,
      title: titleFor(canon),
      ingress,
      pack,
      summary: helpSummary(canon),
      fields,
      requiredAny,
      emptyOk,
      networked,
    };
  }
  schema = markRequired(schema);
  cache.set(canon, schema);
  return schema;
}

/** Derive per-field required/oneOf hints from requiredAny groups. */
function markRequired(schema: ConfigSchema): ConfigSchema {
  const fields = schema.fields.map((f) => ({ ...f }));
  const keys = new Set(fields.map((f) => f.key));
  for (const group of schema.requiredAny ?? []) {
    // Keys absent from the form are legacy aliases (bucketName, specUrl...).
    const visible = group.filter((k) => keys.has(k));
    for (const f of fields) {
      if (!visible.includes(f.key)) continue;
      if (visible.length === 1) f.required = true;
      else f.oneOf = visible;
      f.advanced = false;
    }
  }
  return { ...schema, fields };
}

function titleFor(protocol: string): string {
  return protocol
    .split(/[_-]/)
    .map((s) => (s ? s[0]!.toUpperCase() + s.slice(1) : s))
    .join(" ");
}

function helpSummary(protocol: string): string {
  return `${protocol} 适配器（通用表单；参见 mcp_add / PROTOCOLS.md 的具体键）。`;
}

/** All schemas, one per canonical protocol id (deduped across aliases). */
export function allConfigSchemas(): ConfigSchema[] {
  const seen = new Set<string>();
  const out: ConfigSchema[] = [];
  for (const p of knownProtocols()) {
    const canon = canonicalProtocol(p);
    if (seen.has(canon)) continue;
    seen.add(canon);
    out.push(configSchemaFor(canon));
  }
  out.sort((a, b) => a.protocol.localeCompare(b.protocol));
  return out;
}

/**
 * Complementary "at least one of each requiredAny group" check. Additive to
 * validateProtocolConfig — it only fires for the rich schemas that declare
 * requiredAny, and it mirrors what those adapters already require.
 */
export function checkRequiredBySchema(protocol: string, config: JsonObject): string | undefined {
  const schema = configSchemaFor(protocol);
  if (!schema.requiredAny) return undefined;
  for (const group of schema.requiredAny) {
    const ok = group.some((key) => present(config[key]));
    if (!ok) {
      return `${schema.protocol} requires one of: ${group.join(" | ")}`;
    }
  }
  return undefined;
}

/** Which required/secret fields are still missing (drives 需要配置 prompts). */
export function missingRequiredFields(protocol: string, config: JsonObject): ConfigField[] {
  const schema = configSchemaFor(protocol);
  const missing: ConfigField[] = [];
  for (const group of schema.requiredAny ?? []) {
    if (!group.some((key) => present(config[key]))) {
      const first = schema.fields.find((f) => group.includes(f.key) && f.key !== "simulator");
      if (first && !missing.includes(first)) missing.push(first);
    }
  }
  return missing;
}

/**
 * Secret fields that are declared by the schema but empty in the config.
 * Used by discovery: a candidate that answered with an auth challenge (or a
 * protocol that is normally authenticated) is shown as 需要配置 and the UI
 * prompts for exactly these + missingRequiredFields.
 */
export function missingSecretFields(protocol: string, config: JsonObject): ConfigField[] {
  const schema = configSchemaFor(protocol);
  return schema.fields.filter((f) => f.secret && !f.advanced && !present(config[f.key]));
}

function present(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && value !== false;
}
