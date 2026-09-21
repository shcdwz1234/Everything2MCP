import { AdapterError } from "../../runtime/errors.js";
import { fetchSafe } from "../../runtime/ssrf.js";
import type { AdapterHealth } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { signOss } from "../sigv4.js";
import { stringField } from "../helpers.js";
import {
  allowWriteFrom,
  createMemoryBlobs,
  invokeObjectStore,
  objectStoreToolSchemas,
  type ObjectStoreHandle,
} from "../objectstore.js";

export type OssConnectFn = (config: Record<string, unknown>) => Promise<ObjectStoreHandle>;

function joinUrl(endpoint: string, bucket: string, key?: string): string {
  const base = endpoint.replace(/\/+$/, "");
  if (!key) return `${base}/${encodeURIComponent(bucket)}`;
  const encoded = key.split("/").map(encodeURIComponent).join("/");
  return `${base}/${encodeURIComponent(bucket)}/${encoded}`;
}

function parseListXml(text: string): Array<{ key: string; size: number }> {
  const out: Array<{ key: string; size: number }> = [];
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

export function createMemoryOss(bucket: string): ObjectStoreHandle {
  const store = createMemoryBlobs();
  return {
    async list(prefix) {
      return store.list(prefix);
    },
    async get(key) {
      const found = store.get(key);
      if (!found) {
        throw new AdapterError("E_NOT_FOUND", `oss://${bucket}/${key} not found`, { protocol: "oss" });
      }
      return found;
    },
    async put(key, body, contentType) {
      return store.put(key, body, contentType);
    },
    async delete(key) {
      return { deleted: store.delete(key), key };
    },
    async close() {
      store.close();
    },
  };
}

type OssSigner = (req: { method: string; key?: string; contentType?: string }) => Record<string, string>;

function httpOss(endpoint: string, bucket: string, timeoutMs: number, sign?: OssSigner): ObjectStoreHandle {
  const headersFor = (method: string, key?: string, contentType?: string) =>
    sign ? sign({ method, key, contentType }) : contentType ? { "content-type": contentType } : {};
  return {
    async list(prefix) {
      const url = new URL(joinUrl(endpoint, bucket));
      if (prefix) url.searchParams.set("prefix", prefix);
      const res = await fetchSafe(url.toString(), { method: "GET", headers: headersFor("GET"), timeoutMs });
      const text = await res.text();
      if (!res.ok) {
        throw new AdapterError("E_PROTOCOL", `OSS list HTTP ${res.status}: ${text.slice(0, 200)}`, { protocol: "oss" });
      }
      return parseListXml(text);
    },
    async get(key) {
      const res = await fetchSafe(joinUrl(endpoint, bucket, key), {
        method: "GET",
        headers: headersFor("GET", key),
        timeoutMs,
      });
      const body = await res.text();
      if (res.status === 404) {
        throw new AdapterError("E_NOT_FOUND", `oss://${bucket}/${key} not found`, { protocol: "oss" });
      }
      if (!res.ok) {
        throw new AdapterError("E_PROTOCOL", `OSS get HTTP ${res.status}: ${body.slice(0, 200)}`, { protocol: "oss" });
      }
      return {
        key,
        size: Buffer.byteLength(body),
        body,
        contentType: res.headers.get("content-type") ?? undefined,
      };
    },
    async put(key, body, contentType) {
      const type = contentType ?? "application/octet-stream";
      const res = await fetchSafe(joinUrl(endpoint, bucket, key), {
        method: "PUT",
        headers: headersFor("PUT", key, type),
        body,
        timeoutMs,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new AdapterError("E_PROTOCOL", `OSS put HTTP ${res.status}: ${text.slice(0, 200)}`, { protocol: "oss" });
      }
      return { key, size: Buffer.byteLength(body), contentType };
    },
    async delete(key) {
      const res = await fetchSafe(joinUrl(endpoint, bucket, key), {
        method: "DELETE",
        headers: headersFor("DELETE", key),
        timeoutMs,
      });
      if (res.status === 404) return { deleted: false, key };
      if (!res.ok && res.status !== 204) {
        const text = await res.text();
        throw new AdapterError("E_PROTOCOL", `OSS delete HTTP ${res.status}: ${text.slice(0, 200)}`, {
          protocol: "oss",
        });
      }
      return { deleted: true, key };
    },
    async close() {
      /* http client is stateless */
    },
  };
}

/** Aliyun OSS path-style REST subset. No Authorization signature. */
export function unsignedHttpOss(endpoint: string, bucket: string, timeoutMs = 8000): ObjectStoreHandle {
  return httpOss(endpoint, bucket, timeoutMs);
}

export function signedHttpOss(
  endpoint: string,
  bucket: string,
  creds: { accessKey: string; secretKey: string },
  timeoutMs = 8000,
): ObjectStoreHandle {
  return httpOss(endpoint, bucket, timeoutMs, (req) => {
    const date = new Date().toUTCString();
    return signOss({
      method: req.method,
      bucket,
      key: req.key,
      contentType: req.contentType,
      date,
      accessKey: creds.accessKey,
      secretKey: creds.secretKey,
    }).headers;
  });
}

async function defaultConnect(config: Record<string, unknown>): Promise<ObjectStoreHandle> {
  const bucket = stringField(config, "bucket") ?? stringField(config, "bucketName");
  if (!bucket) throw new AdapterError("E_INVALID_CONFIG", "OSS adapter requires config.bucket");
  const endpoint = stringField(config, "endpoint") ?? stringField(config, "url");
  const simulator =
    config.simulator !== false && (!endpoint || endpoint === "memory://" || endpoint.startsWith("memory:"));
  if (simulator) return createMemoryOss(bucket);
  const timeoutMs = typeof config.timeoutMs === "number" && config.timeoutMs > 0 ? config.timeoutMs : 8000;
  const accessKey = stringField(config, "accessKey") ?? stringField(config, "accessKeyId");
  const secretKey = stringField(config, "secretKey") ?? stringField(config, "accessKeySecret");
  if ((config.unsigned === true || config.emulator === true) && endpoint) {
    return unsignedHttpOss(endpoint, bucket, timeoutMs);
  }
  if (accessKey && secretKey && endpoint) {
    return signedHttpOss(endpoint, bucket, { accessKey, secretKey }, timeoutMs);
  }
  throw new AdapterError(
    "E_UNSUPPORTED",
    "OSS needs memory://, unsigned=true + endpoint, or accessKey+secretKey+endpoint (OSS HMAC-SHA1).",
    { protocol: "oss" },
  );
}

/**
 * Aliyun Object Storage Service: list / get / put / delete.
 * Default CI path is in-memory. Writes require allowWrite=true. No OSS signature.
 */
export class OssAdapter implements ProtocolAdapter {
  readonly protocol = "oss";
  private handle: ObjectStoreHandle | undefined;
  private connected = false;
  private bucket = "";
  private allowWrite = false;
  private mode: "memory" | "unsigned-http" | "oss-sign" | "injected" = "memory";

  constructor(
    readonly id: string,
    private readonly connectFn: OssConnectFn = defaultConnect,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    const bucket = stringField(config, "bucket") ?? stringField(config, "bucketName");
    if (!bucket) throw new AdapterError("E_INVALID_CONFIG", "OSS adapter requires config.bucket");
    this.bucket = bucket;
    this.allowWrite = allowWriteFrom(config);
    const endpoint = stringField(config, "endpoint") ?? stringField(config, "url");
    const accessKey = stringField(config, "accessKey") ?? stringField(config, "accessKeyId");
    this.mode =
      this.connectFn !== defaultConnect
        ? "injected"
        : (config.unsigned === true || config.emulator === true) && endpoint && !endpoint.startsWith("memory:")
          ? "unsigned-http"
          : accessKey && endpoint && !endpoint.startsWith("memory:")
            ? "oss-sign"
            : "memory";
    this.handle = await this.connectFn(config);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.handle) await this.handle.close();
    this.handle = undefined;
    this.connected = false;
  }

  async listTools() {
    this.assertConnected();
    return objectStoreToolSchemas(this.bucket);
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    return invokeObjectStore("oss", this.bucket, this.allowWrite, this.handle!, toolName, args);
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return {
      ok: true,
      detail: `bucket=${this.bucket} mode=${this.mode} allowWrite=${this.allowWrite}`,
    };
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_NOT_CONNECTED", "OSS adapter is not connected", { protocol: "oss" });
    }
  }
}
