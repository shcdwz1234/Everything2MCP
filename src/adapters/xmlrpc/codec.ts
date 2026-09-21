import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, trimValues: true });

export function encodeMethodCall(method: string, params: unknown[]): string {
  const inner = params.map((p) => `<param><value>${encodeValue(p)}</value></param>`).join("");
  return `<?xml version="1.0"?><methodCall><methodName>${escapeXml(method)}</methodName><params>${inner}</params></methodCall>`;
}

export function encodeMethodResponse(value: unknown): string {
  return `<?xml version="1.0"?><methodResponse><params><param><value>${encodeValue(value)}</value></param></params></methodResponse>`;
}

export function decodeMethodResponse(xml: string): unknown {
  const doc = parser.parse(xml) as Record<string, unknown>;
  const resp = (doc.methodResponse ?? doc) as Record<string, unknown>;
  if (resp.fault) {
    throw new Error(`XML-RPC fault: ${JSON.stringify(resp.fault)}`);
  }
  const params = resp.params as Record<string, unknown> | undefined;
  const param = params?.param;
  const list = Array.isArray(param) ? param : param ? [param] : [];
  const values = list.map((p) => decodeValue((p as Record<string, unknown>).value ?? p));
  return values.length <= 1 ? (values[0] ?? null) : values;
}

function encodeValue(value: unknown): string {
  if (typeof value === "boolean") return `<boolean>${value ? 1 : 0}</boolean>`;
  if (typeof value === "number") {
    return Number.isInteger(value) ? `<int>${value}</int>` : `<double>${value}</double>`;
  }
  if (Array.isArray(value)) {
    return `<array><data>${value.map((v) => `<value>${encodeValue(v)}</value>`).join("")}</data></array>`;
  }
  if (value && typeof value === "object") {
    const members = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `<member><name>${escapeXml(k)}</name><value>${encodeValue(v)}</value></member>`)
      .join("");
    return `<struct>${members}</struct>`;
  }
  return `<string>${escapeXml(String(value ?? ""))}</string>`;
}

function decodeValue(raw: unknown): unknown {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object") return raw;
  const v = raw as Record<string, unknown>;
  if ("string" in v) return v.string;
  if ("int" in v || "i4" in v) return Number(v.int ?? v.i4);
  if ("boolean" in v) return v.boolean === 1 || v.boolean === "1";
  if ("double" in v) return Number(v.double);
  if ("array" in v) {
    const data = (v.array as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
    const values = data?.value;
    const list = Array.isArray(values) ? values : values !== undefined ? [values] : [];
    return list.map(decodeValue);
  }
  if ("struct" in v) {
    const members = (v.struct as Record<string, unknown>)?.member;
    const list = Array.isArray(members) ? members : members ? [members] : [];
    const out: Record<string, unknown> = {};
    for (const m of list) {
      const rec = m as Record<string, unknown>;
      if (typeof rec.name === "string") out[rec.name] = decodeValue(rec.value);
    }
    return out;
  }
  if ("value" in v) return decodeValue(v.value);
  return v;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
