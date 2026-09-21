import { AdapterError } from "../../runtime/errors.js";
import { fetchSafe } from "../../runtime/ssrf.js";
import type { AdapterHealth } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { signAzureBlob } from "../sigv4.js";
import { stringField } from "../helpers.js";
import {
  allowWriteFrom,
  createMemoryBlobs,
  invokeObjectStore,
  objectStoreToolSchemas,
  type ObjectStoreHandle,
} from "../objectstore.js";

export type AzureBlobConnectFn = (config: Record<string, unknown>) => Promise<ObjectStoreHandle>;

function joinUrl(endpoint: string, container: string, blob?: string, sas?: string): string {
  const base = endpoint.replace(/\/+$/, "");
  const path = blob
    ? `${base}/${encodeURIComponent(container)}/${blob.split("/").map(encodeURIComponent).join("/")}`
    : `${base}/${encodeURIComponent(container)}`;
  if (!sas) return path;
  const token = sas.replace(/^\?/, "");
  return `${path}${path.includes("?") ? "&" : "?"}${token}`;
}

function parseListXml(text: string): Array<{ key: string; size: number }> {
  const blobs = [...text.matchAll(/<Blob>([\s\S]*?)<\/Blob>/g)];
  const out: Array<{ key: string; size: number }> = [];
  for (const block of blobs) {
    const key = /<Name>([^<]+)<\/Name>/.exec(block[1] ?? "")?.[1];
    if (!key) continue;
    const sizeRaw = /<Content-Length>([^<]+)<\/Content-Length>/.exec(block[1] ?? "")?.[1];
    out.push({ key, size: Number(sizeRaw ?? 0) || 0 });
  }
  return out;
}

export function createMemoryAzureBlob(container: string): ObjectStoreHandle {
  const store = createMemoryBlobs();
  return {
    async list(prefix) {
      return store.list(prefix);
    },
    async get(key) {
      const found = store.get(key);
      if (!found) {
        throw new AdapterError("E_NOT_FOUND", `azure://${container}/${key} not found`, { protocol: "azureblob" });
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

type AzureSigner = (req: { method: string; blob?: string; contentType?: string }) => Record<string, string>;

function httpAzure(
  endpoint: string,
  container: string,
  timeoutMs: number,
  sign?: AzureSigner,
  sas?: string,
): ObjectStoreHandle {
  const headersFor = (method: string, blob?: string, contentType?: string) =>
    sign ? sign({ method, blob, contentType }) : contentType ? { "content-type": contentType } : {};
  return {
    async list(prefix) {
      const url = new URL(joinUrl(endpoint, container, undefined, sas));
      url.searchParams.set("restype", "container");
      url.searchParams.set("comp", "list");
      if (prefix) url.searchParams.set("prefix", prefix);
      const res = await fetchSafe(url.toString(), { method: "GET", headers: headersFor("GET"), timeoutMs });
      const text = await res.text();
      if (!res.ok) {
        throw new AdapterError("E_PROTOCOL", `Azure list HTTP ${res.status}: ${text.slice(0, 200)}`, {
          protocol: "azureblob",
        });
      }
      return parseListXml(text);
    },
    async get(key) {
      const res = await fetchSafe(joinUrl(endpoint, container, key, sas), {
        method: "GET",
        headers: headersFor("GET", key),
        timeoutMs,
      });
      const body = await res.text();
      if (res.status === 404) {
        throw new AdapterError("E_NOT_FOUND", `azure://${container}/${key} not found`, { protocol: "azureblob" });
      }
      if (!res.ok) {
        throw new AdapterError("E_PROTOCOL", `Azure get HTTP ${res.status}: ${body.slice(0, 200)}`, {
          protocol: "azureblob",
        });
      }
      return { key, size: Buffer.byteLength(body), body, contentType: res.headers.get("content-type") ?? undefined };
    },
    async put(key, body, contentType) {
      const res = await fetchSafe(joinUrl(endpoint, container, key, sas), {
        method: "PUT",
        headers: { ...headersFor("PUT", key, contentType), "x-ms-blob-type": "BlockBlob" },
        body,
        timeoutMs,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new AdapterError("E_PROTOCOL", `Azure put HTTP ${res.status}: ${text.slice(0, 200)}`, {
          protocol: "azureblob",
        });
      }
      return { key, size: Buffer.byteLength(body), contentType };
    },
    async delete(key) {
      const res = await fetchSafe(joinUrl(endpoint, container, key, sas), {
        method: "DELETE",
        headers: headersFor("DELETE", key),
        timeoutMs,
      });
      if (res.status === 404) return { deleted: false, key };
      if (!res.ok) {
        const text = await res.text();
        throw new AdapterError("E_PROTOCOL", `Azure delete HTTP ${res.status}: ${text.slice(0, 200)}`, {
          protocol: "azureblob",
        });
      }
      return { deleted: true, key };
    },
    async close() {
      /* stateless */
    },
  };
}

async function defaultConnect(config: Record<string, unknown>): Promise<ObjectStoreHandle> {
  const container = stringField(config, "container") ?? stringField(config, "bucket");
  if (!container) {
    throw new AdapterError("E_INVALID_CONFIG", "azureblob adapter requires config.container", { protocol: "azureblob" });
  }
  const endpoint = stringField(config, "endpoint") ?? stringField(config, "url");
  if (config.simulator === true || !endpoint || endpoint.startsWith("memory:")) {
    return createMemoryAzureBlob(container);
  }
  const timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 4000;
  const sas = stringField(config, "sasToken") ?? stringField(config, "sas");
  const account = stringField(config, "account") ?? stringField(config, "accountName") ?? "devstoreaccount1";
  const accountKey = stringField(config, "accountKey") ?? stringField(config, "key");
  if (sas) return httpAzure(endpoint, container, timeoutMs, undefined, sas);
  if (accountKey) {
    return httpAzure(endpoint, container, timeoutMs, ({ method, blob, contentType }) => {
      const date = new Date().toUTCString();
      return signAzureBlob({ method, account, container, blob, contentType, date, accountKey }).headers;
    });
  }
  if (config.unsigned === true) return httpAzure(endpoint, container, timeoutMs);
  throw new AdapterError(
    "E_UNSUPPORTED",
    "azureblob live path needs unsigned:true, sasToken, or accountKey (SharedKey). Use simulator / memory:// in CI.",
    { protocol: "azureblob" },
  );
}

/** Azure Blob REST: list/get/put/delete. SharedKey HMAC-SHA256 or SAS query. Writes need allowWrite. */
export class AzureBlobAdapter implements ProtocolAdapter {
  readonly protocol = "azureblob";
  private handle: ObjectStoreHandle | undefined;
  private connected = false;
  private allowWrite = false;
  private container = "";

  constructor(
    readonly id: string,
    private readonly connectFn: AzureBlobConnectFn = defaultConnect,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    this.allowWrite = allowWriteFrom(config);
    this.container = stringField(config, "container") ?? stringField(config, "bucket") ?? "";
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
    return objectStoreToolSchemas(this.container || "container");
  }

  async invoke(toolName: string, args: Record<string, unknown>) {
    this.assertConnected();
    return invokeObjectStore("azureblob", this.container || "container", this.allowWrite, this.handle!, toolName, args);
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected || !this.handle) return { ok: false, detail: "not connected" };
    try {
      await this.handle.list();
      return { ok: true, detail: `container=${this.container}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_INVALID_CONFIG", "azureblob adapter is not connected", { protocol: "azureblob" });
    }
  }
}

export { signAzureBlob, verifyAzureBlob } from "../sigv4.js";
