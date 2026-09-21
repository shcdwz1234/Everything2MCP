import { createSocket } from "node:dgram";
import { AdapterError } from "../../runtime/errors.js";
import { assertHostAllowed } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";
import { requiredNumber, stringField } from "../helpers.js";
import {
  BACNET_IP_PORT,
  decodeIAm,
  encodeIAm,
  encodeWhoIs,
} from "./codec.js";

export interface BacnetObject {
  objectType: string;
  objectInstance: number;
  objectName?: string;
  properties: Record<string, unknown>;
}

export interface BacnetDevice {
  deviceId: number;
  name: string;
  vendorId?: number;
  objects: BacnetObject[];
}

export interface BacnetHandle {
  whoIs(low?: number, high?: number): Promise<BacnetDevice[]>;
  iAm(): Promise<BacnetDevice>;
  readProperty(
    deviceId: number,
    objectType: string,
    objectInstance: number,
    property: string,
  ): Promise<{ deviceId: number; objectType: string; objectInstance: number; property: string; value: unknown }>;
  writeProperty?(
    deviceId: number,
    objectType: string,
    objectInstance: number,
    property: string,
    value: unknown,
  ): Promise<{ deviceId: number; objectType: string; objectInstance: number; property: string; value: unknown }>;
  listObjects?(deviceId?: number): Promise<Array<{ deviceId: number; objectType: string; objectInstance: number; objectName?: string }>>;
  close(): Promise<void>;
}

export type BacnetConnectFn = (config: Record<string, unknown>) => Promise<BacnetHandle>;

function propertyKey(property: string): string {
  return property === "presentValue" ? "present-value" : property;
}

function asDevice(raw: unknown, fallbackId: number): BacnetDevice | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const rec = raw as Record<string, unknown>;
  const deviceId = typeof rec.deviceId === "number" ? rec.deviceId : fallbackId;
  const name = typeof rec.name === "string" ? rec.name : `device-${deviceId}`;
  const objectsRaw = Array.isArray(rec.objects) ? rec.objects : [];
  const objects: BacnetObject[] = [];
  for (const o of objectsRaw) {
    if (!o || typeof o !== "object") continue;
    const obj = o as Record<string, unknown>;
    const objectType = typeof obj.objectType === "string" ? obj.objectType : "analog-input";
    const objectInstance = typeof obj.objectInstance === "number" ? obj.objectInstance : 0;
    const properties =
      obj.properties && typeof obj.properties === "object" && !Array.isArray(obj.properties)
        ? { ...(obj.properties as Record<string, unknown>) }
        : {};
    if (obj.presentValue !== undefined && properties["present-value"] === undefined) {
      properties["present-value"] = obj.presentValue;
    }
    if (typeof obj.objectName === "string" && properties["object-name"] === undefined) {
      properties["object-name"] = obj.objectName;
    }
    objects.push({
      objectType,
      objectInstance,
      objectName: typeof obj.objectName === "string" ? obj.objectName : undefined,
      properties,
    });
  }
  if (!objects.some((o) => o.objectType === "device")) {
    objects.unshift({
      objectType: "device",
      objectInstance: deviceId,
      objectName: name,
      properties: { "object-name": name, "object-identifier": deviceId },
    });
  }
  return {
    deviceId,
    name,
    vendorId: typeof rec.vendorId === "number" ? rec.vendorId : 999,
    objects,
  };
}

function findObject(devices: BacnetDevice[], deviceId: number, objectType: string, objectInstance: number): { device: BacnetDevice; obj: BacnetObject } {
  const device = devices.find((d) => d.deviceId === deviceId);
  if (!device) throw new AdapterError("E_NOT_FOUND", `Unknown BACnet device ${deviceId}`, { protocol: "bacnet" });
  const obj = device.objects.find((o) => o.objectType === objectType && o.objectInstance === objectInstance);
  if (!obj) {
    throw new AdapterError(
      "E_NOT_FOUND",
      `Unknown object ${objectType}:${objectInstance} on device ${deviceId}`,
      { protocol: "bacnet" },
    );
  }
  return { device, obj };
}

