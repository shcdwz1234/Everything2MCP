import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import protobuf from "protobufjs";

/** Eclipse Tahu `sparkplug_b.proto` — Sparkplug B official Google protobuf schema (proto2). */
export const SPARKPLUG_PROTO_PACKAGE = "org.eclipse.tahu.protobuf";
export const SPARKPLUG_PROTO_SOURCE =
  "Eclipse Tahu sparkplug_b.proto (https://github.com/eclipse/tahu/blob/master/sparkplug_b/sparkplug_b.proto); Sparkplug Specification 3.0 §6.4";
export const SPARKPLUG_NAMESPACE = "spBv1.0";
export const SPARKPLUG_MESSAGE_TYPES = [
  "NBIRTH",
  "NDEATH",
  "NDATA",
  "DBIRTH",
  "DDEATH",
  "DDATA",
  "NCMD",
  "DCMD",
  "STATE",
] as const;

export type SparkplugMessageType = (typeof SPARKPLUG_MESSAGE_TYPES)[number];
export type SparkplugEncoding = "protobuf" | "json-compat";

export const SPARKPLUG_DATA_TYPE: Record<string, number> = {
  Unknown: 0,
  Int8: 1,
  Int16: 2,
  Int32: 3,
  Int64: 4,
  UInt8: 5,
  UInt16: 6,
  UInt32: 7,
  UInt64: 8,
  Float: 9,
  Double: 10,
  Boolean: 11,
  String: 12,
  DateTime: 13,
  Text: 14,
  UUID: 15,
  DataSet: 16,
  Bytes: 17,
  File: 18,
  Template: 19,
  PropertySet: 20,
  PropertySetList: 21,
  Int8Array: 22,
  Int16Array: 23,
  Int32Array: 24,
  Int64Array: 25,
  UInt8Array: 26,
  UInt16Array: 27,
  UInt32Array: 28,
  UInt64Array: 29,
  FloatArray: 30,
  DoubleArray: 31,
  BooleanArray: 32,
  StringArray: 33,
  DateTimeArray: 34,
};

const DATA_TYPE_NAME = Object.fromEntries(
  Object.entries(SPARKPLUG_DATA_TYPE).map(([k, v]) => [v, k]),
) as Record<number, string>;

export interface SparkplugDataSet {
  columns: string[];
  types: Array<string | number>;
  rows: unknown[][];
}

export interface SparkplugTemplateParameter {
  name: string;
  type?: string | number;
  value?: unknown;
}

export interface SparkplugTemplate {
  version?: string;
  templateRef?: string;
  isDefinition?: boolean;
  metrics?: SparkplugMetric[];
  parameters?: SparkplugTemplateParameter[];
}

/** Flat property map, or `{ keys, values }` proto shape. One nested PropertySet / PropertySetList level. */
export type SparkplugPropertySet =
  | Record<string, unknown>
  | { keys: string[]; values: Array<{ type?: string | number; value?: unknown }> };

export interface SparkplugMetric {
  name: string;
  timestamp?: number;
  dataType?: string;
  datatype?: number;
  alias?: number;
  isNull?: boolean;
  value: unknown;
  properties?: SparkplugPropertySet;
}

export interface SparkplugPayloadView {
  timestamp: number;
  seq: number;
  uuid?: string;
  metrics: SparkplugMetric[];
  encoding: SparkplugEncoding;
}

export interface SparkplugTopic {
  namespace: string;
  groupId: string;
  messageType: string;
  edgeNode: string;
  deviceId?: string;
  hostId?: string;
  kind: "node" | "device" | "state" | "unknown";
}

let payloadType: protobuf.Type | undefined;

function loadPayloadType(): protobuf.Type {
  if (payloadType) return payloadType;
  const protoPath = join(dirname(fileURLToPath(import.meta.url)), "sparkplug_b.proto");
  const src = readFileSync(protoPath, "utf8");
  const parsed = protobuf.parse(src, { keepCase: false });
  const found = parsed.root.lookupType(`${SPARKPLUG_PROTO_PACKAGE}.Payload`);
  payloadType = found;
  return found;
}

