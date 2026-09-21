import { AdapterError } from "../../runtime/errors.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { requiredString, stringField } from "../helpers.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";
import { decodeAck, encodeHello, parseEndpoint } from "./hello.js";
import { connectNodeOpcUa } from "./live.js";
import type { OpcUaConnectFn, OpcUaHandle, OpcUaHelloFn, OpcUaNode } from "./types.js";
import { Socket } from "node:net";

export const STANDARD_NODES = {
  RootFolder: "i=84",
  ObjectsFolder: "i=85",
  TypesFolder: "i=86",
  ViewsFolder: "i=87",
  Server: "i=2253",
} as const;

export type { OpcUaConnectFn, OpcUaHandle, OpcUaHelloFn, OpcUaNode } from "./types.js";

function inferDataType(value: unknown): string {
  if (typeof value === "boolean") return "Boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "Int32" : "Double";
  if (typeof value === "string") return "String";
  if (Array.isArray(value)) return "Array";
  if (value && typeof value === "object") return "ExtensionObject";
  return "Variant";
}

function nodeFromConfig(rec: Record<string, unknown>, fallbackId: string, parent?: string): OpcUaNode {
  const nodeId = typeof rec.nodeId === "string" ? rec.nodeId : typeof rec.id === "string" ? rec.id : fallbackId;
  const value = rec.value ?? null;
  const displayName = typeof rec.displayName === "string" ? rec.displayName : nodeId.split(";").pop() ?? nodeId;
  const browseName = typeof rec.browseName === "string" ? rec.browseName : displayName;
  const nodeClass = typeof rec.nodeClass === "string" ? rec.nodeClass : "Variable";
  const dataType = typeof rec.dataType === "string" ? rec.dataType : inferDataType(value);
  return { nodeId, value, displayName, browseName, nodeClass, dataType, parent };
}

function seedStandard(nodes: Map<string, OpcUaNode>): void {
  const add = (nodeId: string, displayName: string, nodeClass: string, parent?: string, value: unknown = displayName) => {
    if (!nodes.has(nodeId)) {
      nodes.set(nodeId, {
        nodeId,
        value,
        displayName,
        browseName: displayName,
        nodeClass,
        dataType: "String",
        parent,
      });
    }
  };
  add(STANDARD_NODES.RootFolder, "RootFolder", "Object");
  add(STANDARD_NODES.ObjectsFolder, "ObjectsFolder", "Object", STANDARD_NODES.RootFolder);
  add(STANDARD_NODES.TypesFolder, "TypesFolder", "Object", STANDARD_NODES.RootFolder);
  add(STANDARD_NODES.ViewsFolder, "ViewsFolder", "Object", STANDARD_NODES.RootFolder);
  add(STANDARD_NODES.Server, "Server", "Object", STANDARD_NODES.ObjectsFolder);
}

function resolveId(nodeId?: string): string {
  if (!nodeId || nodeId === "RootFolder") return STANDARD_NODES.RootFolder;
  if (nodeId === "ObjectsFolder") return STANDARD_NODES.ObjectsFolder;
  if (nodeId === "TypesFolder") return STANDARD_NODES.TypesFolder;
  if (nodeId === "ViewsFolder") return STANDARD_NODES.ViewsFolder;
  if (nodeId === "Server") return STANDARD_NODES.Server;
  return nodeId;
}

