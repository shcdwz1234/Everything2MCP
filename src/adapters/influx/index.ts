import { AdapterError } from "../../runtime/errors.js";
import { fetchSafe } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";
import { stringField } from "../helpers.js";

export interface InfluxPoint {
  measurement: string;
  tags: Record<string, string>;
  fields: Record<string, string | number | boolean>;
  timestamp?: string;
  bucket: string;
}

export interface InfluxDeleteRequest {
  start: string;
  stop: string;
  predicate?: string;
  bucket: string;
}

export interface InfluxHandle {
  write(lines: string, bucket: string): Promise<{ written: number }>;
  query(flux: string): Promise<unknown>;
  delete(req: InfluxDeleteRequest): Promise<{ deleted: number; note?: string }>;
  close(): Promise<void>;
}

export type InfluxConnectFn = (config: Record<string, unknown>) => Promise<InfluxHandle>;

/** Minimal Influx line protocol: measurement[,tags] fields [timestamp] */
export function parseLineProtocol(line: string): Omit<InfluxPoint, "bucket"> | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) return undefined;
  const ident = parts[0]!;
  const fieldPart = parts[1]!;
  const timestamp = parts[2];
  const [measurement, ...tagParts] = ident.split(",");
  if (!measurement) return undefined;
  const tags: Record<string, string> = {};
  for (const t of tagParts) {
    const eq = t.indexOf("=");
    if (eq > 0) tags[t.slice(0, eq)] = t.slice(eq + 1);
  }
  const fields: Record<string, string | number | boolean> = {};
  for (const f of fieldPart.split(",")) {
    const eq = f.indexOf("=");
    if (eq < 0) continue;
    const k = f.slice(0, eq);
    const v = f.slice(eq + 1);
    if (v === "true" || v === "false") fields[k] = v === "true";
    else if (/^-?\d+i$/.test(v)) fields[k] = Number(v.slice(0, -1));
    else if (v.startsWith('"') && v.endsWith('"')) fields[k] = v.slice(1, -1);
    else {
      const n = Number(v);
      fields[k] = Number.isFinite(n) && v !== "" ? n : v;
    }
  }
  if (Object.keys(fields).length === 0) return undefined;
  return { measurement, tags, fields, timestamp };
}

export function formatLineProtocol(point: {
  measurement: string;
  tags?: Record<string, string>;
  fields: Record<string, string | number | boolean>;
  timestamp?: string | number;
}): string {
  const tags = Object.entries(point.tags ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  const ident = tags ? `${point.measurement},${tags}` : point.measurement;
  const fields = Object.entries(point.fields)
    .map(([k, v]) => {
      if (typeof v === "string") return `${k}="${v.replace(/"/g, '\\"')}"`;
      if (typeof v === "boolean") return `${k}=${v}`;
      if (Number.isInteger(v)) return `${k}=${v}i`;
      return `${k}=${v}`;
    })
    .join(",");
  return point.timestamp === undefined || point.timestamp === ""
    ? `${ident} ${fields}`
    : `${ident} ${fields} ${point.timestamp}`;
}

function extractFluxBucket(flux: string): string | undefined {
  return /from\(\s*bucket:\s*"([^"]+)"/.exec(flux)?.[1];
}

function extractFluxMeasurement(flux: string): string | undefined {
  return /_measurement\s*==\s*"([^"]+)"/.exec(flux)?.[1];
}

/** Influx 2 delete predicate subset: `_measurement="cpu" AND host="a"` (equals only). */
export function matchDeletePredicate(point: InfluxPoint, predicate?: string): boolean {
  if (!predicate || !predicate.trim()) return true;
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|==)\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(predicate))) {
    const key = m[1]!;
    const val = m[2]!;
    if (key === "_measurement") {
      if (point.measurement !== val) return false;
    } else if ((point.tags[key] ?? "") !== val) {
      return false;
    }
  }
  return true;
}

export function parseTimeBound(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  if (/^-?\d+$/.test(raw.trim())) return Number(raw);
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : undefined;
}

export function createMemoryInflux(defaultBucket: string): InfluxHandle {
  const points: InfluxPoint[] = [];
  return {
    async write(lines, bucket) {
      let written = 0;
      for (const line of lines.split(/\n+/)) {
        const parsed = parseLineProtocol(line);
        if (!parsed) continue;
        points.push({ ...parsed, bucket });
        written += 1;
      }
      return { written };
    },
    async query(flux) {
      const wantBucket = extractFluxBucket(flux);
      const wantMeasurement = extractFluxMeasurement(flux);
      const matched = points.filter((p) => {
        if (wantBucket && p.bucket !== wantBucket) return false;
        if (wantMeasurement && p.measurement !== wantMeasurement) return false;
        return true;
      });
      const records = matched.flatMap((p) =>
        Object.entries(p.fields).map(([field, value]) => ({
          _time: p.timestamp ?? "",
          _measurement: p.measurement,
          _field: field,
          _value: value,
          _bucket: p.bucket,
          ...p.tags,
        })),
      );
      return {
        dialect: "flux-json-compat",
        tables: [{ records }],
        note: "Memory Flux is not a real engine; it filters bucket/measurement literals when present.",
      };
    },
    async delete(req) {
      const start = parseTimeBound(req.start) ?? Number.NEGATIVE_INFINITY;
      const stop = parseTimeBound(req.stop) ?? Number.POSITIVE_INFINITY;
      let deleted = 0;
      for (let i = points.length - 1; i >= 0; i--) {
        const p = points[i]!;
        if (p.bucket !== req.bucket) continue;
        if (!matchDeletePredicate(p, req.predicate)) continue;
        const t = parseTimeBound(p.timestamp) ?? 0;
        if (t < start || t >= stop) continue;
        points.splice(i, 1);
        deleted += 1;
      }
      return { deleted };
    },
    async close() {
      points.length = 0;
    },
  };
}