export function dataTypeId(nameOrId: string | number | undefined, value?: unknown): number {
  if (typeof nameOrId === "number" && Number.isFinite(nameOrId)) return nameOrId;
  if (typeof nameOrId === "string" && nameOrId.trim()) {
    const key = nameOrId.trim();
    if (key in SPARKPLUG_DATA_TYPE) return SPARKPLUG_DATA_TYPE[key]!;
    const upper = key.charAt(0).toUpperCase() + key.slice(1);
    if (upper in SPARKPLUG_DATA_TYPE) return SPARKPLUG_DATA_TYPE[upper]!;
    const compact = key.replace(/[^A-Za-z0-9]/g, "");
    const hit = Object.keys(SPARKPLUG_DATA_TYPE).find((k) => k.toLowerCase() === compact.toLowerCase());
    if (hit) return SPARKPLUG_DATA_TYPE[hit]!;
  }
  if (typeof value === "boolean") return SPARKPLUG_DATA_TYPE.Boolean!;
  if (typeof value === "number" && Number.isInteger(value)) return SPARKPLUG_DATA_TYPE.Int32!;
  if (typeof value === "number") return SPARKPLUG_DATA_TYPE.Double!;
  return SPARKPLUG_DATA_TYPE.String!;
}

export function dataTypeName(id: number | undefined): string {
  if (id === undefined) return "Unknown";
  return DATA_TYPE_NAME[id] ?? `Unknown(${id})`;
}

function asNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) return Number(value);
  if (value && typeof value === "object" && "toNumber" in value && typeof (value as { toNumber: () => number }).toNumber === "function") {
    return (value as { toNumber: () => number }).toNumber();
  }
  return Number(value);
}

function encodeScalar(datatype: number, value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  switch (datatype) {
    case SPARKPLUG_DATA_TYPE.Int8:
    case SPARKPLUG_DATA_TYPE.Int16:
    case SPARKPLUG_DATA_TYPE.Int32:
    case SPARKPLUG_DATA_TYPE.UInt8:
    case SPARKPLUG_DATA_TYPE.UInt16:
    case SPARKPLUG_DATA_TYPE.UInt32:
      return { intValue: asNumber(value) >>> 0 };
    case SPARKPLUG_DATA_TYPE.Int64:
    case SPARKPLUG_DATA_TYPE.UInt64:
    case SPARKPLUG_DATA_TYPE.DateTime:
      return { longValue: asNumber(value) };
    case SPARKPLUG_DATA_TYPE.Float:
      return { floatValue: asNumber(value) };
    case SPARKPLUG_DATA_TYPE.Double:
      return { doubleValue: asNumber(value) };
    case SPARKPLUG_DATA_TYPE.Boolean:
      return { booleanValue: Boolean(value) };
    case SPARKPLUG_DATA_TYPE.Bytes:
    case SPARKPLUG_DATA_TYPE.File:
      return { bytesValue: value instanceof Uint8Array ? value : Buffer.from(String(value), "base64") };
    default:
      return { stringValue: String(value) };
  }
}

function decodeScalar(rec: Record<string, unknown>, datatype?: number): unknown {
  if (rec.intValue !== undefined) {
    const n = asNumber(rec.intValue);
    if (
      datatype === SPARKPLUG_DATA_TYPE.Int8 ||
      datatype === SPARKPLUG_DATA_TYPE.Int16 ||
      datatype === SPARKPLUG_DATA_TYPE.Int32
    ) {
      return n | 0;
    }
    return n >>> 0;
  }
  if (rec.longValue !== undefined) return asNumber(rec.longValue);
  if (rec.floatValue !== undefined) return asNumber(rec.floatValue);
  if (rec.doubleValue !== undefined) return asNumber(rec.doubleValue);
  if (rec.booleanValue !== undefined) return Boolean(rec.booleanValue);
  if (rec.stringValue !== undefined) return String(rec.stringValue);
  if (rec.bytesValue !== undefined) {
    const raw = rec.bytesValue;
    if (Buffer.isBuffer(raw)) return raw.toString("base64");
    if (raw instanceof Uint8Array) return Buffer.from(raw).toString("base64");
    return raw;
  }
  return undefined;
}

