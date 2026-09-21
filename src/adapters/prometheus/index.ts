import { createServer } from "node:http";
import { AdapterError } from "../../runtime/errors.js";
import { fetchSafe } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";
import { requiredString, stringField } from "../helpers.js";
import {
  decodeWriteRequest,
  encodeWriteRequest,
  snappyCompress,
  snappyDecompress,
  type PromSeries,
} from "./wire.js";

export {
  decodeWriteRequest,
  encodeWriteRequest,
  snappyCompress,
  snappyDecompress,
} from "./wire.js";
export type { PromSeries, PromSample } from "./wire.js";

export type PrometheusFetch = (
  url: string,
  init?: RequestInit & { timeoutMs?: number },
) => Promise<Response>;

export interface PrometheusHandle {
  query(expr: string, time?: string): Promise<unknown>;
  queryRange(expr: string, start: string, end: string, step: string): Promise<unknown>;
  remoteWrite?(series: PromSeries[]): Promise<{ written: number }>;
  close(): Promise<void>;
}

export type PrometheusConnectFn = (config: Record<string, unknown>) => Promise<PrometheusHandle>;

function parseProm(json: unknown, expr: string): unknown {
  if (!json || typeof json !== "object") {
    throw new AdapterError("E_PROTOCOL", "Prometheus returned a non-object body", { protocol: "prometheus" });
  }
  const rec = json as Record<string, unknown>;
  if (rec.status === "error") {
    throw new AdapterError("E_PROTOCOL", String(rec.error ?? "Prometheus query error"), {
      protocol: "prometheus",
      details: { expr, errorType: rec.errorType },
    });
  }
  return {
    status: rec.status ?? "success",
    data: rec.data,
    warnings: rec.warnings,
  };
}

function mapFetchError(err: unknown, timeoutMs: number): never {
  if (err instanceof AdapterError) throw err;
  const name = err instanceof Error ? err.name : "";
  const msg = err instanceof Error ? err.message : String(err);
  if (name === "AbortError" || /abort|timeout/i.test(msg)) {
    throw new AdapterError("E_TIMEOUT", `Prometheus request timed out after ${timeoutMs}ms`, {
      protocol: "prometheus",
    });
  }
  throw AdapterError.from(err, "E_PROTOCOL");
}

async function promGet(fetchFn: PrometheusFetch, url: string, expr: string, timeoutMs: number): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, { method: "GET", timeoutMs });
  } catch (err) {
    mapFetchError(err, timeoutMs);
  }
  if (!res.ok) {
    throw new AdapterError("E_PROTOCOL", `Prometheus HTTP ${res.status}`, {
      protocol: "prometheus",
      details: { expr, status: res.status },
    });
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new AdapterError("E_PROTOCOL", "Prometheus returned non-JSON", { protocol: "prometheus" });
  }
  return parseProm(json, expr);
}

export function httpHandle(base: string, fetchFn: PrometheusFetch, timeoutMs = 8000): PrometheusHandle {
  const root = base.replace(/\/+$/, "");
  return {
    async query(expr, time) {
      const url = new URL(`${root}/api/v1/query`);
      url.searchParams.set("query", expr);
      if (time) url.searchParams.set("time", time);
      return promGet(fetchFn, url.toString(), expr, timeoutMs);
    },
    async queryRange(expr, start, end, step) {
      const url = new URL(`${root}/api/v1/query_range`);
      url.searchParams.set("query", expr);
      url.searchParams.set("start", start);
      url.searchParams.set("end", end);
      url.searchParams.set("step", step);
      return promGet(fetchFn, url.toString(), expr, timeoutMs);
    },
    async remoteWrite(series) {
      const proto = encodeWriteRequest(series);
      const body = snappyCompress(proto);
      const url = `${root}/api/v1/write`;
      let res: Response;
      try {
        res = await fetchFn(url, {
          method: "POST",
          headers: {
            "content-type": "application/x-protobuf",
            "content-encoding": "snappy",
            "x-prometheus-remote-write-version": "0.1.0",
          },
          body: new Uint8Array(body),
          timeoutMs,
        });
      } catch (err) {
        mapFetchError(err, timeoutMs);
      }
      if (!res.ok && res.status !== 204) {
        throw new AdapterError("E_PROTOCOL", `Prometheus remote_write HTTP ${res.status}`, {
          protocol: "prometheus",
          details: { status: res.status },
        });
      }
      return { written: series.reduce((n, s) => n + s.samples.length, 0) };
    },
    async close() {
      /* stateless */
    },
  };
}

export function createMemoryProm(): PrometheusHandle {
  const series: PromSeries[] = [];
  const matchName = (expr: string) => {
    const m = expr.match(/__name__\s*=\s*"([^"]+)"/) ?? expr.match(/^([A-Za-z_:][A-Za-z0-9_:]*)\s*(\{|)$/);
    return m?.[1];
  };
  const vector = (expr: string) => {
    const name = matchName(expr);
    const hit = series.filter((s) => !name || s.labels.__name__ === name);
    return {
      status: "success",
      data: {
        resultType: "vector",
        result: hit.map((s) => {
          const last = s.samples[s.samples.length - 1];
          return { metric: s.labels, value: [last?.timestamp ?? 0, String(last?.value ?? 0)] };
        }),
      },
      note: "Memory PromQL is name-only, not a real engine.",
    };
  };
  return {
    async query(expr) {
      return vector(expr);
    },
    async queryRange(expr) {
      const inst = (await vector(expr)) as unknown as {
        data: { result: Array<{ metric: Record<string, string>; value: [number, string] }> };
      };
      return {
        status: "success",
        data: {
          resultType: "matrix",
          result: inst.data.result.map((r) => ({ metric: r.metric, values: [r.value] })),
        },
      };
    },
    async remoteWrite(incoming) {
      for (const s of incoming) series.push({ labels: { ...s.labels }, samples: s.samples.map((x) => ({ ...x })) });
      return { written: incoming.reduce((n, s) => n + s.samples.length, 0) };
    },
    async close() {
      series.length = 0;
    },
  };
}

