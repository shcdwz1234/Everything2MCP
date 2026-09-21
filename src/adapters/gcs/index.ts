import { AdapterError } from "../../runtime/errors.js";
import { fetchSafe } from "../../runtime/ssrf.js";
import type { AdapterHealth } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { stringField } from "../helpers.js";
import {
  allowWriteFrom,
  createMemoryBlobs,
  invokeObjectStore,
  objectStoreToolSchemas,
  type ObjectStoreHandle,
} from "../objectstore.js";

export type GcsConnectFn = (config: Record<string, unknown>) => Promise<ObjectStoreHandle>;

function encodeObject(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

export function createMemoryGcs(bucket: string): ObjectStoreHandle {
  const store = createMemoryBlobs();
  return {
    async list(prefix) {
      return store.list(prefix);
    },
    async get(key) {
      const found = store.get(key);
      if (!found) {
        throw new AdapterError("E_NOT_FOUND", `gs://${bucket}/${key} not found`, { protocol: "gcs" });
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

function authHeaders(token?: string): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** GCS JSON API subset. Optional Bearer token (OAuth minimal). Compatible with fake-gcs-server-style JSON. */
export function unsignedHttpGcs(endpoint: string, bucket: string, timeoutMs = 8000, token?: string): ObjectStoreHandle {
  const root = endpoint.replace(/\/+$/, "");
  const auth = authHeaders(token);
  return {
    async list(prefix) {
      const url = new URL(`${root}/storage/v1/b/${encodeURIComponent(bucket)}/o`);
      if (prefix) url.searchParams.set("prefix", prefix);
      const res = await fetchSafe(url.toString(), { method: "GET", headers: auth, timeoutMs });
      const text = await res.text();
      if (!res.ok) {
        throw new AdapterError("E_PROTOCOL", `GCS list HTTP ${res.status}: ${text.slice(0, 200)}`, { protocol: "gcs" });
      }
      const json = JSON.parse(text) as {
        items?: Array<{ name?: string; size?: string | number; contentType?: string; updated?: string }>;
      };
      return (json.items ?? []).map((item) => ({
        key: item.name ?? "",
        size: Number(item.size ?? 0) || 0,
        contentType: item.contentType,
        lastModified: item.updated,
      }));
    },
    async get(key) {
      const url = `${root}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeObject(key)}?alt=media`;
      const res = await fetchSafe(url, { method: "GET", headers: auth, timeoutMs });
      const body = await res.text();
      if (res.status === 404) {
        throw new AdapterError("E_NOT_FOUND", `gs://${bucket}/${key} not found`, { protocol: "gcs" });
      }
      if (!res.ok) {
        throw new AdapterError("E_PROTOCOL", `GCS get HTTP ${res.status}: ${body.slice(0, 200)}`, { protocol: "gcs" });
      }
      return {
        key,
        size: Buffer.byteLength(body),
        body,
        contentType: res.headers.get("content-type") ?? undefined,
      };
    },
    async put(key, body, contentType) {
      const url = new URL(`${root}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o`);
      url.searchParams.set("uploadType", "media");
      url.searchParams.set("name", key);
      const res = await fetchSafe(url.toString(), {
        method: "POST",
        headers: { "content-type": contentType ?? "application/octet-stream", ...auth },
        body,
        timeoutMs,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new AdapterError("E_PROTOCOL", `GCS put HTTP ${res.status}: ${text.slice(0, 200)}`, { protocol: "gcs" });
      }
      return { key, size: Buffer.byteLength(body), contentType };
    },
    async delete(key) {
      const url = `${root}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeObject(key)}`;
      const res = await fetchSafe(url, { method: "DELETE", headers: auth, timeoutMs });
      if (res.status === 404) return { deleted: false, key };
      if (!res.ok && res.status !== 204) {
        const text = await res.text();
        throw new AdapterError("E_PROTOCOL", `GCS delete HTTP ${res.status}: ${text.slice(0, 200)}`, {
          protocol: "gcs",
        });
      }
      return { deleted: true, key };
    },
    async close() {
      /* http client is stateless */
    },
  };
}

async function defaultConnect(config: Record<string, unknown>): Promise<ObjectStoreHandle> {
  const bucket = stringField(config, "bucket") ?? stringField(config, "bucketName");
  if (!bucket) throw new AdapterError("E_INVALID_CONFIG", "GCS adapter requires config.bucket");
  const endpoint = stringField(config, "endpoint") ?? stringField(config, "url");
  const simulator =
    config.simulator !== false && (!endpoint || endpoint === "memory://" || endpoint.startsWith("memory:"));
  if (simulator) return createMemoryGcs(bucket);
  const timeoutMs = typeof config.timeoutMs === "number" && config.timeoutMs > 0 ? config.timeoutMs : 8000;
  const token = stringField(config, "token") ?? stringField(config, "accessToken");
  if ((config.unsigned === true || config.emulator === true) && endpoint) {
    return unsignedHttpGcs(endpoint, bucket, timeoutMs);
  }
  if (token && endpoint) {
    return unsignedHttpGcs(endpoint, bucket, timeoutMs, token);
  }
  throw new AdapterError(
    "E_UNSUPPORTED",
    "GCS needs memory://, unsigned=true + endpoint, or token/accessToken + endpoint (Bearer).",
    { protocol: "gcs" },
  );
}

/**
 * Google Cloud Storage: list / get / put / delete.
 * Default CI path is in-memory. Writes require allowWrite=true. No OAuth.
 */
export class GcsAdapter implements ProtocolAdapter {
  readonly protocol = "gcs";
  private handle: ObjectStoreHandle | undefined;
  private connected = false;
  private bucket = "";
  private allowWrite = false;
  private mode: "memory" | "unsigned-http" | "oauth" | "injected" = "memory";

  constructor(
    readonly id: string,
    private readonly connectFn: GcsConnectFn = defaultConnect,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    const bucket = stringField(config, "bucket") ?? stringField(config, "bucketName");
    if (!bucket) throw new AdapterError("E_INVALID_CONFIG", "GCS adapter requires config.bucket");
    this.bucket = bucket;
    this.allowWrite = allowWriteFrom(config);
    const endpoint = stringField(config, "endpoint") ?? stringField(config, "url");
    const token = stringField(config, "token") ?? stringField(config, "accessToken");
    this.mode =
      this.connectFn !== defaultConnect
        ? "injected"
        : (config.unsigned === true || config.emulator === true) && endpoint && !endpoint.startsWith("memory:")
          ? "unsigned-http"
          : token && endpoint && !endpoint.startsWith("memory:")
            ? "oauth"
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
    return invokeObjectStore("gcs", this.bucket, this.allowWrite, this.handle!, toolName, args);
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
      throw new AdapterError("E_NOT_CONNECTED", "GCS adapter is not connected", { protocol: "gcs" });
    }
  }
}
