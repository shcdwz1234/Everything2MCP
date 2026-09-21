export interface OpcUaNode {
  nodeId: string;
  value: unknown;
  displayName: string;
  browseName: string;
  nodeClass: string;
  dataType: string;
  parent?: string;
}

export interface OpcUaHandle {
  /** Present on simulator, injected, and node-opcua sessions. */
  sessionId?: string;
  read(nodeId: string): Promise<unknown>;
  write(nodeId: string, value: unknown): Promise<unknown>;
  browse(nodeId?: string): Promise<unknown>;
  list(): Promise<OpcUaNode[]>;
  /** One-shot value (no monitored-item session). Optional on injected handles. */
  subscribeOnce?(nodeId: string, timeoutMs?: number): Promise<unknown>;
  createMonitoredItem?(nodeId: string): Promise<{ nodeId: string; monitoredItemId: string }>;
  waitDataChange?(nodeId: string, timeoutMs: number): Promise<unknown>;
  deleteMonitoredItem?(nodeId: string): Promise<{ nodeId: string; deleted: true }>;
  close(): Promise<void>;
}

export type OpcUaConnectFn = (config: Record<string, unknown>) => Promise<OpcUaHandle>;
export type OpcUaHelloFn = (
  endpoint: string,
) => Promise<{ ok: boolean; messageType: string; protocolVersion?: number }>;