function asDataSet(value: unknown): SparkplugDataSet | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  if (!Array.isArray(rec.columns) && !Array.isArray(rec.rows)) return undefined;
  return {
    columns: Array.isArray(rec.columns) ? rec.columns.map((c) => String(c)) : [],
    types: Array.isArray(rec.types) ? (rec.types as Array<string | number>) : [],
    rows: Array.isArray(rec.rows) ? (rec.rows as unknown[][]) : [],
  };
}

function asTemplate(value: unknown): SparkplugTemplate | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  if (
    rec.templateRef === undefined &&
    rec.isDefinition === undefined &&
    rec.version === undefined &&
    !Array.isArray(rec.metrics) &&
    !Array.isArray(rec.parameters)
  ) {
    return undefined;
  }
  return {
    version: typeof rec.version === "string" ? rec.version : undefined,
    templateRef: typeof rec.templateRef === "string" ? rec.templateRef : typeof rec.template_ref === "string" ? rec.template_ref : undefined,
    isDefinition: rec.isDefinition === true || rec.is_definition === true,
    metrics: Array.isArray(rec.metrics) ? (rec.metrics as SparkplugMetric[]) : undefined,
    parameters: Array.isArray(rec.parameters) ? (rec.parameters as SparkplugTemplateParameter[]) : undefined,
  };
}

function encodePropertySet(value: SparkplugPropertySet): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value) && Array.isArray((value as { keys?: unknown }).keys)) {
    const shaped = value as { keys: string[]; values: Array<{ type?: string | number; value?: unknown }> };
    return {
      keys: shaped.keys.map(String),
      values: (shaped.values ?? []).map((v) => encodePropertyValue(v?.type, v?.value)),
    };
  }
  const entries = Object.entries(value ?? {});
  return {
    keys: entries.map(([k]) => k),
    values: entries.map(([, v]) => {
      if (v && typeof v === "object" && !Array.isArray(v) && "value" in (v as object)) {
        const rec = v as { type?: string | number; value?: unknown };
        return encodePropertyValue(rec.type, rec.value);
      }
      return encodePropertyValue(undefined, v);
    }),
  };
}

function encodePropertyValue(typeHint: string | number | undefined, value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) {
    return { type: dataTypeId(typeHint, value), isNull: true };
  }
  if (Array.isArray(value) && value.every((item) => item && typeof item === "object")) {
    return {
      type: SPARKPLUG_DATA_TYPE.PropertySetList,
      propertysetsValue: {
        propertyset: value.map((item) => encodePropertySet(item as SparkplugPropertySet)),
      },
    };
  }
  if (value && typeof value === "object" && !Array.isArray(value) && dataTypeId(typeHint) === SPARKPLUG_DATA_TYPE.PropertySet) {
    return { type: SPARKPLUG_DATA_TYPE.PropertySet, propertysetValue: encodePropertySet(value as SparkplugPropertySet) };
  }
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Array.isArray((value as { keys?: unknown }).keys) || dataTypeId(typeHint) === SPARKPLUG_DATA_TYPE.PropertySet)
  ) {
    return { type: SPARKPLUG_DATA_TYPE.PropertySet, propertysetValue: encodePropertySet(value as SparkplugPropertySet) };
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { type: SPARKPLUG_DATA_TYPE.PropertySet, propertysetValue: encodePropertySet(value as SparkplugPropertySet) };
  }
  const datatype = dataTypeId(typeHint, value);
  return { type: datatype, ...encodeScalar(datatype, value) };
}

