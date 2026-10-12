import { AdapterError } from "../../runtime/errors.js";
import { stringField } from "../helpers.js";
import type { OpcUaHandle, OpcUaNode } from "./types.js";

type OpcUaMod = typeof import("node-opcua");

async function loadNodeOpcUa(): Promise<OpcUaMod> {
  // Ensure Web Crypto exists for older Node (18) before node-opcua / @peculiar stacks load.
  if (typeof globalThis.Crypto === "undefined") {
    try {
      const { webcrypto } = await import("node:crypto");
      if (webcrypto && typeof webcrypto.getRandomValues === "function") {
        Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true, writable: true });
        if (typeof (globalThis as { Crypto?: unknown }).Crypto === "undefined" && webcrypto.constructor) {
          Object.defineProperty(globalThis, "Crypto", {
            value: webcrypto.constructor,
            configurable: true,
            writable: true,
          });
        }
      }
    } catch {
      // ignore — live connect will surface a clearer error
    }
  }
  try {
    return await import("node-opcua");
  } catch (err) {
    throw new AdapterError(
      "E_UNSUPPORTED",
      `OPC-UA live client needs node-opcua (Node >= 22.13 recommended). Import failed: ${
        err instanceof Error ? err.message : String(err)
      }. Use simulator:true (default) for hermetic CI.`,
      { protocol: "opcua" },
    );
  }
}

function inferDataType(DataType: OpcUaMod["DataType"], value: unknown): number {
  if (typeof value === "boolean") return DataType.Boolean as unknown as number;
  if (typeof value === "number") return (Number.isInteger(value) ? DataType.Int32 : DataType.Double) as unknown as number;
  if (typeof value === "string") return DataType.String as unknown as number;
  return DataType.Variant as unknown as number;
}

/**
 * Real node-opcua client: connect to endpoint URL, create a session, browse/read/write.
 * Used when `simulator: false` and no handle is injected.
 * Lazy-loads node-opcua so simulator/CI paths never pay the engine/Crypto cost.
 */
export async function connectNodeOpcUa(config: Record<string, unknown>): Promise<OpcUaHandle> {
  const endpoint = stringField(config, "endpoint") ?? stringField(config, "url");
  if (!endpoint) {
    throw new AdapterError("E_INVALID_CONFIG", "OPC-UA live client requires config.endpoint");
  }
  const { AttributeIds, DataType, OPCUAClient } = await loadNodeOpcUa();
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
        dataType: (DataType as unknown as Record<number, string>)[dv.value?.dataType as number] ?? String(dv.value?.dataType ?? ""),
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
          value: { dataType: inferDataType(DataType, value), value },
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
        dataType: (DataType as unknown as Record<number, string>)[dv.value?.dataType as number] ?? String(dv.value?.dataType ?? ""),
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