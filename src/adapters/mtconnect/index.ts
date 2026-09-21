import { XMLParser } from "fast-xml-parser";
import { AdapterError } from "../../runtime/errors.js";
import { loadText } from "../../runtime/load.js";
import { fetchSafe } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { stringField } from "../helpers.js";

export interface MtConnectDevice {
  id: string;
  name: string;
  uuid?: string;
  dataItems: Array<{ id: string; type?: string; category?: string; units?: string }>;
}

export interface MtConnectSample {
  dataItemId: string;
  name?: string;
  value: unknown;
}

export interface MtConnectHandle {
  probe(): Promise<{ devices: MtConnectDevice[]; sender?: string }>;
  current(): Promise<{ samples: MtConnectSample[]; sender?: string }>;
  close(): Promise<void>;
}

export type MtConnectConnectFn = (config: Record<string, unknown>) => Promise<MtConnectHandle>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
  textNodeName: "#text",
});

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function walkDevices(node: unknown, out: MtConnectDevice[]): void {
  if (!node || typeof node !== "object") return;
  const rec = node as Record<string, unknown>;
  if (rec.Device) {
    for (const d of asArray(rec.Device)) {
      if (!d || typeof d !== "object") continue;
      const dev = d as Record<string, unknown>;
      const dataItems: MtConnectDevice["dataItems"] = [];
      collectDataItems(dev, dataItems);
      out.push({
        id: String(dev.id ?? dev.name ?? "device"),
        name: String(dev.name ?? dev.id ?? "device"),
        uuid: typeof dev.uuid === "string" ? dev.uuid : undefined,
        dataItems,
      });
    }
  }
  for (const v of Object.values(rec)) {
    if (v && typeof v === "object") walkDevices(v, out);
  }
}

function collectDataItems(node: unknown, out: MtConnectDevice["dataItems"]): void {
  if (!node || typeof node !== "object") return;
  const rec = node as Record<string, unknown>;
  if (rec.DataItem) {
    for (const item of asArray(rec.DataItem)) {
      if (!item || typeof item !== "object") continue;
      const di = item as Record<string, unknown>;
      out.push({
        id: String(di.id ?? ""),
        type: typeof di.type === "string" ? di.type : undefined,
        category: typeof di.category === "string" ? di.category : undefined,
        units: typeof di.units === "string" ? di.units : undefined,
      });
    }
  }
  for (const v of Object.values(rec)) {
    if (v && typeof v === "object") collectDataItems(v, out);
  }
}

function coerceXmlValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const t = value.trim();
  if (t === "") return t;
  if (/^[+-]?\d+$/.test(t)) return Number(t);
  if (/^[+-]?\d+\.\d+$/.test(t)) return Number(t);
  return t;
}

function walkSamples(node: unknown, out: MtConnectSample[]): void {
  if (!node || typeof node !== "object") return;
  const rec = node as Record<string, unknown>;
  const id = rec.dataItemId ?? rec.dataItemIdRef;
  if (typeof id === "string" && ("#text" in rec || rec.value !== undefined)) {
    out.push({
      dataItemId: id,
      name: typeof rec.name === "string" ? rec.name : undefined,
      value: coerceXmlValue(rec["#text"] ?? rec.value),
    });
  }
  for (const [k, v] of Object.entries(rec)) {
    if (k === "#text") continue;
    if (v && typeof v === "object") walkSamples(v, out);
  }
}

export function parseMtConnectXml(xml: string): { kind: "devices" | "streams" | "unknown"; devices: MtConnectDevice[]; samples: MtConnectSample[]; sender?: string } {
  let doc: unknown;
  try {
    doc = parser.parse(xml);
  } catch (err) {
    throw new AdapterError("E_PROTOCOL", `MTConnect XML parse failed: ${err instanceof Error ? err.message : String(err)}`, {
      protocol: "mtconnect",
    });
  }
  const devices: MtConnectDevice[] = [];
  const samples: MtConnectSample[] = [];
  walkDevices(doc, devices);
  walkSamples(doc, samples);
  const text = xml;
  const kind = /MTConnectDevices/i.test(text) ? "devices" : /MTConnectStreams/i.test(text) ? "streams" : "unknown";
  const sender = text.match(/sender="([^"]+)"/i)?.[1];
  return { kind, devices, samples, sender };
}

export function looksLikeMtConnect(xml: string): boolean {
  return /MTConnect(Devices|Streams|Error)/i.test(xml) || /urn:mtconnect\.org/i.test(xml);
}

function synthesizeCurrent(devices: MtConnectDevice[]): MtConnectSample[] {
  const samples: MtConnectSample[] = [];
  for (const d of devices) {
    for (const item of d.dataItems) {
      const value = item.type === "AVAILABILITY" ? "AVAILABLE" : item.category === "SAMPLE" ? 0 : "UNAVAILABLE";
      samples.push({ dataItemId: item.id, name: item.type, value });
    }
  }
  return samples;
}

