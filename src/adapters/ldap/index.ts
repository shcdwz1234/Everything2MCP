import { Attribute, Change, Client } from "ldapts";
import { AdapterError } from "../../runtime/errors.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { requiredString, stringArray, stringField } from "../helpers.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";

export interface LdapSearchOptions {
  attributes?: string[];
  pageSize?: number;
  cookie?: string;
}

export interface LdapSearchResult {
  entries: unknown[];
  cookie?: string;
  pageSize?: number;
}

export type LdapModifyOp = "add" | "replace" | "delete";

export interface LdapModifyChange {
  operation: LdapModifyOp;
  attribute: string;
  values?: string[];
}

export interface LdapHandle {
  bind(dn: string, password: string): Promise<void>;
  saslBind?(mechanism: string, credentials: { dn?: string; password?: string }): Promise<void>;
  search(base: string, filter: string, scope: string, options?: LdapSearchOptions): Promise<LdapSearchResult>;
  compare(dn: string, attribute: string, value: string): Promise<boolean>;
  add(dn: string, attributes: Record<string, unknown>): Promise<void>;
  modify(dn: string, changes: LdapModifyChange[]): Promise<void>;
  del(dn: string): Promise<void>;
  close(): Promise<void>;
}

export type LdapConnectFn = (config: Record<string, unknown>) => Promise<LdapHandle>;

function ldapUrl(config: Record<string, unknown>): string {
  return stringField(config, "url") ?? stringField(config, "endpoint") ?? "";
}

function jsonSafe(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = jsonSafe(v);
    return out;
  }
  return value;
}

function pickAttributes(entry: unknown, attributes?: string[]): unknown {
  if (!attributes?.length || attributes.includes("*") || !entry || typeof entry !== "object") return entry;
  const rec = entry as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof rec.dn === "string") out.dn = rec.dn;
  for (const a of attributes) {
    if (a === "dn" || a === "*") continue;
    if (a in rec) out[a] = rec[a];
    else out[a] = null;
  }
  return out;
}

async function defaultConnect(config: Record<string, unknown>): Promise<LdapHandle> {
  let url = ldapUrl(config);
  const starttls = config.starttls === true;
  const rejectUnauthorized = config.rejectUnauthorized !== false;
  if (config.tls === true && url.startsWith("ldap://")) {
    url = `ldaps://${url.slice("ldap://".length)}`;
  }
  const client = new Client({
    url,
    tlsOptions: { rejectUnauthorized },
  });
  if (starttls) await client.startTLS({ rejectUnauthorized });
  const bindDN = stringField(config, "bindDN") ?? stringField(config, "dn") ?? "";
  const password = stringField(config, "password") ?? stringField(config, "bindPassword") ?? "";
  if (bindDN) await client.bind(bindDN, password);
  return {
    async bind(dn, pass) {
      await client.bind(dn, pass);
    },
    async saslBind(mechanism, credentials) {
      if (mechanism.toUpperCase() !== "PLAIN") {
        throw new AdapterError(
          "E_UNSUPPORTED",
          `LDAP SASL ${mechanism} is not implemented (PLAIN only; no GSSAPI/DIGEST-MD5)`,
          { protocol: "ldap" },
        );
      }
      const dn = credentials.dn ?? "";
      const password = credentials.password ?? "";
      if (!dn) throw new AdapterError("E_INVALID_ARGUMENT", "SASL PLAIN needs credentials.dn", { protocol: "ldap" });
      await client.bind(dn, password);
    },
    async search(base, filter, scope, options) {
      const allowed = ["base", "one", "sub", "children", "subordinates"] as const;
      const resolved = allowed.includes(scope as (typeof allowed)[number])
        ? (scope as (typeof allowed)[number])
        : "sub";
      const pageSize = options?.pageSize;
      const { searchEntries } = await client.search(base, {
        filter,
        scope: resolved,
        attributes: options?.attributes,
        ...(pageSize ? { paged: { pageSize }, sizeLimit: pageSize } : {}),
      });
      const entries = searchEntries.map((e) => pickAttributes(jsonSafe(e), options?.attributes));
      return { entries, pageSize, cookie: undefined };
    },
    async compare(dn, attribute, value) {
      return client.compare(dn, attribute, value);
    },
    async add(dn, attributes) {
      await client.add(dn, ldapAddAttributes(attributes));
    },
    async modify(dn, changes) {
      await client.modify(
        dn,
        changes.map(
          (c) =>
            new Change({
              operation: c.operation,
              modification: new Attribute({ type: c.attribute, values: c.values ?? [] }),
            }),
        ),
      );
    },
    async del(dn) {
      await client.del(dn);
    },
    async close() {
      try {
        await client.unbind();
      } catch {
        /* already closed */
      }
    },
  };
}

