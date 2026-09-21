import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { headersFromConfig } from "../../runtime/auth.js";
import { AdapterError } from "../../runtime/errors.js";
import { loadText } from "../../runtime/load.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { stringField } from "../helpers.js";
import { allowWriteFrom } from "../sql/common.js";
import { assertRpcCanWrite } from "../rpc-gate.js";

export type SoapVersion = "1.1" | "1.2";

export type SoapTransport = (
  endpoint: string,
  headers: Record<string, string>,
  body: string,
) => Promise<{ status: number; text: string }>;

interface SoapParam {
  name: string;
  type: string;
}

interface SoapOp {
  name: string;
  soapAction: string;
  description: string;
  params: SoapParam[];
}

const NS11 = "http://schemas.xmlsoap.org/soap/envelope/";
const NS12 = "http://www.w3.org/2003/05/soap-envelope";

/**
 * SOAP/WSDL adapter: maps portType operations (with XSD sequence params when present),
 * SOAP 1.1 or 1.2 envelopes, and Fault parsing. Not WS-Security / MTOM.
 */
export class SoapAdapter implements ProtocolAdapter {
  readonly protocol = "soap";
  private ops = new Map<string, SoapOp>();
  private endpoint = "";
  private targetNamespace = "";
  private soapVersion: SoapVersion = "1.1";
  private connected = false;
  private transport: SoapTransport = defaultFetchTransport;
  private allowWrite = false;

  constructor(
    readonly id: string,
    private readonly transportFn?: (config: Record<string, unknown>) => SoapTransport,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    const wsdlSource = stringField(config, "wsdl") ?? stringField(config, "wsdlUrl");
    if (!wsdlSource) throw new AdapterError("E_INVALID_CONFIG", "SOAP adapter requires config.wsdl (file path or URL)");
    const { text, href } = await loadText(wsdlSource);
    const parsed = parseWsdl(text);
    this.ops = parsed.operations;
    this.targetNamespace = parsed.targetNamespace;
    this.endpoint =
      stringField(config, "endpoint") ||
      parsed.endpoint ||
      (href && /^https?:\/\//i.test(href) ? href.replace(/\?.*$/, "") : "") ||
      "";
    const ver = stringField(config, "soapVersion") ?? stringField(config, "version");
    this.soapVersion = ver === "1.2" || parsed.soapVersion === "1.2" ? "1.2" : "1.1";
    this.transport = this.transportFn?.(config) ?? defaultFetchTransport;
    this.allowWrite = allowWriteFrom(config);
    this.connected = true;
    this.headersConfig = config;
  }

  private headersConfig: Record<string, unknown> = {};

  async disconnect(): Promise<void> {
    this.ops.clear();
    this.connected = false;
  }

  async listTools(): Promise<McpToolSchema[]> {
    this.assertConnected();
    return [...this.ops.values()].map((op) => {
      const properties: Record<string, unknown> = {
        args: {
          type: "object",
          additionalProperties: true,
          description: "Child elements placed under the SOAP operation wrapper",
        },
      };
      const required: string[] = [];
      for (const p of op.params) {
        properties[p.name] = { type: xsdToJson(p.type), description: `WSDL ${p.type}` };
        required.push(p.name);
      }
      return {
        name: op.name,
        description: `${op.description} [SOAP ${this.soapVersion}]`,
        inputSchema: {
          type: "object",
          properties,
          required: required.length ? required : undefined,
          additionalProperties: true,
        },
      };
    });
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const op = this.ops.get(toolName);
    if (!op) throw new AdapterError("E_UNKNOWN_TOOL", `Unknown SOAP operation "${toolName}"`, { protocol: "soap" });
    assertRpcCanWrite("soap", this.allowWrite, op.name);
    if (!this.endpoint) {
      throw new AdapterError("E_INVALID_CONFIG", "No SOAP endpoint (set config.endpoint or include soap:address in WSDL)");
    }

    const inner = (args.args && typeof args.args === "object" ? args.args : args) as Record<string, unknown>;
    const envelope = buildSoapEnvelope(op.name, this.targetNamespace, inner, this.soapVersion);
    const contentType =
      this.soapVersion === "1.2"
        ? `application/soap+xml; charset=utf-8${op.soapAction ? `; action="${op.soapAction}"` : ""}`
        : "text/xml; charset=utf-8";
    const headers = headersFromConfig(this.headersConfig, {
      "content-type": contentType,
      ...(this.soapVersion === "1.1" ? { SOAPAction: `"${op.soapAction}"` } : {}),
    });
    const res = await this.transport(this.endpoint, headers, envelope);
    const fault = parseSoapFault(res.text);
    if (fault) {
      return { status: res.status, ok: false, fault: true, soapVersion: this.soapVersion, ...fault, xml: res.text };
    }
    return { status: res.status, ok: res.status >= 200 && res.status < 300, soapVersion: this.soapVersion, xml: res.text };
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return {
      ok: true,
      detail: `operations=${this.ops.size} endpoint=${this.endpoint || "(none)"} soap=${this.soapVersion} allowWrite=${this.allowWrite}`,
    };
  }

  private assertConnected(): void {
    if (!this.connected) throw new AdapterError("E_NOT_CONNECTED", "SOAP adapter is not connected", { protocol: "soap" });
  }
}

async function defaultFetchTransport(
  endpoint: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; text: string }> {
  const res = await fetch(endpoint, { method: "POST", headers, body });
  return { status: res.status, text: await res.text() };
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
});