export async function defaultMtConnectConnect(config: Record<string, unknown>): Promise<MtConnectHandle> {
  const xmlInline = stringField(config, "xml") ?? stringField(config, "probeXml");
  const fixture = stringField(config, "fixture") ?? stringField(config, "probeFixture");
  const currentInline = stringField(config, "currentXml");
  const currentFixture = stringField(config, "currentFixture");
  const url = (stringField(config, "url") ?? stringField(config, "baseUrl") ?? "").replace(/\/+$/, "");
  const timeoutMs = typeof config.timeoutMs === "number" && config.timeoutMs > 0 ? config.timeoutMs : 4000;

  let probeXml = xmlInline;
  if (!probeXml && fixture) probeXml = (await loadText(fixture)).text;
  let currentXml = currentInline;
  if (!currentXml && currentFixture) currentXml = (await loadText(currentFixture)).text;

  if (probeXml || currentXml) {
    const probe = probeXml ? parseMtConnectXml(probeXml) : { devices: [] as MtConnectDevice[], samples: [] as MtConnectSample[], sender: undefined };
    const streams = currentXml ? parseMtConnectXml(currentXml) : undefined;
    return {
      async probe() {
        return { devices: probe.devices, sender: probe.sender };
      },
      async current() {
        const samples = streams?.samples.length ? streams.samples : synthesizeCurrent(probe.devices);
        return { samples, sender: streams?.sender ?? probe.sender };
      },
      async close() {
        /* fixture */
      },
    };
  }

  if (!url) {
    throw new AdapterError(
      "E_INVALID_CONFIG",
      "mtconnect adapter requires config.url, config.fixture, or config.xml",
      { protocol: "mtconnect" },
    );
  }

  const get = async (path: string) => {
    const res = await fetchSafe(`${url}${path}`, { method: "GET", timeoutMs });
    if (!res.ok) {
      throw new AdapterError("E_PROTOCOL", `MTConnect HTTP ${res.status} on ${path}`, { protocol: "mtconnect", details: { status: res.status } });
    }
    const text = await res.text();
    if (!looksLikeMtConnect(text)) {
      throw new AdapterError("E_PROTOCOL", `Not MTConnect XML at ${path}`, { protocol: "mtconnect" });
    }
    return parseMtConnectXml(text);
  };

  return {
    async probe() {
      const doc = await get("/probe");
      return { devices: doc.devices, sender: doc.sender };
    },
    async current() {
      const doc = await get("/current");
      return { samples: doc.samples, sender: doc.sender };
    },
    async close() {
      /* http */
    },
  };
}

/**
 * MTConnect Agent HTTP: GET /probe and /current. No websocket, no MQTT stream, no Assets.
 */
export class MtConnectAdapter implements ProtocolAdapter {
  readonly protocol = "mtconnect";
  private handle: MtConnectHandle | undefined;
  private connected = false;
  private source = "";

  constructor(
    readonly id: string,
    private readonly connectFn: MtConnectConnectFn = defaultMtConnectConnect,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    this.source = stringField(config, "url") ?? stringField(config, "fixture") ?? "inline";
    this.handle = await this.connectFn(config);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.handle) await this.handle.close();
    this.handle = undefined;
    this.connected = false;
  }

  async listTools(): Promise<McpToolSchema[]> {
    this.assertConnected();
    return [
      {
        name: "probe",
        description: "MTConnect Devices document (GET /probe) — device/dataItem tree",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "current",
        description: "MTConnect Streams snapshot (GET /current)",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "sample",
        description: "Thin sample: same as current (no Agent sequence window)",
        inputSchema: {
          type: "object",
          properties: { count: { type: "integer", description: "Max samples to return" } },
          additionalProperties: false,
        },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const handle = this.handle!;
    if (toolName === "probe") {
      const doc = await handle.probe();
      return { ...doc, note: "HTTP pull of MTConnectDevices. No Assets, no websocket." };
    }
    if (toolName === "current") {
      const doc = await handle.current();
      return { ...doc, note: "HTTP pull of MTConnectStreams." };
    }
    if (toolName === "sample") {
      const doc = await handle.current();
      const count = typeof args.count === "number" && args.count > 0 ? args.count : doc.samples.length;
      return { samples: doc.samples.slice(0, count), sender: doc.sender, note: "sample is current[:count]; no sequence from=." };
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown MTConnect tool "${toolName}"`, { protocol: "mtconnect" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return { ok: true, detail: `mtconnect source=${this.source}` };
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_NOT_CONNECTED", "MTConnect adapter is not connected", { protocol: "mtconnect" });
    }
  }
}