/** In-memory address space with ns=0 standard folders. Default CI / demo data plane. */
export function createOpcUaSimulator(config: Record<string, unknown>): OpcUaHandle {
  const nodes = new Map<string, OpcUaNode>();
  seedStandard(nodes);
  const configured = Array.isArray(config.nodes) ? config.nodes : [];
  for (const n of configured) {
    if (typeof n === "string") {
      nodes.set(n, nodeFromConfig({ nodeId: n, value: null }, n, STANDARD_NODES.ObjectsFolder));
      continue;
    }
    if (!n || typeof n !== "object") continue;
    const node = nodeFromConfig(n as Record<string, unknown>, "", STANDARD_NODES.ObjectsFolder);
    if (node.nodeId) nodes.set(node.nodeId, { ...node, parent: node.parent ?? STANDARD_NODES.ObjectsFolder });
  }
  const sessionId =
    typeof config.sessionId === "string" && config.sessionId.trim()
      ? config.sessionId.trim()
      : `sim-${Date.now().toString(36)}`;
  const monitors = new Map<string, Array<(n: OpcUaNode) => void>>();
  let monSeq = 1;
  const notify = (id: string, node: OpcUaNode) => {
    const list = monitors.get(id) ?? [];
    monitors.set(id, []);
    for (const fn of list) fn(node);
  };
  return {
    sessionId,
    async read(nodeId) {
      const id = resolveId(nodeId);
      const node = nodes.get(id);
      if (!node) throw new AdapterError("E_NOT_FOUND", `Unknown nodeId ${nodeId}`, { protocol: "opcua" });
      return {
        nodeId: id,
        value: node.value,
        dataType: node.dataType,
        nodeClass: node.nodeClass,
        statusCode: "Good",
        sourceTimestamp: new Date().toISOString(),
        sessionId,
      };
    },
    async write(nodeId, value) {
      const id = resolveId(nodeId);
      const existing = nodes.get(id);
      const next: OpcUaNode = existing
        ? { ...existing, value, dataType: inferDataType(value) }
        : nodeFromConfig({ nodeId: id, value }, id, STANDARD_NODES.ObjectsFolder);
      nodes.set(id, next);
      notify(id, next);
      return { nodeId: id, value: next.value, dataType: next.dataType, statusCode: "Good", sessionId };
    },
    async browse(nodeId) {
      const id = resolveId(nodeId);
      if (!nodes.has(id)) {
        throw new AdapterError("E_NOT_FOUND", `Unknown nodeId ${nodeId}`, { protocol: "opcua" });
      }
      const refs = [...nodes.values()]
        .filter((n) => (n.parent ?? "") === id || (!nodeId && n.parent === STANDARD_NODES.RootFolder && id === STANDARD_NODES.RootFolder))
        .map((n) => ({
          nodeId: n.nodeId,
          browseName: n.browseName,
          displayName: n.displayName,
          nodeClass: n.nodeClass,
          hasValue: n.value !== undefined,
        }));
      return { nodeId: id, references: refs, sessionId };
    },
    async list() {
      return [...nodes.values()].map((n) => ({ ...n }));
    },
    async subscribeOnce(nodeId) {
      const id = resolveId(nodeId);
      const node = nodes.get(id);
      if (!node) throw new AdapterError("E_NOT_FOUND", `Unknown nodeId ${nodeId}`, { protocol: "opcua" });
      return {
        nodeId: id,
        value: node.value,
        dataType: node.dataType,
        nodeClass: node.nodeClass,
        statusCode: "Good",
        sourceTimestamp: new Date().toISOString(),
        sessionId,
        subscription: "once",
        publishingIntervalMs: 0,
        note: "one-shot read; no monitored item",
      };
    },
    async createMonitoredItem(nodeId) {
      const id = resolveId(nodeId);
      if (!nodes.has(id)) throw new AdapterError("E_NOT_FOUND", `Unknown nodeId ${nodeId}`, { protocol: "opcua" });
      if (!monitors.has(id)) monitors.set(id, []);
      return { nodeId: id, monitoredItemId: `mon-${monSeq++}` };
    },
    waitDataChange(nodeId, timeoutMs) {
      const id = resolveId(nodeId);
      if (!nodes.has(id)) {
        return Promise.reject(new AdapterError("E_NOT_FOUND", `Unknown nodeId ${nodeId}`, { protocol: "opcua" }));
      }
      if (!monitors.has(id)) monitors.set(id, []);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new AdapterError("E_TIMEOUT", `OPC-UA data change timeout for ${id}`, { protocol: "opcua" })),
          timeoutMs,
        );
        const list = monitors.get(id) ?? [];
        list.push((node) => {
          clearTimeout(timer);
          resolve({
            nodeId: id,
            value: node.value,
            dataType: node.dataType,
            statusCode: "Good",
            sessionId,
            subscription: "monitored",
            sourceTimestamp: new Date().toISOString(),
          });
        });
        monitors.set(id, list);
      });
    },
    async deleteMonitoredItem(nodeId) {
      const id = resolveId(nodeId);
      monitors.delete(id);
      return { nodeId: id, deleted: true as const };
    },
    async close() {
      nodes.clear();
      monitors.clear();
    },
  };
}