export function parseSoapFault(xml: string): { code: string; reason: string; detail?: unknown } | undefined {
  try {
    const doc = parser.parse(xml) as Record<string, unknown>;
    const envelope = first(doc.Envelope ?? doc.envelope);
    const body = first(envelope?.Body ?? envelope?.body);
    const fault = first(body?.Fault ?? body?.fault);
    if (!fault) return undefined;
    const code =
      attr(asRecord(fault.faultcode) ?? fault, "faultcode") ||
      textOf(fault.faultcode) ||
      textOf(asRecord(fault.Code)?.Value) ||
      textOf(fault.Code) ||
      "SOAP-FAULT";
    const reason =
      textOf(fault.faultstring) ||
      textOf(asRecord(fault.Reason)?.Text) ||
      textOf(fault.Reason) ||
      "SOAP Fault";
    return { code: String(code), reason: String(reason), detail: fault.detail ?? fault.Detail };
  } catch {
    return undefined;
  }
}

function parseWsdl(xml: string): {
  operations: Map<string, SoapOp>;
  endpoint: string;
  targetNamespace: string;
  soapVersion: SoapVersion;
} {
  const doc = parser.parse(xml) as Record<string, unknown>;
  const definitions = first(doc.definitions ?? doc.Definitions);
  if (!definitions || typeof definitions !== "object") {
    throw new AdapterError("E_INVALID_CONFIG", "Not a WSDL document (missing definitions)");
  }
  const def = definitions as Record<string, unknown>;
  const targetNamespace = attr(def, "targetNamespace") ?? "";
  const elements = collectSchemaElements(def);
  const messages = collectMessages(def);
  const operations = new Map<string, SoapOp>();
  let soapVersion: SoapVersion = "1.1";

  const portTypes = asArray(def.portType);
  for (const pt of portTypes) {
    for (const op of asArray(pt.operation)) {
      const name = attr(op, "name");
      if (!name) continue;
      const input = first(op.input);
      const msgName = input ? localName(attr(input, "message")) : "";
      const element = msgName ? messages.get(msgName) : undefined;
      const params = element ? (elements.get(element) ?? []) : [];
      const docEl = first(op.documentation);
      operations.set(sanitize(name), {
        name: sanitize(name),
        soapAction: "",
        description: textOf(docEl) || `SOAP operation ${name}`,
        params,
      });
    }
  }

  const bindings = asArray(def.binding);
  for (const binding of bindings) {
    const soapBind = first(binding.binding);
    const xmlns = soapBind ? attr(soapBind, "xmlns:soap") || attr(soapBind, "xmlns") : "";
    if (xmlns.includes("2003/05/soap")) soapVersion = "1.2";
    for (const op of asArray(binding.operation)) {
      const name = attr(op, "name");
      if (!name) continue;
      const soapOp = first(op.operation);
      const action = soapOp ? attr(soapOp, "soapAction") : "";
      const key = sanitize(name);
      const existing = operations.get(key);
      if (existing && action) existing.soapAction = action;
      else if (!existing) {
        operations.set(key, { name: key, soapAction: action, description: `SOAP operation ${name}`, params: [] });
      }
    }
  }

  let endpoint = "";
  for (const service of asArray(def.service)) {
    for (const port of asArray(service.port)) {
      const address = first(port.address);
      const location = address ? attr(address, "location") : "";
      if (location) {
        endpoint = location;
        break;
      }
    }
  }

  if (operations.size === 0) {
    throw new AdapterError("E_INVALID_CONFIG", "WSDL contained no operations");
  }
  return { operations, endpoint, targetNamespace, soapVersion };
}

