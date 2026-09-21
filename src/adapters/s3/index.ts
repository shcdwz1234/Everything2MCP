import { AdapterError } from "../../runtime/errors.js";
import { fetchSafe } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { signAwsV4 } from "../sigv4.js";
import { allowWriteFrom } from "../sql/common.js";
import { requiredString, stringField } from "../helpers.js";

export interface S3Object {
  key: string;
  size: number;
  body?: string;
  contentType?: string;
  lastModified?: string;
}

export interface S3Handle {
  list(prefix?: string): Promise<S3Object[]>;
  get(key: string): Promise<S3Object>;
  put(key: string, body: string, contentType?: string): Promise<S3Object>;
  delete(key: string): Promise<{ deleted: boolean; key: string }>;
  close(): Promise<void>;
}

export type S3ConnectFn = (config: Record<string, unknown>) => Promise<S3Handle>;

export function createMemoryS3(bucket: string): S3Handle {
  const objects = new Map<string, S3Object>();
  return {
    async list(prefix) {
      return [...objects.values()].filter((o) => (prefix ? o.key.startsWith(prefix) : true));
    },
    async get(key) {
      const found = objects.get(key);
      if (!found) throw new AdapterError("E_NOT_FOUND", `s3://${bucket}/${key} not found`, { protocol: "s3" });
      return { ...found };
    },
    async put(key, body, contentType) {
      const obj: S3Object = {
        key,
        size: Buffer.byteLength(body),
        body,
        contentType: contentType ?? "application/octet-stream",
        lastModified: new Date().toISOString(),
      };
      objects.set(key, obj);
      return { ...obj, body: undefined };
    },
    async delete(key) {
      const deleted = objects.delete(key);
      return { deleted, key };
    },
    async close() {
      objects.clear();
    },
  };
}

function joinUrl(endpoint: string, bucket: string, key?: string): string {
  const base = endpoint.replace(/\/+$/, "");
  if (!key) return `${base}/${encodeURIComponent(bucket)}`;
  const encoded = key.split("/").map(encodeURIComponent).join("/");
  return `${base}/${encodeURIComponent(bucket)}/${encoded}`;
}

function parseListXml(text: string): S3Object[] {
  const out: S3Object[] = [];
  const contents = [...text.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)];
  if (contents.length) {
    for (const block of contents) {
      const key = /<Key>([^<]+)<\/Key>/.exec(block[1] ?? "")?.[1];
      if (!key) continue;
      const sizeRaw = /<Size>([^<]+)<\/Size>/.exec(block[1] ?? "")?.[1];
      out.push({ key, size: Number(sizeRaw ?? 0) || 0 });
    }
    return out;
  }
  const keys = [...text.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1] ?? "");
  return keys.filter(Boolean).map((key) => ({ key, size: 0 }));
}

type S3Signer = (req: { method: string; url: string; body?: string; headers?: Record<string, string> }) => Record<string, string>;

