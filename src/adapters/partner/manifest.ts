import { AdapterError } from "../../runtime/errors.js";
import type { JsonObject, McpJsonSchema } from "../../runtime/types.js";

function riskCeilingOf(operations: Array<{ risk?: string }>): "readonly" | "write" | "desktop" {
  if (operations.some((o) => o.risk === "desktop")) return "desktop";
  if (operations.some((o) => o.risk === "write")) return "write";
  return "readonly";
}

export const PARTNER_RISKS = ["readonly", "write", "desktop"] as const;
export type PartnerRisk = (typeof PARTNER_RISKS)[number];

export interface PartnerOperation {
  name: string;
  description: string;
  inputSchema: McpJsonSchema;
  risk: PartnerRisk;
}

export interface PartnerInvokeEndpoint {
  kind: "http" | "ipc";
  url?: string;
  path?: string;
}

export interface PartnerAuth {
  type: "none" | "bearer" | "partner_token";
  token?: string;
}

export interface PartnerManifest {
  capability_id: string;
  display_name: string;
  version: string;
  operations: PartnerOperation[];
  invoke: PartnerInvokeEndpoint;
  auth?: PartnerAuth;
  heartbeatTtlMs?: number;
}

/** JSON Schema for GET /api/partner/v1/schema and drops files. */
export const PARTNER_MANIFEST_SCHEMA: JsonObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://everything2mcp.local/schemas/partner-manifest.v1.json",
  title: "E2MCP Partner Capability Manifest v1",
  type: "object",
  additionalProperties: false,
  required: ["capability_id", "display_name", "version", "operations", "invoke"],
  properties: {
    capability_id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" },
    display_name: { type: "string", minLength: 1, maxLength: 128 },
    version: { type: "string", minLength: 1, maxLength: 64 },
    operations: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "description", "risk"],
        properties: {
          name: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" },
          description: { type: "string" },
          inputSchema: { type: "object" },
          risk: { type: "string", enum: [...PARTNER_RISKS] },
        },
      },
    },
    invoke: {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: {
        kind: { type: "string", enum: ["http", "ipc"] },
        url: { type: "string" },
        path: { type: "string", description: "IPC path (named pipe / socket). HTTP uses url." },
      },
    },
    auth: {
      type: "object",
      additionalProperties: false,
      properties: {
        type: { type: "string", enum: ["none", "bearer", "partner_token"] },
        token: { type: "string" },
      },
    },
    heartbeatTtlMs: { type: "integer", minimum: 0, description: "0 = no expiry" },
  },
};

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function parsePartnerManifest(raw: unknown): PartnerManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AdapterError("E_INVALID_CONFIG", "Partner manifest must be a JSON object", { protocol: "partner" });
  }
  const o = raw as Record<string, unknown>;
  const capability_id = asId(o.capability_id, "capability_id");
  const display_name = asNonEmpty(o.display_name, "display_name");
  const version = asNonEmpty(o.version, "version");
  if (!Array.isArray(o.operations) || o.operations.length === 0) {
    throw new AdapterError("E_INVALID_CONFIG", "Partner manifest.operations must be a non-empty array", {
      protocol: "partner",
    });
  }
  const operations = o.operations.map((item, i) => parseOp(item, i));
  const invoke = parseInvoke(o.invoke, o.simulator === true);
  const auth = parseAuth(o.auth);
  const heartbeatTtlMs =
    typeof o.heartbeatTtlMs === "number" && o.heartbeatTtlMs >= 0 ? Math.floor(o.heartbeatTtlMs) : 60_000;
  return { capability_id, display_name, version, operations, invoke, auth, heartbeatTtlMs };
}

export function manifestToConfig(manifest: PartnerManifest, extra: JsonObject = {}): JsonObject {
  const ceiling = riskCeilingOf(manifest.operations);
  return {
    ...extra,
    ingress: "partner",
    capability_id: manifest.capability_id,
    display_name: manifest.display_name,
    version: manifest.version,
    operations: manifest.operations,
    invoke: manifest.invoke,
    invokeUrl: manifest.invoke.url,
    auth: manifest.auth ?? { type: "none" },
    heartbeatTtlMs: manifest.heartbeatTtlMs ?? 60_000,
    riskCeiling: ceiling,
    allowWrite: extra.allowWrite === true,
    allowDesktop: extra.allowDesktop === true,
  };
}

function parseOp(item: unknown, index: number): PartnerOperation {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new AdapterError("E_INVALID_CONFIG", `operations[${index}] must be an object`, { protocol: "partner" });
  }
  const o = item as Record<string, unknown>;
  const name = asId(o.name, `operations[${index}].name`);
  const description = typeof o.description === "string" ? o.description : name;
  const risk = o.risk;
  if (risk !== "readonly" && risk !== "write" && risk !== "desktop") {
    throw new AdapterError("E_INVALID_CONFIG", `operations[${index}].risk must be readonly|write|desktop`, {
      protocol: "partner",
    });
  }
  const inputSchema =
    o.inputSchema && typeof o.inputSchema === "object" && !Array.isArray(o.inputSchema)
      ? (o.inputSchema as McpJsonSchema)
      : { type: "object", properties: {}, additionalProperties: true };
  return { name, description, inputSchema, risk };
}

function parseInvoke(raw: unknown, simulator: boolean): PartnerInvokeEndpoint {
  if (simulator && (raw === undefined || raw === null)) return { kind: "http" };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AdapterError("E_INVALID_CONFIG", "manifest.invoke must be { kind: http|ipc, url? }", {
      protocol: "partner",
    });
  }
  const o = raw as Record<string, unknown>;
  const kind = o.kind === "ipc" ? "ipc" : o.kind === "http" ? "http" : undefined;
  if (!kind) {
    throw new AdapterError("E_INVALID_CONFIG", "manifest.invoke.kind must be http or ipc", { protocol: "partner" });
  }
  const url = typeof o.url === "string" && o.url.trim() ? o.url.trim() : undefined;
  const path = typeof o.path === "string" && o.path.trim() ? o.path.trim() : undefined;
  if (kind === "http" && !url && !simulator) {
    throw new AdapterError("E_INVALID_CONFIG", "HTTP invoke requires invoke.url", { protocol: "partner" });
  }
  return { kind, url, path };
}

function parseAuth(raw: unknown): PartnerAuth | undefined {
  if (raw === undefined || raw === null) return { type: "none" };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new AdapterError("E_INVALID_CONFIG", "manifest.auth must be an object", { protocol: "partner" });
  }
  const o = raw as Record<string, unknown>;
  const type = o.type === "bearer" || o.type === "partner_token" || o.type === "none" ? o.type : "none";
  const token = typeof o.token === "string" && o.token.trim() ? o.token.trim() : undefined;
  return { type, token };
}

function asId(value: unknown, field: string): string {
  if (typeof value !== "string" || !ID_RE.test(value)) {
    throw new AdapterError("E_INVALID_CONFIG", `${field} must match [A-Za-z0-9_-]{1,64}`, { protocol: "partner" });
  }
  return value;
}

function asNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AdapterError("E_INVALID_CONFIG", `${field} is required`, { protocol: "partner" });
  }
  return value.trim();
}