function collectSchemaElements(def: Record<string, unknown>): Map<string, SoapParam[]> {
  const out = new Map<string, SoapParam[]>();
  for (const types of asArray(def.types)) {
    for (const schema of asArray(types.schema)) {
      for (const el of asArray(schema.element)) {
        const name = attr(el, "name");
        if (!name) continue;
        const seq = first(asRecord(first(el.complexType))?.sequence);
        const params: SoapParam[] = [];
        for (const child of asArray(seq?.element)) {
          const cn = attr(child, "name");
          if (cn) params.push({ name: cn, type: attr(child, "type") || "xsd:string" });
        }
        out.set(name, params);
        out.set(localName(name), params);
      }
    }
  }
  return out;
}

function collectMessages(def: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  for (const msg of asArray(def.message)) {
    const name = attr(msg, "name");
    const part = first(msg.part);
    const element = part ? localName(attr(part, "element")) : "";
    if (name && element) out.set(name, element);
  }
  return out;
}

function buildSoapEnvelope(opName: string, xmlns: string, args: Record<string, unknown>, version: SoapVersion): string {
  const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  const children: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k.startsWith("_") || k === "args") continue;
    children[k] = v;
  }
  const bodyOp: Record<string, unknown> = { ...children };
  if (xmlns) bodyOp["@_xmlns"] = xmlns;
  const ns = version === "1.2" ? NS12 : NS11;
  const prefix = version === "1.2" ? "soap12" : "soap";
  const obj = {
    [`${prefix}:Envelope`]: {
      [`@_xmlns:${prefix}`]: ns,
      [`${prefix}:Body`]: {
        [opName]: bodyOp,
      },
    },
  };
  return `<?xml version="1.0" encoding="utf-8"?>${builder.build(obj)}`;
}

function xsdToJson(type: string): string {
  const t = type.replace(/^.*:/, "").toLowerCase();
  if (["int", "integer", "long", "short", "byte", "decimal", "float", "double"].includes(t)) return "number";
  if (t === "boolean") return "boolean";
  return "string";
}

function asArray(value: unknown): Record<string, unknown>[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === "object");
  if (typeof value === "object") return [value as Record<string, unknown>];
  return [];
}

function first(value: unknown): Record<string, unknown> | undefined {
  return asArray(value)[0];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function attr(obj: Record<string, unknown> | undefined, name: string): string {
  if (!obj) return "";
  const v = obj[`@_${name}`] ?? obj[name];
  return typeof v === "string" ? v : "";
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "#text" in (value as Record<string, unknown>)) {
    const t = (value as Record<string, unknown>)["#text"];
    return typeof t === "string" ? t : "";
  }
  return "";
}

function localName(qname: string): string {
  const i = qname.indexOf(":");
  return i >= 0 ? qname.slice(i + 1) : qname;
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, "_") || "op";
}

export { parseWsdlForTests as parseWsdl };
function parseWsdlForTests(xml: string) {
  return parseWsdl(xml);
}