export function createBacnetSimulator(config: Record<string, unknown>): BacnetHandle {
  const devices: BacnetDevice[] = [];
  if (Array.isArray(config.devices)) {
    for (const [i, d] of config.devices.entries()) {
      const parsed = asDevice(d, i + 1);
      if (parsed) devices.push(parsed);
    }
  }
  if (!devices.length) {
    const deviceId = typeof config.deviceId === "number" ? config.deviceId : 1001;
    devices.push({
      deviceId,
      name: stringField(config, "name") ?? "e2mcp-bacnet",
      vendorId: 999,
      objects: [
        {
          objectType: "device",
          objectInstance: deviceId,
          objectName: "e2mcp-bacnet",
          properties: { "object-name": "e2mcp-bacnet", "object-identifier": deviceId },
        },
        {
          objectType: "analog-input",
          objectInstance: 1,
          objectName: "Temperature",
          properties: { "present-value": 21.5, "object-name": "Temperature", units: "degrees-celsius" },
        },
      ],
    });
  }
  const local = devices[0]!;
  return {
    async whoIs(low, high) {
      return devices.filter((d) => {
        if (low !== undefined && d.deviceId < low) return false;
        if (high !== undefined && d.deviceId > high) return false;
        return true;
      });
    },
    async iAm() {
      return local;
    },
    async readProperty(deviceId, objectType, objectInstance, property) {
      const { obj } = findObject(devices, deviceId, objectType, objectInstance);
      const key = propertyKey(property);
      if (!(key in obj.properties) && key !== "object-name" && key !== "object-type") {
        throw new AdapterError("E_NOT_FOUND", `Unknown property ${property}`, { protocol: "bacnet" });
      }
      const value =
        key === "object-name"
          ? (obj.properties["object-name"] ?? obj.objectName)
          : key === "object-type"
            ? obj.objectType
            : obj.properties[key];
      return { deviceId, objectType, objectInstance, property: key, value };
    },
    async writeProperty(deviceId, objectType, objectInstance, property, value) {
      const { obj } = findObject(devices, deviceId, objectType, objectInstance);
      const key = propertyKey(property);
      obj.properties[key] = value;
      if (key === "object-name" && typeof value === "string") obj.objectName = value;
      return { deviceId, objectType, objectInstance, property: key, value };
    },
    async listObjects(deviceId) {
      const subset = deviceId === undefined ? devices : devices.filter((d) => d.deviceId === deviceId);
      if (deviceId !== undefined && !subset.length) {
        throw new AdapterError("E_NOT_FOUND", `Unknown BACnet device ${deviceId}`, { protocol: "bacnet" });
      }
      return subset.flatMap((d) =>
        d.objects.map((o) => ({
          deviceId: d.deviceId,
          objectType: o.objectType,
          objectInstance: o.objectInstance,
          objectName: o.objectName,
        })),
      );
    },
    async close() {
      devices.length = 0;
    },
  };
}

async function sendUnicast(host: string, port: number, payload: Buffer): Promise<void> {
  await assertHostAllowed(host);
  await new Promise<void>((resolve, reject) => {
    const socket = createSocket("udp4");
    socket.once("error", (err) => {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      reject(err);
    });
    socket.send(payload, port, host, (err) => {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve();
    });
  });
}

export async function whoIsUnicast(
  host: string,
  port: number,
  low: number | undefined,
  high: number | undefined,
  timeoutMs: number,
): Promise<BacnetDevice[]> {
  await assertHostAllowed(host);
  const payload = encodeWhoIs({ low, high });
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    const found: BacnetDevice[] = [];
    const seen = new Set<number>();
    const finish = () => {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      resolve(found);
    };
    const timer = setTimeout(finish, timeoutMs);
    socket.on("message", (msg) => {
      const iam = decodeIAm(msg);
      if (!iam) return;
      if (low !== undefined && iam.deviceId < low) return;
      if (high !== undefined && iam.deviceId > high) return;
      if (seen.has(iam.deviceId)) return;
      seen.add(iam.deviceId);
      found.push({
        deviceId: iam.deviceId,
        name: `device-${iam.deviceId}`,
        vendorId: iam.vendorId,
        objects: [],
      });
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      reject(new AdapterError("E_PROTOCOL", err.message, { protocol: "bacnet" }));
    });
    socket.send(payload, port, host, (err) => {
      if (err) {
        clearTimeout(timer);
        try {
          socket.close();
        } catch {
          /* ignore */
        }
        reject(new AdapterError("E_PROTOCOL", err.message, { protocol: "bacnet" }));
      }
    });
  });
}

/** Overlay unicast Who-Is/I-Am on a local object table. Never broadcasts. */
export function wrapWithUdp(local: BacnetHandle, config: Record<string, unknown>): BacnetHandle {
  const host = stringField(config, "host") ?? "127.0.0.1";
  const port = typeof config.port === "number" ? config.port : BACNET_IP_PORT;
  const waitMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 800;
  return {
    async whoIs(low, high) {
      return whoIsUnicast(host, port, low, high, waitMs);
    },
    async iAm() {
      const localDev = await local.iAm();
      await sendUnicast(
        host,
        port,
        encodeIAm({
          deviceId: localDev.deviceId,
          vendorId: localDev.vendorId ?? 999,
        }),
      );
      return localDev;
    },
    readProperty: (deviceId, objectType, objectInstance, property) =>
      local.readProperty(deviceId, objectType, objectInstance, property),
    writeProperty: local.writeProperty
      ? (deviceId, objectType, objectInstance, property, value) =>
          local.writeProperty!(deviceId, objectType, objectInstance, property, value)
      : undefined,
    listObjects: local.listObjects ? (deviceId) => local.listObjects!(deviceId) : undefined,
    close: () => local.close(),
  };
}

export async function defaultBacnetConnect(config: Record<string, unknown>): Promise<BacnetHandle> {
  const sim = createBacnetSimulator(config);
  if (config.udp === true) return wrapWithUdp(sim, config);
  return sim;
}