export async function listenPromRemoteWrite(): Promise<{ port: number; close: () => Promise<void>; store: PrometheusHandle }> {
  const store = createMemoryProm();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/api/v1/write") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        try {
          const raw = Buffer.concat(chunks);
          const proto = snappyDecompress(raw);
          const decoded = decodeWriteRequest(proto);
          void store.remoteWrite?.(decoded);
          res.writeHead(204);
          res.end();
        } catch (err) {
          res.writeHead(400);
          res.end(err instanceof Error ? err.message : String(err));
        }
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/v1/query") {
      void store.query(url.searchParams.get("query") ?? "").then((body) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/-/healthy") {
      res.writeHead(200);
      res.end("Prometheus is Healthy.");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    port: (server.address() as { port: number }).port,
    store,
    close: () =>
      new Promise((r) => {
        server.close(() => r());
        (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      }),
  };
}

/**
 * Prometheus HTTP API: instant (`/api/v1/query`) and range (`/api/v1/query_range`).
 * No local PromQL engine. Timeouts become E_TIMEOUT; PromQL/HTTP errors become E_PROTOCOL.
 */
export class PrometheusAdapter implements ProtocolAdapter {
  readonly protocol = "prometheus";
  private handle: PrometheusHandle | undefined;
  private connected = false;
  private url = "";
  private timeoutMs = 8000;
  private allowWrite = false;

  constructor(
    readonly id: string,
    private readonly connectFn?: PrometheusConnectFn,
    private readonly fetchFn: PrometheusFetch = fetchSafe,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    const url = stringField(config, "url") ?? stringField(config, "baseUrl");
    this.allowWrite = allowWriteFrom(config);
    this.timeoutMs = typeof config.timeoutMs === "number" && config.timeoutMs > 0 ? config.timeoutMs : 8000;
    if (this.connectFn) {
      this.url = (url ?? "injected").replace(/\/+$/, "");
      this.handle = await this.connectFn(config);
    } else if (config.simulator === true) {
      this.url = (url ?? "memory://").replace(/\/+$/, "");
      this.handle = createMemoryProm();
    } else if (!url) {
      throw new AdapterError("E_INVALID_CONFIG", "Prometheus adapter requires config.url (http://host:9090)");
    } else {
      this.url = url.replace(/\/+$/, "");
      this.handle = httpHandle(this.url, this.fetchFn, this.timeoutMs);
    }
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
        name: "query",
        description: "Instant query (GET /api/v1/query)",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            time: { type: "string", description: "RFC3339 or unix timestamp" },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      {
        name: "query_range",
        description: "Range query (GET /api/v1/query_range)",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            start: { type: "string" },
            end: { type: "string" },
            step: { type: "string", default: "15s" },
          },
          required: ["query", "start", "end"],
          additionalProperties: false,
        },
      },
      {
        name: "remote_write",
        description: "POST /api/v1/write protobuf+snappy (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: {
            timeseries: {
              type: "array",
              items: { type: "object", additionalProperties: true },
              description: "{ labels: {__name__, ...}, samples: [{ value, timestamp? }] }",
            },
          },
          required: ["timeseries"],
          additionalProperties: false,
        },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const handle = this.handle!;
    if (toolName === "query") {
      const expr = requiredString(args, "query");
      const time = typeof args.time === "string" ? args.time : undefined;
      return handle.query(expr, time);
    }
    if (toolName === "query_range") {
      const expr = requiredString(args, "query");
      const start = requiredString(args, "start");
      const end = requiredString(args, "end");
      const step = typeof args.step === "string" && args.step.trim() ? args.step : "15s";
      return handle.queryRange(expr, start, end, step);
    }
    if (toolName === "remote_write") {
      assertCanWrite("prometheus", this.allowWrite);
      if (!handle.remoteWrite) {
        throw new AdapterError("E_UNSUPPORTED", "Prometheus handle has no remote_write", { protocol: "prometheus" });
      }
      const raw = Array.isArray(args.timeseries) ? args.timeseries : [];
      const series: PromSeries[] = raw
        .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object" && !Array.isArray(x))
        .map((rec) => {
          const labels =
            rec.labels && typeof rec.labels === "object" && !Array.isArray(rec.labels)
              ? Object.fromEntries(Object.entries(rec.labels as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
              : {};
          const samples = Array.isArray(rec.samples)
            ? rec.samples
                .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === "object")
                .map((s) => ({
                  value: typeof s.value === "number" ? s.value : Number(s.value),
                  timestamp: typeof s.timestamp === "number" ? s.timestamp : Date.now(),
                }))
            : [];
          return { labels, samples };
        });
      if (!series.length) {
        throw new AdapterError("E_INVALID_CONFIG", "remote_write requires timeseries[]", { protocol: "prometheus" });
      }
      return handle.remoteWrite(series);
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown Prometheus tool "${toolName}"`, { protocol: "prometheus" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return { ok: true, detail: `url=${this.url} timeoutMs=${this.timeoutMs}` };
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_NOT_CONNECTED", "Prometheus adapter is not connected", { protocol: "prometheus" });
    }
  }
}
