import { randomUUID } from "node:crypto";
import { AdapterError } from "../../runtime/errors.js";
import { fetchSafe } from "../../runtime/ssrf.js";
import type { AdapterHealth, JsonObject, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";
import { stringField } from "../helpers.js";
import { parsePartnerManifest, type PartnerManifest, type PartnerOperation } from "./manifest.js";
import { clearPartnerHeartbeat, lastPartnerHeartbeat, touchPartnerHeartbeat } from "./sessions.js";

export class PartnerAdapter implements ProtocolAdapter {
  readonly protocol = "partner";
  private manifest: PartnerManifest | undefined;
  private allowWrite = false;
  private allowDesktop = false;
  private simulator = false;
  private timeoutMs = 8000;
  private simStore: Map<string, unknown> | undefined;

  constructor(readonly id: string) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    this.simulator = config.simulator === true;
    this.allowWrite = allowWriteFrom(config);
    this.allowDesktop = config.allowDesktop === true;
    this.timeoutMs = typeof config.timeoutMs === "number" && config.timeoutMs > 0 ? config.timeoutMs : 8000;
    const rawManifest = config.manifest && typeof config.manifest === "object" ? config.manifest : config;
    this.manifest = coalesceManifest(rawManifest, config);
    if (!this.simulator && this.manifest.invoke.kind === "http" && !this.manifest.invoke.url) {
      throw new AdapterError("E_INVALID_CONFIG", "partner HTTP invoke.url is required unless simulator:true", {
        protocol: "partner",
      });
    }
    if (this.simulator) this.simStore = new Map();
    touchPartnerHeartbeat(this.id);
  }

  async disconnect(): Promise<void> {
    this.manifest = undefined;
    this.simStore = undefined;
    clearPartnerHeartbeat(this.id);
  }

  async listTools(): Promise<McpToolSchema[]> {
    if (!this.manifest) throw new AdapterError("E_NOT_CONNECTED", "partner not connected", { protocol: "partner" });
    return this.manifest.operations.map((op) => ({
      name: op.name,
      description: `[Partner ${this.manifest!.display_name} ${this.manifest!.version}] ${op.description}`,
      inputSchema: op.inputSchema ?? { type: "object", additionalProperties: true },
      annotations: {
        readOnlyHint: op.risk === "readonly",
        destructiveHint: op.risk === "write" || op.risk === "desktop",
      },
      _meta: { ingress: "partner", risk: op.risk, capability_id: this.manifest!.capability_id },
    }));
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.manifest) throw new AdapterError("E_NOT_CONNECTED", "partner not connected", { protocol: "partner" });
    const op = this.manifest.operations.find((o) => o.name === toolName);
    if (!op) throw new AdapterError("E_UNKNOWN_TOOL", `Unknown partner op ${toolName}`, { protocol: "partner" });
    this.assertRisk(op);
    if (this.simulator) return this.invokeSim(op, args);
    if (this.manifest.invoke.kind === "ipc") {
      throw new AdapterError("E_UNSUPPORTED", "Partner IPC invoke is documented but not implemented in v1; use HTTP callback", {
        protocol: "partner",
      });
    }
    const url = this.manifest.invoke.url;
    if (!url) throw new AdapterError("E_INVALID_CONFIG", "partner invoke.url missing", { protocol: "partner" });
    const call_id = randomUUID();
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    const auth = this.manifest.auth;
    if (auth && auth.type !== "none" && auth.token) headers.authorization = `Bearer ${auth.token}`;
    const res = await fetchSafe(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ op: op.name, args, call_id }),
      timeoutMs: this.timeoutMs,
    });
    const text = await res.text();
    let json: unknown = text;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (res.status >= 400) {
      throw new AdapterError("E_PROTOCOL", `partner invoke ${op.name} HTTP ${res.status}: ${text.slice(0, 240)}`, {
        protocol: "partner",
      });
    }
    return mapPartnerResult(json);
  }

  async health(): Promise<AdapterHealth> {
    if (!this.manifest) return { ok: false, detail: "not connected" };
    const ttl = this.manifest.heartbeatTtlMs ?? 0;
    const last = lastPartnerHeartbeat(this.id);
    if (ttl > 0 && last !== undefined && Date.now() - last > ttl) {
      return { ok: false, detail: `heartbeat expired (ttl ${ttl}ms)` };
    }
    return {
      ok: true,
      detail: `partner ${this.manifest.capability_id} ${this.manifest.invoke.kind}${this.simulator ? " simulator" : ""}`,
    };
  }

  private assertRisk(op: PartnerOperation): void {
    if (op.risk === "write") assertCanWrite("partner", this.allowWrite);
    if (op.risk === "desktop") {
      if (!this.allowDesktop) {
        throw new AdapterError(
          "E_UNSUPPORTED",
          "Desktop partner op blocked (config.allowDesktop=false). Never auto-opened from scan.",
          { protocol: "partner" },
        );
      }
    }
  }

  private invokeSim(op: PartnerOperation, args: Record<string, unknown>): unknown {
    const store = this.simStore ?? new Map();
    if (op.name === "list_chats" || op.risk === "readonly") {
      const chats = (store.get("chats") as unknown[]) ?? [];
      return { op: op.name, chats, args };
    }
    if (op.name === "send_message") {
      const messages = (store.get("messages") as unknown[]) ?? [];
      const row = { id: `m-${messages.length + 1}`, ...args };
      messages.push(row);
      store.set("messages", messages);
      return { ok: true, message: row };
    }
    return { ok: true, simulated: true, op: op.name, args };
  }
}

function coalesceManifest(raw: unknown, config: Record<string, unknown>): PartnerManifest {
  if (Array.isArray(config.operations) && typeof config.capability_id === "string") {
    return parsePartnerManifest({
      capability_id: config.capability_id,
      display_name: config.display_name ?? config.capability_id,
      version: config.version ?? "0.0.0",
      operations: config.operations,
      invoke: config.invoke ?? (config.invokeUrl ? { kind: "http", url: config.invokeUrl } : undefined),
      auth: config.auth,
      heartbeatTtlMs: config.heartbeatTtlMs,
      simulator: config.simulator,
    });
  }
  return parsePartnerManifest({ ...(raw as JsonObject), simulator: config.simulator });
}

export function mapPartnerResult(json: unknown): unknown {
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const o = json as Record<string, unknown>;
    if (o.ok === false) {
      const code = typeof o.code === "string" ? o.code : "E_PROTOCOL";
      throw new AdapterError(
        code === "E_NOT_FOUND" || code === "E_AUTH" || code === "E_UNSUPPORTED" || code === "E_INVALID_ARGUMENT"
          ? code
          : "E_PROTOCOL",
        typeof o.error === "string" ? o.error : "partner invoke failed",
        { protocol: "partner" },
      );
    }
    if ("result" in o) return o.result;
  }
  return json;
}

export { parsePartnerManifest, PARTNER_MANIFEST_SCHEMA, manifestToConfig } from "./manifest.js";
export { touchPartnerHeartbeat, lastPartnerHeartbeat, clearPartnerHeartbeat } from "./sessions.js";