function decodePropertySet(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const rec = raw as Record<string, unknown>;
  const keys = Array.isArray(rec.keys) ? rec.keys.map((k) => String(k)) : [];
  const values = Array.isArray(rec.values) ? rec.values : [];
  const out: Record<string, unknown> = {};
  keys.forEach((key, i) => {
    const item = (values[i] ?? {}) as Record<string, unknown>;
    const type = typeof item.type === "number" ? item.type : undefined;
    if (item.isNull) {
      out[key] = { type: dataTypeName(type), value: null };
      return;
    }
    if (item.propertysetValue) {
      out[key] = { type: "PropertySet", value: decodePropertySet(item.propertysetValue) };
      return;
    }
    if (item.propertysetsValue && typeof item.propertysetsValue === "object") {
      const list = (item.propertysetsValue as { propertyset?: unknown }).propertyset;
      out[key] = {
        type: "PropertySetList",
        value: Array.isArray(list) ? list.map((p) => decodePropertySet(p) ?? {}) : [],
      };
      return;
    }
    out[key] = { type: dataTypeName(type), value: decodeScalar(item, type) };
  });
  return out;
}

function encodeDataSet(ds: SparkplugDataSet): Record<string, unknown> {
  const types = ds.columns.map((_, i) => dataTypeId(ds.types[i], ds.rows[0]?.[i]));
  return {
    numOfColumns: ds.columns.length,
    columns: ds.columns,
    types,
    rows: ds.rows.map((row) => ({
      elements: ds.columns.map((_, i) => encodeScalar(types[i] ?? 12, row[i])),
    })),
  };
}

function decodeDataSet(raw: unknown): SparkplugDataSet {
  const rec = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const columns = Array.isArray(rec.columns) ? rec.columns.map((c) => String(c)) : [];
  const types = Array.isArray(rec.types) ? rec.types.map((t) => asNumber(t)) : [];
  const rowsIn = Array.isArray(rec.rows) ? rec.rows : [];
  const rows = rowsIn.map((row) => {
    const elements = row && typeof row === "object" && Array.isArray((row as { elements?: unknown }).elements)
      ? ((row as { elements: Array<Record<string, unknown>> }).elements)
      : Array.isArray(row)
        ? (row as Array<Record<string, unknown>>)
        : [];
    return elements.map((el, i) => decodeScalar(el ?? {}, types[i]));
  });
  return { columns, types: types.map((t) => dataTypeName(t)), rows };
}

function encodeTemplate(tpl: SparkplugTemplate, timestamp: number): Record<string, unknown> {
  return {
    version: tpl.version,
    templateRef: tpl.templateRef,
    isDefinition: Boolean(tpl.isDefinition),
    metrics: (tpl.metrics ?? []).map((m) => encodeMetric(m, timestamp)),
    parameters: (tpl.parameters ?? []).map((p) => {
      const type = dataTypeId(p.type, p.value);
      return { name: p.name, type, ...encodeScalar(type, p.value) };
    }),
  };
}

function decodeTemplate(raw: unknown): SparkplugTemplate {
  const rec = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const metricsIn = Array.isArray(rec.metrics) ? rec.metrics : [];
  const paramsIn = Array.isArray(rec.parameters) ? rec.parameters : [];
  return {
    version: typeof rec.version === "string" ? rec.version : undefined,
    templateRef: typeof rec.templateRef === "string" ? rec.templateRef : undefined,
    isDefinition: Boolean(rec.isDefinition),
    metrics: metricsIn.map((m) => decodeMetric(m as Record<string, unknown>)),
    parameters: paramsIn.map((p) => {
      const recP = p as Record<string, unknown>;
      const type = typeof recP.type === "number" ? recP.type : undefined;
      return { name: typeof recP.name === "string" ? recP.name : "", type: dataTypeName(type), value: decodeScalar(recP, type) };
    }),
  };
}

function encodeMetric(m: SparkplugMetric, timestamp: number): Record<string, unknown> {
  const datatype = dataTypeId(m.dataType ?? m.datatype, m.value);
  const obj: Record<string, unknown> = {
    name: m.name,
    timestamp: m.timestamp ?? timestamp,
    datatype,
    alias: m.alias,
    ...encodeMetricValue(datatype, m.value),
  };
  if (m.properties) obj.properties = encodePropertySet(m.properties);
  return obj;
}

