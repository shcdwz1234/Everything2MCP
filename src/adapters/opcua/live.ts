import { AttributeIds, DataType, OPCUAClient } from "node-opcua";
import { AdapterError } from "../../runtime/errors.js";
import { stringField } from "../helpers.js";
import type { OpcUaHandle, OpcUaNode } from "./types.js";

function inferDataType(value: unknown): DataType {
  if (typeof value === "boolean") return DataType.Boolean;
  if (typeof value === "number") return Number.isInteger(value) ? DataType.Int32 : DataType.Double;
  if (typeof value === "string") return DataType.String;
  return DataType.Variant;
}

/**
 * Real node-opcua client: connect to endpoint URL, create a session, browse/read/write.
 * Used when `simulator: false` and no handle is injected.
 */
export async function connectNodeOpcUa(config: Record<string, unknown>): Promise<OpcUaHandle> {
  const endpoint = stringField(config, "endpoint") ?? stringField(config, "url");
  if (!endpoint) {
    throw new AdapterError("E_INVALID_CONFIG", "OPC-UA live client requires config.endpoint");
  }
  const client = OPCUAClient.create({
    endpointMustExist: false,
    requestedSessionTimeout: typeof config.sessionTimeoutMs === "number" ? config.sessionTimeoutMs : 60_000,
  });
  await client.connect(endpoint);
  const user = stringField(config, "username") ?? stringField(config, "user");
  const password = stringField(config, "password");
  const session = user
    ? await client.createSession({ type: 1, userName: user, password: password ?? "" } as never)
    : await client.createSession();
  const sessionId = String((session as { sessionId?: { toString(): string } }).sessionId ?? "session");

  async function browseNodes(nodeId?: string) {
    const id = nodeId && nodeId !== "RootFolder" ? nodeId : "RootFolder";
    const result = await session.browse(id);
    const refs = (result.references ?? []).map((r) => ({
      nodeId: r.nodeId.toString(),
      browseName: r.browseName?.toString?.() ?? "",
      displayName: r.displayName?.text ?? r.browseName?.toString?.() ?? "",
      nodeClass: r.nodeClass !== undefined ? String(r.nodeClass) : "Unspecified",
      hasValue: true,
    }));
    return { nodeId: id, references: refs, sessionId };
  }

  return {
    sessionId,
    async read(nodeId) {
      const dv = await session.read({ nodeId, attributeId: AttributeIds.Value });
      const status = dv.statusCode?.toString?.() ?? String(dv.statusCode);
      if (dv.statusCode && !dv.statusCode.isGood?.()) {
        throw new AdapterError("E_PROTOCOL", `OPC UA read ${nodeId}: ${status}`, { protocol: "opcua" });
      }
      return {
        nodeId,
        value: dv.value?.value,
        dataType: DataType[dv.value?.dataType as DataType] ?? String(dv.value?.dataType ?? ""),
        statusCode: status || "Good",
        sourceTimestamp: dv.sourceTimestamp?.toISOString?.() ?? new Date().toISOString(),
        sessionId,
      };
    },
    async write(nodeId, value) {
      const status = await session.write({
        nodeId,
        attributeId: AttributeIds.Value,
        value: {
          value: { dataType: inferDataType(value), value },
        },
      } as never);
      const text = typeof status === "object" && status && "toString" in status ? String(status) : "Good";
      return { nodeId, value, statusCode: text, sessionId };
    },
    async browse(nodeId) {
      return browseNodes(nodeId);
    },
    async list() {
      const root = await browseNodes("RootFolder");
      const nodes: OpcUaNode[] = root.references.map((r) => ({
        nodeId: r.nodeId,
        value: null,
        displayName: r.displayName,
        browseName: r.browseName,
        nodeClass: r.nodeClass,
        dataType: "Variant",
      }));
      return nodes;
    },
    async subscribeOnce(nodeId) {
      const dv = await session.read({ nodeId, attributeId: AttributeIds.Value });
      const status = dv.statusCode?.toString?.() ?? String(dv.statusCode);
      return {
        nodeId,
        value: dv.value?.value,
        dataType: DataType[dv.value?.dataType as DataType] ?? String(dv.value?.dataType ?? ""),
        statusCode: status || "Good",
        sourceTimestamp: dv.sourceTimestamp?.toISOString?.() ?? new Date().toISOString(),
        sessionId,
        subscription: "once",
        note: "one-shot read; no monitored item",
      };
    },
    async close() {
      try {
        await session.close();
      } finally {
        await client.disconnect();
      }
    },
  };
}
