import { loadText, parseJsonOrYaml } from "../runtime/load.js";
import { AdapterError } from "../runtime/errors.js";
import { assertUrlAllowed } from "../runtime/ssrf.js";
import type { JsonObject } from "../runtime/types.js";
import { sanitizeName } from "./suggest.js";

export type SchemaKind =
  | "openapi"
  | "wsdl"
  | "proto"
  | "graphql"
  | "asyncapi"
  | "odata"
  | "jsonapi"
  | "trpc"
  | "connectrpc";

/** Kinds that are not dedicated adapters — import an OpenAPI export (or gRPC proto) instead. */
export const IMPORT_FIRST_KINDS = ["odata", "jsonapi", "trpc", "connectrpc"] as const;

export interface ImportedSchema {
  kind: SchemaKind;
  protocol: string;
  name: string;
  config: JsonObject;
  title?: string;
  registerable: boolean;
  note?: string;
}

export function detectKind(text: string, hint?: string, source?: string): SchemaKind {
  const h = (hint ?? "").toLowerCase();
  if (h === "openapi" || h === "http" || h === "swagger") return "openapi";
  if (h === "wsdl" || h === "soap") return "wsdl";
  if (h === "connect" || h === "connectrpc") return "connectrpc";
  if (h === "proto" || h === "grpc") return "proto";
  if (h === "graphql" || h === "sdl") return "graphql";
  if (h === "asyncapi") return "asyncapi";
  if (h === "odata") return "odata";
  if (h === "jsonapi" || h === "json:api" || h === "json-api") return "jsonapi";
  if (h === "trpc") return "trpc";
  const src = (source ?? "").toLowerCase();
  if (src.endsWith(".proto")) {
    return /connectrpc/i.test(text) ? "connectrpc" : "proto";
  }
  if (src.endsWith(".wsdl") || src.endsWith(".xml")) {
    if (/<edmx:Edmx|edmx:DataServices/i.test(text)) return "odata";
    if (/<definitions[\s>]|<wsdl:definitions/i.test(text)) return "wsdl";
  }
  if (src.endsWith(".graphql") || src.endsWith(".gql")) return "graphql";
  const trimmed = text.trim();
  if (!trimmed) {
    throw new AdapterError("E_INVALID_CONFIG", "Schema source is empty");
  }
  if (/^\s*asyncapi\s*:/i.test(trimmed) || /"asyncapi"\s*:/.test(trimmed.slice(0, 400))) return "asyncapi";
  if (/^\s*openapi\s*:/i.test(trimmed) || /"openapi"\s*:/.test(trimmed.slice(0, 400))) return "openapi";
  if (/^\s*swagger\s*:/i.test(trimmed) || /"swagger"\s*:/.test(trimmed.slice(0, 400))) return "openapi";
  if (/"jsonapi"\s*:/.test(trimmed.slice(0, 2000))) return "jsonapi";
  if (/<edmx:Edmx|edmx:DataServices/i.test(trimmed)) return "odata";
  if (/"trpc"\s*:/.test(trimmed.slice(0, 2000))) return "trpc";
  if (/"procedures"\s*:/.test(trimmed) && /"type"\s*:\s*"(query|mutation)"/.test(trimmed)) return "trpc";
  if (/connectrpc/i.test(trimmed) && /syntax\s*=\s*"proto|service\s+\w+\s*\{/.test(trimmed)) return "connectrpc";
  if (/<definitions[\s>]|<wsdl:definitions/i.test(trimmed)) return "wsdl";
  if (/syntax\s*=\s*"proto|service\s+\w+\s*\{/.test(trimmed)) return "proto";
  if (/\btype\s+Query\b|\bschema\s*\{/.test(trimmed) && !/openapi|swagger/i.test(trimmed.slice(0, 80))) {
    return "graphql";
  }
  throw new AdapterError(
    "E_INVALID_CONFIG",
    "Could not detect schema kind (openapi, wsdl, proto, graphql, asyncapi, odata, jsonapi, trpc, connectrpc)",
  );
}

export async function importSchema(source: string, kindHint?: string): Promise<ImportedSchema> {
  if (/^https?:\/\//i.test(source)) await assertUrlAllowed(source);
  const { text, href } = await loadText(source);
  if (!text.trim()) {
    throw new AdapterError("E_INVALID_CONFIG", "Schema source is empty");
  }
  const kind = detectKind(text, kindHint, source);
  const origin = href ?? source;

  if (kind === "openapi") {
    const doc = parseObj(text);
    const title = str((doc.info as JsonObject | undefined)?.title) ?? "openapi";
    const baseUrl = baseUrlFromOpenApi(doc, origin);
    return {
      kind,
      protocol: "openapi",
      name: sanitizeName(title),
      config: baseUrl ? { spec: origin, baseUrl } : { spec: origin },
      title,
      registerable: true,
    };
  }
  if (kind === "wsdl") {
    const title = text.match(/name=["']([^"']+)["']/)?.[1] ?? "soap";
    return {
      kind,
      protocol: "soap",
      name: sanitizeName(title),
      config: { wsdl: origin },
      title,
      registerable: true,
    };
  }
  if (kind === "connectrpc") {
    const pkg = text.match(/package\s+([\w.]+)\s*;/)?.[1] ?? "connectrpc";
    return {
      kind,
      protocol: "grpc",
      name: sanitizeName(pkg.replace(/\./g, "-")),
      config: { proto: origin },
      title: pkg,
      registerable: false,
      note: "Connect-RPC is import-first: export OpenAPI from the Connect service, or register grpc with this proto plus config.target. No dedicated connectrpc adapter.",
    };
  }
  if (kind === "proto") {
    const pkg = text.match(/package\s+([\w.]+)\s*;/)?.[1] ?? "grpc";
    return {
      kind,
      protocol: "grpc",
      name: sanitizeName(pkg.replace(/\./g, "-")),
      config: { proto: origin },
      title: pkg,
      registerable: false,
      note: "gRPC also needs config.target (host:port). Pass target when registering, or set reflection=true on a live server.",
    };
  }
  if (kind === "graphql") {
    const looksEndpoint = /"__schema"|queryType/.test(text) || /^https?:\/\//i.test(origin);
    if (looksEndpoint && /^https?:\/\//i.test(origin) && !/\btype\s+Query\b/.test(text)) {
      return {
        kind,
        protocol: "graphql",
        name: sanitizeName("graphql"),
        config: { url: origin },
        registerable: true,
      };
    }
    return {
      kind,
      protocol: "graphql",
      name: sanitizeName("graphql"),
      config: { sdl: text },
      registerable: false,
      note: "GraphQL SDL imported; add config.url for the HTTP endpoint before mcp_add.",
    };
  }
  if (kind === "jsonapi") {
    return importFirst(
      kind,
      "jsonapi",
      "JSON:API is import-first: this document is a payload, not a spec. Export OpenAPI for the JSON:API surface, then schema_import as openapi.",
      origin,
    );
  }
  if (kind === "odata") {
    return importFirst(
      kind,
      "odata",
      "OData EDMX is import-first: many services also expose OpenAPI at /$openapi or /openapi.json — import that. No dedicated odata adapter in this slice.",
      origin,
    );
  }
  if (kind === "trpc") {
    return importFirst(
      kind,
      "trpc",
      "tRPC is import-first: export OpenAPI via trpc-openapi / trpc-to-openapi, then schema_import as openapi. No dedicated trpc adapter.",
      origin,
    );
  }
  const doc = parseObj(text);
  const title = str(doc.id) ?? str((doc.info as JsonObject | undefined)?.title) ?? "asyncapi";
  return {
    kind: "asyncapi",
    protocol: "asyncapi",
    name: sanitizeName(String(title)),
    config: { spec: origin },
    title: String(title),
    registerable: true,
  };
}

function importFirst(kind: SchemaKind, name: string, note: string, origin: string): ImportedSchema {
  const http = /^https?:\/\//i.test(origin);
  return {
    kind,
    protocol: "openapi",
    name: sanitizeName(name),
    config: http ? { spec: origin } : {},
    title: name,
    registerable: false,
    note,
  };
}

function parseObj(text: string): JsonObject {
  try {
    return asObj(parseJsonOrYaml(text));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AdapterError("E_INVALID_CONFIG", `Failed to parse schema: ${msg}`);
  }
}

export function baseUrlFromOpenApi(doc: JsonObject, origin: string): string | undefined {
  const servers = Array.isArray(doc.servers) ? doc.servers : [];
  const first = servers[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) return undefined;
  const rec = first as JsonObject;
  let url = str(rec.url);
  if (!url) return undefined;
  const variables = rec.variables && typeof rec.variables === "object" && !Array.isArray(rec.variables)
    ? (rec.variables as JsonObject)
    : {};
  url = url.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const v = variables[name];
    if (v && typeof v === "object" && !Array.isArray(v) && typeof (v as JsonObject).default === "string") {
      return String((v as JsonObject).default);
    }
    return "";
  });
  try {
    if (/^https?:\/\//i.test(url)) return url.replace(/\/+$/, "");
    if (/^https?:\/\//i.test(origin)) return new URL(url, origin).toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
  return undefined;
}

function asObj(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonObject;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