function decodeMetric(rec: Record<string, unknown>): SparkplugMetric {
  const datatype = typeof rec.datatype === "number" ? rec.datatype : undefined;
  const metric: SparkplugMetric = {
    name: typeof rec.name === "string" ? rec.name : "",
    timestamp: rec.timestamp !== undefined ? asNumber(rec.timestamp) : undefined,
    dataType: dataTypeName(datatype),
    datatype,
    alias: rec.alias !== undefined ? asNumber(rec.alias) : undefined,
    isNull: Boolean(rec.isNull),
    value: decodeMetricValue(rec),
  };
  if (rec.properties) metric.properties = decodePropertySet(rec.properties);
  return metric;
}

function encodeMetricValue(datatype: number, value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return { isNull: true };
  if (datatype === SPARKPLUG_DATA_TYPE.DataSet || asDataSet(value)) {
    const ds = asDataSet(value);
    if (ds) return { datasetValue: encodeDataSet(ds) };
  }
  if (datatype === SPARKPLUG_DATA_TYPE.Template || asTemplate(value)) {
    const tpl = asTemplate(value);
    if (tpl) return { templateValue: encodeTemplate(tpl, Date.now()) };
  }
  if (datatype === SPARKPLUG_DATA_TYPE.PropertySet) {
    return { /* property sets as metric value live on properties; still accept map */ stringValue: JSON.stringify(value) };
  }
  return encodeScalar(datatype, value);
}

function decodeMetricValue(metric: Record<string, unknown>): unknown {
  if (metric.isNull) return null;
  if (metric.datasetValue) return decodeDataSet(metric.datasetValue);
  if (metric.templateValue) return decodeTemplate(metric.templateValue);
  return decodeScalar(metric, typeof metric.datatype === "number" ? metric.datatype : undefined);
}

export function encodeSparkplugPayload(input: {
  timestamp?: number;
  seq?: number;
  uuid?: string;
  metrics?: SparkplugMetric[];
  body?: Uint8Array | string;
}): Buffer {
  const Payload = loadPayloadType();
  const timestamp = input.timestamp ?? Date.now();
  const metrics = (input.metrics ?? []).map((m) => encodeMetric(m, timestamp));
  const obj: Record<string, unknown> = {
    timestamp,
    seq: input.seq ?? 0,
    metrics,
  };
  if (input.uuid) obj.uuid = input.uuid;
  if (input.body) {
    obj.body = typeof input.body === "string" ? Buffer.from(input.body, "utf8") : input.body;
  }
  const err = Payload.verify(obj);
  if (err) throw new Error(`Sparkplug Payload verify failed: ${err}`);
  return Buffer.from(Payload.encode(Payload.fromObject(obj)).finish());
}

export function decodeSparkplugPayload(buf: Buffer | Uint8Array): SparkplugPayloadView {
  const Payload = loadPayloadType();
  const decoded = Payload.toObject(Payload.decode(buf), {
    longs: Number,
    enums: Number,
    bytes: Buffer,
    defaults: false,
  }) as Record<string, unknown>;
  const metricsIn = Array.isArray(decoded.metrics) ? decoded.metrics : [];
  const metrics: SparkplugMetric[] = metricsIn.map((raw) => decodeMetric(raw as Record<string, unknown>));
  return {
    timestamp: decoded.timestamp !== undefined ? asNumber(decoded.timestamp) : 0,
    seq: decoded.seq !== undefined ? asNumber(decoded.seq) : 0,
    uuid: typeof decoded.uuid === "string" ? decoded.uuid : undefined,
    metrics,
    encoding: "protobuf",
  };
}

export function looksLikeJsonPayload(buf: Buffer): boolean {
  const start = buf.findIndex((b) => b !== 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09);
  if (start < 0) return false;
  const c = buf[start];
  return c === 0x7b || c === 0x5b; // { or [
}