function mapFetchError(err: unknown, timeoutMs: number, protocol: string): never {
  if (err instanceof AdapterError) throw err;
  const name = err instanceof Error ? err.name : "";
  const msg = err instanceof Error ? err.message : String(err);
  if (name === "AbortError" || /abort|timeout/i.test(msg)) {
    throw new AdapterError("E_TIMEOUT", `Influx request timed out after ${timeoutMs}ms`, { protocol });
  }
  throw AdapterError.from(err, "E_PROTOCOL");
}

export function unsignedHttpInflux(
  endpoint: string,
  org: string,
  bucket: string,
  token: string | undefined,
  timeoutMs = 8000,
): InfluxHandle {
  const root = endpoint.replace(/\/+$/, "");
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Token ${token}`;
  return {
    async write(lines, targetBucket) {
      const url = new URL(`${root}/api/v2/write`);
      url.searchParams.set("org", org);
      url.searchParams.set("bucket", targetBucket || bucket);
      let res: Response;
      try {
        res = await fetchSafe(url.toString(), {
          method: "POST",
          headers: { ...headers, "content-type": "text/plain; charset=utf-8" },
          body: lines,
          timeoutMs,
        });
      } catch (err) {
        mapFetchError(err, timeoutMs, "influx");
      }
      if (!res.ok && res.status !== 204) {
        const text = await res.text();
        throw new AdapterError("E_PROTOCOL", `Influx write HTTP ${res.status}: ${text.slice(0, 200)}`, {
          protocol: "influx",
        });
      }
      const written = lines.split(/\n+/).filter((l) => l.trim() && !l.trim().startsWith("#")).length;
      return { written };
    },
    async query(flux) {
      const url = new URL(`${root}/api/v2/query`);
      url.searchParams.set("org", org);
      let res: Response;
      try {
        res = await fetchSafe(url.toString(), {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/vnd.flux",
            accept: "application/json",
          },
          body: flux,
          timeoutMs,
        });
      } catch (err) {
        mapFetchError(err, timeoutMs, "influx");
      }
      const text = await res.text();
      if (!res.ok) {
        throw new AdapterError("E_PROTOCOL", `Influx query HTTP ${res.status}: ${text.slice(0, 200)}`, {
          protocol: "influx",
        });
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return { dialect: "csv", csv: text };
      }
    },
    async delete(req) {
      const url = new URL(`${root}/api/v2/delete`);
      url.searchParams.set("org", org);
      url.searchParams.set("bucket", req.bucket || bucket);
      let res: Response;
      try {
        res = await fetchSafe(url.toString(), {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            start: req.start,
            stop: req.stop,
            predicate: req.predicate ?? "",
          }),
          timeoutMs,
        });
      } catch (err) {
        mapFetchError(err, timeoutMs, "influx");
      }
      if (!res.ok && res.status !== 204) {
        const text = await res.text();
        throw new AdapterError("E_PROTOCOL", `Influx delete HTTP ${res.status}: ${text.slice(0, 200)}`, {
          protocol: "influx",
        });
      }
      return { deleted: 0, note: "Influx /api/v2/delete returns no count" };
    },
    async close() {
      /* http client is stateless */
    },
  };
}

async function defaultConnect(config: Record<string, unknown>): Promise<InfluxHandle> {
  const bucket = stringField(config, "bucket") ?? stringField(config, "bucketName");
  if (!bucket) throw new AdapterError("E_INVALID_CONFIG", "Influx adapter requires config.bucket");
  const org = stringField(config, "org") ?? stringField(config, "organization") ?? "local";
  const endpoint = stringField(config, "url") ?? stringField(config, "endpoint");
  const simulator =
    config.simulator !== false && (!endpoint || endpoint === "memory://" || endpoint.startsWith("memory:"));
  if (simulator) return createMemoryInflux(bucket);
  if (!endpoint) {
    throw new AdapterError("E_INVALID_CONFIG", "Influx live path requires config.url", { protocol: "influx" });
  }
  const timeoutMs = typeof config.timeoutMs === "number" && config.timeoutMs > 0 ? config.timeoutMs : 8000;
  const token = stringField(config, "token");
  return unsignedHttpInflux(endpoint, org, bucket, token, timeoutMs);
}

/**
 * InfluxDB 2-style: write_points (line protocol), delete_points (/api/v2/delete), query (Flux).
 * Memory simulator does not run a real Flux engine. Writes/deletes need allowWrite=true.
 */
export class InfluxAdapter implements ProtocolAdapter {
  readonly protocol = "influx";
  private handle: InfluxHandle | undefined;
  private connected = false;
  private bucket = "";
  private org = "local";
  private allowWrite = false;
  private mode: "memory" | "http" | "injected" = "memory";

  constructor(
    readonly id: string,
    private readonly connectFn: InfluxConnectFn = defaultConnect,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    const bucket = stringField(config, "bucket") ?? stringField(config, "bucketName");
    if (!bucket) throw new AdapterError("E_INVALID_CONFIG", "Influx adapter requires config.bucket");
    this.bucket = bucket;
    this.org = stringField(config, "org") ?? stringField(config, "organization") ?? "local";
    this.allowWrite = allowWriteFrom(config);
    const endpoint = stringField(config, "url") ?? stringField(config, "endpoint");
    this.mode =
      this.connectFn !== defaultConnect
        ? "injected"
        : !endpoint || endpoint.startsWith("memory:")
          ? "memory"
          : "http";
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
        name: "write_points",
        description: "Write line protocol or structured points (requires allowWrite=true). InfluxDB 2 /api/v2/write",
        inputSchema: {
          type: "object",
          properties: {
            lines: { type: "string", description: "Raw line protocol, one point per line" },
            points: {
              type: "array",
              items: { type: "object", additionalProperties: true },
              description: "{ measurement, tags?, fields, timestamp? }",
            },
            bucket: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "delete_points",
        description: "POST /api/v2/delete by time range + predicate (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: {
            start: { type: "string", description: "Inclusive start (unix or RFC3339)" },
            stop: { type: "string", description: "Exclusive stop" },
            predicate: { type: "string", description: '_measurement="cpu" AND host="a"' },
            bucket: { type: "string" },
          },
          required: ["start", "stop"],
          additionalProperties: false,
        },
      },
      {
        name: "query",
        description: "Run a Flux script (not InfluxQL). Memory backend only filters bucket/_measurement literals",
        inputSchema: {
          type: "object",
          properties: {
            flux: { type: "string" },
            query: { type: "string", description: "Alias of flux" },
          },
          additionalProperties: false,
        },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const handle = this.handle!;
    if (toolName === "write_points") {
      assertCanWrite("influx", this.allowWrite);
      const bucket =
        typeof args.bucket === "string" && args.bucket.trim() ? args.bucket.trim() : this.bucket;
      const chunks: string[] = [];
      if (typeof args.lines === "string" && args.lines.trim()) chunks.push(args.lines);
      if (Array.isArray(args.points)) {
        for (const raw of args.points) {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
          const rec = raw as Record<string, unknown>;
          const measurement = typeof rec.measurement === "string" ? rec.measurement : "";
          const fields =
            rec.fields && typeof rec.fields === "object" && !Array.isArray(rec.fields)
              ? (rec.fields as Record<string, string | number | boolean>)
              : undefined;
          if (!measurement || !fields) continue;
          const tags =
            rec.tags && typeof rec.tags === "object" && !Array.isArray(rec.tags)
              ? (rec.tags as Record<string, string>)
              : undefined;
          const timestamp =
            typeof rec.timestamp === "string" || typeof rec.timestamp === "number" ? rec.timestamp : undefined;
          chunks.push(formatLineProtocol({ measurement, tags, fields, timestamp }));
        }
      }
      if (chunks.length === 0) {
        throw new AdapterError("E_INVALID_CONFIG", "write_points requires lines or points[]", { protocol: "influx" });
      }
      return handle.write(chunks.join("\n"), bucket);
    }
    if (toolName === "delete_points") {
      assertCanWrite("influx", this.allowWrite);
      const bucket =
        typeof args.bucket === "string" && args.bucket.trim() ? args.bucket.trim() : this.bucket;
      const start = typeof args.start === "string" ? args.start : "";
      const stop = typeof args.stop === "string" ? args.stop : "";
      if (!start.trim() || !stop.trim()) {
        throw new AdapterError("E_INVALID_CONFIG", "delete_points requires start and stop", { protocol: "influx" });
      }
      return handle.delete({
        start,
        stop,
        predicate: typeof args.predicate === "string" ? args.predicate : undefined,
        bucket,
      });
    }
    if (toolName === "query") {
      const flux =
        (typeof args.flux === "string" && args.flux) ||
        (typeof args.query === "string" && args.query) ||
        "";
      if (!flux.trim()) {
        throw new AdapterError("E_INVALID_CONFIG", "query requires flux (InfluxQL is not implemented)", {
          protocol: "influx",
        });
      }
      return handle.query(flux);
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown Influx tool "${toolName}"`, { protocol: "influx" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return {
      ok: true,
      detail: `bucket=${this.bucket} org=${this.org} mode=${this.mode} allowWrite=${this.allowWrite} (Flux; no InfluxQL)`,
    };
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_NOT_CONNECTED", "Influx adapter is not connected", { protocol: "influx" });
    }
  }
}