function httpS3(endpoint: string, bucket: string, timeoutMs: number, sign?: S3Signer): S3Handle {
  const headersFor = (method: string, url: string, body?: string, extra?: Record<string, string>) => {
    const base = { ...(extra ?? {}) };
    return sign ? { ...base, ...sign({ method, url, body, headers: extra }) } : base;
  };
  return {
    async list(prefix) {
      const url = new URL(joinUrl(endpoint, bucket));
      url.searchParams.set("list-type", "2");
      if (prefix) url.searchParams.set("prefix", prefix);
      const href = url.toString();
      const res = await fetchSafe(href, { method: "GET", headers: headersFor("GET", href), timeoutMs });
      const text = await res.text();
      if (!res.ok) {
        throw new AdapterError("E_PROTOCOL", `S3 list HTTP ${res.status}: ${text.slice(0, 200)}`, { protocol: "s3" });
      }
      return parseListXml(text);
    },
    async get(key) {
      const href = joinUrl(endpoint, bucket, key);
      const res = await fetchSafe(href, { method: "GET", headers: headersFor("GET", href), timeoutMs });
      const body = await res.text();
      if (res.status === 404) {
        throw new AdapterError("E_NOT_FOUND", `s3://${bucket}/${key} not found`, { protocol: "s3" });
      }
      if (!res.ok) {
        throw new AdapterError("E_PROTOCOL", `S3 get HTTP ${res.status}: ${body.slice(0, 200)}`, { protocol: "s3" });
      }
      return {
        key,
        size: Buffer.byteLength(body),
        body,
        contentType: res.headers.get("content-type") ?? undefined,
      };
    },
    async put(key, body, contentType) {
      const href = joinUrl(endpoint, bucket, key);
      const extra = { "content-type": contentType ?? "application/octet-stream" };
      const res = await fetchSafe(href, {
        method: "PUT",
        headers: headersFor("PUT", href, body, extra),
        body,
        timeoutMs,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new AdapterError("E_PROTOCOL", `S3 put HTTP ${res.status}: ${text.slice(0, 200)}`, { protocol: "s3" });
      }
      return { key, size: Buffer.byteLength(body), contentType };
    },
    async delete(key) {
      const href = joinUrl(endpoint, bucket, key);
      const res = await fetchSafe(href, { method: "DELETE", headers: headersFor("DELETE", href), timeoutMs });
      if (res.status === 404) return { deleted: false, key };
      if (!res.ok && res.status !== 204) {
        const text = await res.text();
        throw new AdapterError("E_PROTOCOL", `S3 delete HTTP ${res.status}: ${text.slice(0, 200)}`, { protocol: "s3" });
      }
      return { deleted: true, key };
    },
    async close() {
      /* http client is stateless */
    },
  };
}

/** Path-style unsigned HTTP — MinIO / LocalStack compatible. */
export function unsignedHttpS3(endpoint: string, bucket: string, timeoutMs = 8000): S3Handle {
  return httpS3(endpoint, bucket, timeoutMs);
}

/** Path-style HTTP with AWS SigV4. */
export function signedHttpS3(
  endpoint: string,
  bucket: string,
  creds: { accessKey: string; secretKey: string; region?: string },
  timeoutMs = 8000,
): S3Handle {
  return httpS3(endpoint, bucket, timeoutMs, (req) =>
    signAwsV4({
      method: req.method,
      url: req.url,
      body: req.body,
      headers: req.headers,
      accessKey: creds.accessKey,
      secretKey: creds.secretKey,
      region: creds.region ?? "us-east-1",
      service: "s3",
    }).headers,
  );
}

async function defaultConnect(config: Record<string, unknown>): Promise<S3Handle> {
  const bucket = stringField(config, "bucket") ?? stringField(config, "bucketName");
  if (!bucket) throw new AdapterError("E_INVALID_CONFIG", "S3 adapter requires config.bucket");
  const endpoint = stringField(config, "endpoint") ?? stringField(config, "url");
  const simulator = config.simulator !== false && (!endpoint || endpoint === "memory://" || endpoint.startsWith("memory:"));
  if (simulator) return createMemoryS3(bucket);
  const timeoutMs = typeof config.timeoutMs === "number" && config.timeoutMs > 0 ? config.timeoutMs : 8000;
  const accessKey = stringField(config, "accessKey") ?? stringField(config, "accessKeyId");
  const secretKey = stringField(config, "secretKey") ?? stringField(config, "secretAccessKey");
  if (config.unsigned === true || config.minio === true) {
    if (!endpoint) throw new AdapterError("E_INVALID_CONFIG", "S3 unsigned HTTP requires config.endpoint", { protocol: "s3" });
    return unsignedHttpS3(endpoint, bucket, timeoutMs);
  }
  if (accessKey && secretKey && endpoint) {
    return signedHttpS3(endpoint, bucket, {
      accessKey,
      secretKey,
      region: stringField(config, "region") ?? "us-east-1",
    }, timeoutMs);
  }
  throw new AdapterError(
    "E_UNSUPPORTED",
    "S3 needs memory://, unsigned=true + endpoint, or accessKey+secretKey+endpoint (SigV4).",
    { protocol: "s3" },
  );
}

/**
 * Object store (S3 / MinIO path-style): list / get / put / delete.
 * Writes require allowWrite=true. Default CI path is an in-memory bucket.
 */
export class S3Adapter implements ProtocolAdapter {
  readonly protocol = "s3";
  private handle: S3Handle | undefined;
  private connected = false;
  private bucket = "";
  private allowWrite = false;
  private mode: "memory" | "unsigned-http" | "sigv4" | "injected" = "memory";

  constructor(
    readonly id: string,
    private readonly connectFn: S3ConnectFn = defaultConnect,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    const bucket = stringField(config, "bucket") ?? stringField(config, "bucketName");
    if (!bucket) throw new AdapterError("E_INVALID_CONFIG", "S3 adapter requires config.bucket");
    this.bucket = bucket;
    this.allowWrite = allowWriteFrom(config);
    const endpoint = stringField(config, "endpoint") ?? stringField(config, "url");
    const accessKey = stringField(config, "accessKey") ?? stringField(config, "accessKeyId");
    this.mode =
      this.connectFn !== defaultConnect
        ? "injected"
        : (config.unsigned === true || config.minio === true) && endpoint && !endpoint.startsWith("memory:")
          ? "unsigned-http"
          : accessKey && endpoint && !endpoint.startsWith("memory:")
            ? "sigv4"
            : "memory";
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
        name: "list",
        description: `List objects in bucket ${this.bucket}`,
        inputSchema: {
          type: "object",
          properties: { prefix: { type: "string" } },
          additionalProperties: false,
        },
      },
      {
        name: "get",
        description: "Get an object body (utf8)",
        inputSchema: {
          type: "object",
          properties: { key: { type: "string" } },
          required: ["key"],
          additionalProperties: false,
        },
      },
      {
        name: "put",
        description: "Put an object (utf8 body). Requires allowWrite=true",
        inputSchema: {
          type: "object",
          properties: {
            key: { type: "string" },
            body: {},
            contentType: { type: "string" },
          },
          required: ["key", "body"],
          additionalProperties: false,
        },
      },
      {
        name: "delete",
        description: "Delete an object. Requires allowWrite=true",
        inputSchema: {
          type: "object",
          properties: { key: { type: "string" } },
          required: ["key"],
          additionalProperties: false,
        },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const handle = this.handle!;
    if (toolName === "list") {
      const prefix = typeof args.prefix === "string" ? args.prefix : undefined;
      const objects = await handle.list(prefix);
      return {
        bucket: this.bucket,
        objects: objects.map(({ body: _body, ...rest }) => rest),
      };
    }
    if (toolName === "get") {
      const obj = await handle.get(requiredString(args, "key"));
      return { bucket: this.bucket, ...obj };
    }
    if (toolName === "put") {
      this.assertCanWrite("put");
      const key = requiredString(args, "key");
      const body = typeof args.body === "string" ? args.body : JSON.stringify(args.body ?? "");
      const contentType = typeof args.contentType === "string" ? args.contentType : undefined;
      const obj = await handle.put(key, body, contentType);
      return { bucket: this.bucket, ...obj };
    }
    if (toolName === "delete") {
      this.assertCanWrite("delete");
      const key = requiredString(args, "key");
      const result = await handle.delete(key);
      return { bucket: this.bucket, ...result };
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown S3 tool "${toolName}"`, { protocol: "s3" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return {
      ok: true,
      detail: `bucket=${this.bucket} mode=${this.mode} allowWrite=${this.allowWrite}`,
    };
  }

  private assertCanWrite(op: string): void {
    if (this.allowWrite) return;
    throw new AdapterError("E_UNSUPPORTED", `Write blocked (config.allowWrite=false): ${op}`, { protocol: "s3" });
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_NOT_CONNECTED", "S3 adapter is not connected", { protocol: "s3" });
    }
  }
}