export function decodeSparkplugJsonPayload(text: string): SparkplugPayloadView {
  const rec = JSON.parse(text) as Record<string, unknown>;
  const metrics = Array.isArray(rec.metrics)
    ? (rec.metrics as SparkplugMetric[]).map((m) => ({
        ...m,
        dataType: m.dataType ?? dataTypeName(m.datatype),
      }))
    : [{ name: "payload", value: rec, dataType: "String" }];
  return {
    timestamp: typeof rec.timestamp === "number" ? rec.timestamp : 0,
    seq: typeof rec.seq === "number" ? rec.seq : 0,
    uuid: typeof rec.uuid === "string" ? rec.uuid : undefined,
    metrics,
    encoding: "json-compat",
  };
}

export function decodeAnyPayload(input: Buffer | string): SparkplugPayloadView {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) return decodeSparkplugJsonPayload(trimmed);
    const buf = /^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0
      ? Buffer.from(trimmed, "hex")
      : Buffer.from(trimmed, "base64");
    return decodeSparkplugPayload(buf);
  }
  if (looksLikeJsonPayload(input)) {
    return decodeSparkplugJsonPayload(input.toString("utf8"));
  }
  return decodeSparkplugPayload(input);
}

export function parseSparkplugTopic(topic: string): SparkplugTopic | undefined {
  const parts = topic.split("/").filter(Boolean);
  if (parts[0] !== SPARKPLUG_NAMESPACE) return undefined;
  // Sparkplug 3.0 Host Application: spBv1.0/STATE/<hostId>
  if (parts.length >= 3 && parts[1] === "STATE") {
    const hostId = parts[2]!;
    return {
      namespace: SPARKPLUG_NAMESPACE,
      groupId: "",
      messageType: "STATE",
      edgeNode: hostId,
      hostId,
      kind: "state",
    };
  }
  if (parts.length < 4) return undefined;
  const messageType = parts[2]!;
  const kind: SparkplugTopic["kind"] =
    messageType === "STATE" ? "state" : messageType.startsWith("D") ? "device" : messageType.startsWith("N") ? "node" : "unknown";
  return {
    namespace: parts[0],
    groupId: parts[1]!,
    messageType,
    edgeNode: parts[3]!,
    deviceId: parts[4],
    kind,
  };
}

/** Official Host Application STATE topic (not spBv1.0/{group}/STATE/{edge}). */
export function formatHostStateTopic(hostId: string): string {
  return `${SPARKPLUG_NAMESPACE}/STATE/${hostId.trim()}`;
}

/** Sparkplug 3.0 Host STATE JSON payload. */
export function encodeHostState(online: boolean, timestamp = Date.now()): string {
  return JSON.stringify({ online, timestamp });
}

export function formatRebirthTopic(groupId: string, edgeNode: string): string {
  return formatSparkplugTopic({ groupId, messageType: "NCMD", edgeNode });
}

/** Sparkplug 3.0 Host STATE JSON: `{ "online": true, "timestamp": … }`. Not protobuf. */
export function decodeHostState(input: Buffer | string): { online: boolean; timestamp?: number; raw: string } {
  const raw = typeof input === "string" ? input : input.toString("utf8");
  try {
    const rec = JSON.parse(raw) as Record<string, unknown>;
    const online =
      rec.online === true || rec.online === "ONLINE" || rec.state === "ONLINE" || rec.state === true;
    return {
      online,
      timestamp: typeof rec.timestamp === "number" ? rec.timestamp : undefined,
      raw,
    };
  } catch {
    return { online: false, raw };
  }
}

export function formatSparkplugTopic(parts: {
  groupId: string;
  messageType: string;
  edgeNode: string;
  deviceId?: string;
}): string {
  const base = `${SPARKPLUG_NAMESPACE}/${parts.groupId}/${parts.messageType}/${parts.edgeNode}`;
  const device = parts.deviceId;
  if (device && (parts.messageType.startsWith("D") || parts.messageType === "STATE")) {
    return `${base}/${device}`;
  }
  return base;
}

export function isSparkplugMessageType(value: string): value is SparkplugMessageType {
  return (SPARKPLUG_MESSAGE_TYPES as readonly string[]).includes(value);
}