export class LdapAdapter implements ProtocolAdapter {
  readonly protocol = "ldap";
  private handle: LdapHandle | undefined;
  private url = "";
  private base = "";
  private connected = false;
  private bound = false;
  private tls = false;
  private starttls = false;
  private allowWrite = false;

  constructor(
    readonly id: string,
    private readonly connectFn: LdapConnectFn = defaultConnect,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    const url = ldapUrl(config);
    if (!url) throw new AdapterError("E_INVALID_CONFIG", "LDAP adapter requires config.url (e.g. ldap://127.0.0.1:389)");
    this.url = url;
    this.base = stringField(config, "base") ?? stringField(config, "baseDN") ?? "";
    this.tls = config.tls === true || url.startsWith("ldaps://");
    this.starttls = config.starttls === true;
    this.handle = await this.connectFn({ ...config, url });
    this.bound = Boolean(stringField(config, "bindDN") ?? stringField(config, "dn"));
    this.allowWrite = allowWriteFrom(config);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.handle) await this.handle.close();
    this.handle = undefined;
    this.connected = false;
    this.bound = false;
  }

  async listTools(): Promise<McpToolSchema[]> {
    this.assertConnected();
    return [
      {
        name: "bind",
        description: "Simple bind (DN + password)",
        inputSchema: {
          type: "object",
          properties: {
            dn: { type: "string" },
            password: { type: "string" },
          },
          required: ["dn", "password"],
          additionalProperties: false,
        },
      },
      {
        name: "sasl_bind",
        description: "SASL bind. PLAIN maps to simple bind. GSSAPI/DIGEST-MD5 → E_UNSUPPORTED.",
        inputSchema: {
          type: "object",
          properties: {
            mechanism: { type: "string", default: "PLAIN" },
            dn: { type: "string" },
            password: { type: "string" },
          },
          required: ["dn", "password"],
          additionalProperties: false,
        },
      },
      {
        name: "search",
        description: "LDAP search with optional attribute filter and pageSize",
        inputSchema: {
          type: "object",
          properties: {
            base: { type: "string" },
            filter: { type: "string", default: "(objectClass=*)" },
            scope: { type: "string", description: "base | one | sub", default: "sub" },
            attributes: { type: "array", items: { type: "string" } },
            pageSize: { type: "integer" },
            cookie: { type: "string", description: "Opaque page cursor from a previous search" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "compare",
        description: "LDAP compare of a single attribute value",
        inputSchema: {
          type: "object",
          properties: {
            dn: { type: "string" },
            attribute: { type: "string" },
            value: { type: "string" },
          },
          required: ["dn", "attribute", "value"],
          additionalProperties: false,
        },
      },
      {
        name: "add",
        description: "LDAP add an entry. Requires config.allowWrite=true",
        inputSchema: {
          type: "object",
          properties: {
            dn: { type: "string" },
            attributes: { type: "object", additionalProperties: true },
          },
          required: ["dn", "attributes"],
          additionalProperties: false,
        },
      },
      {
        name: "modify",
        description: "LDAP modify (add/replace/delete attribute). Requires config.allowWrite=true",
        inputSchema: {
          type: "object",
          properties: {
            dn: { type: "string" },
            changes: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  operation: { type: "string", enum: ["add", "replace", "delete"] },
                  attribute: { type: "string" },
                  values: { type: "array", items: { type: "string" } },
                },
                required: ["operation", "attribute"],
              },
            },
          },
          required: ["dn", "changes"],
          additionalProperties: false,
        },
      },
      {
        name: "delete",
        description: "LDAP delete an entry. Requires config.allowWrite=true",
        inputSchema: {
          type: "object",
          properties: { dn: { type: "string" } },
          required: ["dn"],
          additionalProperties: false,
        },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const handle = this.handle!;
    if (toolName === "bind") {
      await handle.bind(requiredString(args, "dn"), requiredString(args, "password"));
      this.bound = true;
      return { ok: true, bound: true };
    }
    if (toolName === "sasl_bind") {
      const mechanism = (typeof args.mechanism === "string" && args.mechanism.trim()
        ? args.mechanism.trim()
        : "PLAIN"
      ).toUpperCase();
      const dn = requiredString(args, "dn");
      const password = requiredString(args, "password");
      if (mechanism !== "PLAIN") {
        throw new AdapterError(
          "E_UNSUPPORTED",
          `LDAP SASL ${mechanism} is not implemented (PLAIN only; no GSSAPI/DIGEST-MD5)`,
          { protocol: "ldap" },
        );
      }
      if (handle.saslBind) await handle.saslBind(mechanism, { dn, password });
      else await handle.bind(dn, password);
      this.bound = true;
      return { ok: true, bound: true, mechanism, note: "PLAIN mapped to simple bind" };
    }
    if (toolName === "search") {
      const base = typeof args.base === "string" && args.base.trim() ? args.base.trim() : this.base;
      if (!base) throw new AdapterError("E_INVALID_ARGUMENT", "search requires base (or config.base)");
      const filter = typeof args.filter === "string" && args.filter.trim() ? args.filter.trim() : "(objectClass=*)";
      const scope = typeof args.scope === "string" ? args.scope : "sub";
      const attributes = stringArray(args.attributes);
      const pageSize = typeof args.pageSize === "number" ? args.pageSize : undefined;
      const cookie = typeof args.cookie === "string" ? args.cookie : undefined;
      const result = await handle.search(base, filter, scope, {
        attributes: attributes.length ? attributes : undefined,
        pageSize,
        cookie,
      });
      const entries = result.entries.map((e) => pickAttributes(e, attributes.length ? attributes : undefined));
      return {
        base,
        filter,
        scope,
        attributes: attributes.length ? attributes : undefined,
        count: entries.length,
        cookie: result.cookie,
        pageSize: result.pageSize ?? pageSize,
        entries,
      };
    }
    if (toolName === "compare") {
      const matched = await handle.compare(
        requiredString(args, "dn"),
        requiredString(args, "attribute"),
        requiredString(args, "value"),
      );
      return { matched };
    }
    if (toolName === "add") {
      assertCanWrite("ldap", this.allowWrite);
      const attributes = args.attributes && typeof args.attributes === "object" && !Array.isArray(args.attributes)
        ? (args.attributes as Record<string, unknown>)
        : {};
      if (!Object.keys(attributes).length) {
        throw new AdapterError("E_INVALID_ARGUMENT", "add requires a non-empty attributes object", { protocol: "ldap" });
      }
      const dn = requiredString(args, "dn");
      await handle.add(dn, attributes);
      return { ok: true, dn, op: "add" };
    }
    if (toolName === "modify") {
      assertCanWrite("ldap", this.allowWrite);
      const dn = requiredString(args, "dn");
      const changes = parseLdapChanges(args.changes);
      await handle.modify(dn, changes);
      return { ok: true, dn, op: "modify", changeCount: changes.length };
    }
    if (toolName === "delete") {
      assertCanWrite("ldap", this.allowWrite);
      const dn = requiredString(args, "dn");
      await handle.del(dn);
      return { ok: true, dn, op: "delete" };
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown LDAP tool "${toolName}"`, { protocol: "ldap" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return {
      ok: true,
      detail: `url=${this.url} bound=${this.bound} tls=${this.tls} starttls=${this.starttls} allowWrite=${this.allowWrite} sasl=PLAIN`,
    };
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_NOT_CONNECTED", "LDAP adapter is not connected", { protocol: "ldap" });
    }
  }
}

function ldapAddAttributes(attributes: Record<string, unknown>): Record<string, string | string[]> {
  const rec: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(attributes)) {
    if (typeof v === "string") rec[k] = v;
    else if (Array.isArray(v)) rec[k] = v.filter((x): x is string => typeof x === "string");
  }
  return rec;
}

function parseLdapChanges(raw: unknown): LdapModifyChange[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new AdapterError("E_INVALID_ARGUMENT", "modify requires a non-empty changes array", { protocol: "ldap" });
  }
  return raw.map((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new AdapterError("E_INVALID_ARGUMENT", `modify.changes[${i}] must be an object`, { protocol: "ldap" });
    }
    const rec = item as Record<string, unknown>;
    const operation = rec.operation;
    if (operation !== "add" && operation !== "replace" && operation !== "delete") {
      throw new AdapterError("E_INVALID_ARGUMENT", `modify.changes[${i}].operation must be add|replace|delete`, {
        protocol: "ldap",
      });
    }
    const attribute = rec.attribute;
    if (typeof attribute !== "string" || !attribute.trim()) {
      throw new AdapterError("E_INVALID_ARGUMENT", `modify.changes[${i}].attribute is required`, { protocol: "ldap" });
    }
    const values = Array.isArray(rec.values) ? rec.values.filter((x): x is string => typeof x === "string") : [];
    return { operation, attribute: attribute.trim(), values };
  });
}