export async function tcpHello(endpoint: string): Promise<{
  ok: boolean;
  messageType: string;
  protocolVersion?: number;
}> {
  const { host, port } = parseEndpoint(endpoint);
  const socket = new Socket();
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.connect({ host, port }, () => resolve());
    });
    const ack = await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("OPC UA Hello timeout")), 4000);
      socket.once("data", (buf) => {
        clearTimeout(timer);
        resolve(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
      });
      socket.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      socket.write(encodeHello(endpoint));
    });
    return decodeAck(ack);
  } finally {
    socket.destroy();
  }
}

/**
 * OPC UA adapter.
 * Default `simulator: true`: in-memory address space (CI).
 * `simulator: false`: node-opcua client session against the endpoint, unless a handle is injected.
 */
export class OpcUaAdapter implements ProtocolAdapter {
  readonly protocol = "opcua";
  private handle: OpcUaHandle | undefined;
  private endpoint = "";
  private connected = false;
  private simulator = true;
  private mode: "simulator" | "hello-session" | "node-opcua" | "injected" = "simulator";
  private helloAck: { ok: boolean; messageType: string; protocolVersion?: number } | undefined;
  private allowWrite = false;

  constructor(
    readonly id: string,
    private readonly connectFn?: OpcUaConnectFn,
    private readonly helloFn?: OpcUaHelloFn,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    const endpoint = stringField(config, "endpoint") ?? stringField(config, "url");
    if (!endpoint) throw new AdapterError("E_INVALID_CONFIG", "OPC-UA adapter requires config.endpoint (opc.tcp://host:port)");
    this.endpoint = endpoint;
    this.allowWrite = allowWriteFrom(config);
    this.simulator = config.simulator !== false;
    this.helloAck = undefined;
    this.mode = "simulator";

    if (this.connectFn) {
      if (!this.simulator && this.helloFn) {
        this.helloAck = await this.helloFn(endpoint);
        this.mode = "injected";
      } else {
        this.mode = "injected";
      }
      this.handle = await this.connectFn(config);
    } else if (this.simulator) {
      this.handle = createOpcUaSimulator(config);
      this.mode = "simulator";
    } else if (this.helloFn) {
      this.helloAck = await this.helloFn(endpoint);
      if (!this.helloAck.ok) {
        throw new AdapterError("E_PROTOCOL", `OPC UA Hello/ACK failed (type=${this.helloAck.messageType || "none"})`, {
          protocol: "opcua",
        });
      }
      this.handle = createOpcUaSimulator(config);
      this.mode = "hello-session";
    } else {
      this.handle = await connectNodeOpcUa(config);
      this.mode = "node-opcua";
    }
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.handle) await this.handle.close();
    this.handle = undefined;
    this.connected = false;
    this.helloAck = undefined;
  }

  async listTools(): Promise<McpToolSchema[]> {
    this.assertConnected();
    return [
      {
        name: "read",
        description: "Read a node (ns=0 i=84 RootFolder etc. or configured nodeId)",
        inputSchema: {
          type: "object",
          properties: { nodeId: { type: "string" } },
          required: ["nodeId"],
          additionalProperties: false,
        },
      },
      {
        name: "write",
        description: "Write a node value (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: {
            nodeId: { type: "string" },
            value: {},
          },
          required: ["nodeId", "value"],
          additionalProperties: false,
        },
      },
      {
        name: "browse",
        description: "Browse references from a node (default RootFolder i=84)",
        inputSchema: {
          type: "object",
          properties: { nodeId: { type: "string" } },
          additionalProperties: false,
        },
      },
      {
        name: "list_nodes",
        description: "List the known address space (standard folders + configured nodes)",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "session_info",
        description: "Session / connection mode (simulator vs node-opcua)",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "create_monitored_item",
        description: "Register a memory monitored item (not a full UA Subscription service set)",
        inputSchema: {
          type: "object",
          properties: { nodeId: { type: "string" } },
          required: ["nodeId"],
          additionalProperties: false,
        },
      },
      {
        name: "wait_data_change",
        description: "Wait until a monitored node is written (simulator / injected)",
        inputSchema: {
          type: "object",
          properties: { nodeId: { type: "string" }, timeoutMs: { type: "integer", default: 1500 } },
          required: ["nodeId"],
          additionalProperties: false,
        },
      },
      {
        name: "delete_monitored_item",
        description: "Drop a memory monitored item",
        inputSchema: {
          type: "object",
          properties: { nodeId: { type: "string" } },
          required: ["nodeId"],
          additionalProperties: false,
        },
      },
      {
        name: "subscribe_once",
        description: "One-shot value (not a monitored-item subscription)",
        inputSchema: {
          type: "object",
          properties: {
            nodeId: { type: "string" },
            timeoutMs: { type: "integer" },
          },
          required: ["nodeId"],
          additionalProperties: false,
        },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const handle = this.handle!;
    if (toolName === "session_info") {
      return {
        endpoint: this.endpoint,
        simulator: this.simulator,
        mode: this.mode,
        sessionId: handle.sessionId,
        hello: this.helloAck,
        standardNodes: STANDARD_NODES,
      };
    }
    if (toolName === "list_nodes") {
      const nodes = await handle.list();
      return { endpoint: this.endpoint, mode: this.mode, nodes };
    }
    if (toolName === "read") return handle.read(requiredString(args, "nodeId"));
    if (toolName === "create_monitored_item") {
      if (!handle.createMonitoredItem) {
        throw new AdapterError("E_UNSUPPORTED", "OPC-UA handle has no monitored items", { protocol: "opcua" });
      }
      return handle.createMonitoredItem(requiredString(args, "nodeId"));
    }
    if (toolName === "wait_data_change") {
      if (!handle.waitDataChange) {
        throw new AdapterError("E_UNSUPPORTED", "OPC-UA handle has no wait_data_change", { protocol: "opcua" });
      }
      const ms = typeof args.timeoutMs === "number" && args.timeoutMs > 0 ? args.timeoutMs : 1500;
      return handle.waitDataChange(requiredString(args, "nodeId"), ms);
    }
    if (toolName === "delete_monitored_item") {
      if (!handle.deleteMonitoredItem) {
        throw new AdapterError("E_UNSUPPORTED", "OPC-UA handle has no delete_monitored_item", { protocol: "opcua" });
      }
      return handle.deleteMonitoredItem(requiredString(args, "nodeId"));
    }
    if (toolName === "subscribe_once") {
      const nodeId = requiredString(args, "nodeId");
      if (handle.subscribeOnce) return handle.subscribeOnce(nodeId);
      const current = await handle.read(nodeId);
      return {
        ...(typeof current === "object" && current ? current : { value: current }),
        subscription: "once",
        note: "one-shot read; no monitored item",
      };
    }
    if (toolName === "write") {
      assertCanWrite("opcua", this.allowWrite);
      return handle.write(requiredString(args, "nodeId"), args.value);
    }
    if (toolName === "browse") {
      const nodeId = typeof args.nodeId === "string" ? args.nodeId : undefined;
      return handle.browse(nodeId);
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown OPC-UA tool "${toolName}"`, { protocol: "opcua" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    const hello = this.helloAck ? ` HEL/ACK ${this.helloAck.messageType}` : "";
    return {
      ok: true,
      detail: `endpoint=${this.endpoint} mode=${this.mode}${hello} allowWrite=${this.allowWrite} (subscribe_once one-shot; wait_data_change is memory monitored-item)`,
    };
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_NOT_CONNECTED", "OPC-UA adapter is not connected", { protocol: "opcua" });
    }
  }
}