/**
 * BACnet/IP adapter: in-memory device table (ReadProperty / WriteProperty / Who-Is)
 * plus optional unicast UDP Who-Is/I-Am when `udp: true`.
 * Not a full stack (no BBMD, no COV, no confirmed APDU over the wire).
 */
export class BacnetAdapter implements ProtocolAdapter {
  readonly protocol = "bacnet";
  private handle: BacnetHandle | undefined;
  private connected = false;
  private host = "";
  private port = BACNET_IP_PORT;
  private udp = false;
  private allowWrite = false;

  constructor(
    readonly id: string,
    private readonly connectFn: BacnetConnectFn = defaultBacnetConnect,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    this.host = stringField(config, "host") ?? "127.0.0.1";
    this.port = typeof config.port === "number" ? config.port : BACNET_IP_PORT;
    this.udp = config.udp === true;
    this.allowWrite = allowWriteFrom(config);
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
        name: "who_is",
        description: this.udp
          ? "Unicast Who-Is (BACnet/IP Original-Unicast-NPDU); never broadcasts"
          : "Who-Is against the in-memory I-Am table (set udp:true for BACnet/IP unicast)",
        inputSchema: {
          type: "object",
          properties: {
            low: { type: "integer", description: "Inclusive low device instance" },
            high: { type: "integer", description: "Inclusive high device instance" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "i_am",
        description: this.udp
          ? "Unicast I-Am for the local (first) device"
          : "I-Am for the local (first) device",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "read_property",
        description: "Read a property (present-value, object-name, …) from an object",
        inputSchema: {
          type: "object",
          properties: {
            deviceId: { type: "integer" },
            objectType: { type: "string" },
            objectInstance: { type: "integer" },
            property: { type: "string", default: "present-value" },
          },
          required: ["deviceId", "objectType", "objectInstance"],
          additionalProperties: false,
        },
      },
      {
        name: "list_objects",
        description: "List objects on one device, or every device in the table",
        inputSchema: {
          type: "object",
          properties: { deviceId: { type: "integer" } },
          additionalProperties: false,
        },
      },
      {
        name: "write_property",
        description: "Write a property (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: {
            deviceId: { type: "integer" },
            objectType: { type: "string" },
            objectInstance: { type: "integer" },
            property: { type: "string", default: "present-value" },
            value: {},
          },
          required: ["deviceId", "objectType", "objectInstance", "value"],
          additionalProperties: false,
        },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const handle = this.handle!;
    if (toolName === "who_is") {
      const low = typeof args.low === "number" ? args.low : undefined;
      const high = typeof args.high === "number" ? args.high : undefined;
      const devices = await handle.whoIs(low, high);
      return {
        devices: devices.map((d) => ({
          deviceId: d.deviceId,
          name: d.name,
          vendorId: d.vendorId,
          objectCount: d.objects.length,
        })),
        transport: this.udp ? "udp-unicast" : "memory",
        note: this.udp
          ? "BACnet/IP Original-Unicast-NPDU Who-Is; not broadcast, not CIDR"
          : "In-memory Who-Is/I-Am table; set udp:true for BACnet/IP unicast",
      };
    }
    if (toolName === "i_am") {
      const device = await handle.iAm();
      return {
        deviceId: device.deviceId,
        name: device.name,
        vendorId: device.vendorId,
        maxApdu: 1476,
        segmentation: "no-segmentation",
        transport: this.udp ? "udp-unicast" : "memory",
      };
    }
    if (toolName === "read_property") {
      const deviceId = requiredNumber(args, "deviceId");
      const objectType = typeof args.objectType === "string" ? args.objectType : "analog-input";
      const objectInstance = requiredNumber(args, "objectInstance");
      const property = typeof args.property === "string" ? args.property : "present-value";
      return handle.readProperty(deviceId, objectType, objectInstance, property);
    }
    if (toolName === "list_objects") {
      if (!handle.listObjects) {
        throw new AdapterError("E_UNSUPPORTED", "list_objects is not available on this handle", { protocol: "bacnet" });
      }
      const deviceId = typeof args.deviceId === "number" ? args.deviceId : undefined;
      const objects = await handle.listObjects(deviceId);
      return { objects };
    }
    if (toolName === "write_property") {
      assertCanWrite("bacnet", this.allowWrite);
      if (!handle.writeProperty) {
        throw new AdapterError("E_UNSUPPORTED", "write_property is not available on this handle", { protocol: "bacnet" });
      }
      const deviceId = requiredNumber(args, "deviceId");
      const objectType = typeof args.objectType === "string" ? args.objectType : "analog-input";
      const objectInstance = requiredNumber(args, "objectInstance");
      const property = typeof args.property === "string" ? args.property : "present-value";
      return handle.writeProperty(deviceId, objectType, objectInstance, property, args.value);
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown BACnet tool "${toolName}"`, { protocol: "bacnet" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    const transport = this.udp ? "udp-unicast" : "memory";
    return {
      ok: true,
      detail: `host=${this.host}:${this.port} transport=${transport} allowWrite=${this.allowWrite}`,
    };
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_NOT_CONNECTED", "BACnet adapter is not connected", { protocol: "bacnet" });
    }
  }
}
