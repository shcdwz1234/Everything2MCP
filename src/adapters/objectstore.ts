import { AdapterError } from "../runtime/errors.js";
import type { McpToolSchema } from "../runtime/types.js";
import { allowWriteFrom, assertCanWrite } from "./sql/common.js";
import { requiredString } from "./helpers.js";

/** Shared blob used by GCS / OSS memory backends (S3 keeps its own copy). */
export interface BlobObject {
  key: string;
  size: number;
  body?: string;
  contentType?: string;
  lastModified?: string;
}

export function createMemoryBlobs() {
  const objects = new Map<string, BlobObject>();
  return {
    list(prefix?: string): BlobObject[] {
      return [...objects.values()]
        .filter((o) => (prefix ? o.key.startsWith(prefix) : true))
        .map(({ body: _body, ...rest }) => rest);
    },
    get(key: string): BlobObject | undefined {
      const found = objects.get(key);
      return found ? { ...found } : undefined;
    },
    put(key: string, body: string, contentType?: string): BlobObject {
      const obj: BlobObject = {
        key,
        size: Buffer.byteLength(body),
        body,
        contentType: contentType ?? "application/octet-stream",
        lastModified: new Date().toISOString(),
      };
      objects.set(key, obj);
      return { ...obj, body: undefined };
    },
    delete(key: string): boolean {
      return objects.delete(key);
    },
    close() {
      objects.clear();
    },
  };
}

export type MemoryBlobs = ReturnType<typeof createMemoryBlobs>;

export interface ObjectStoreHandle {
  list(prefix?: string): Promise<BlobObject[]>;
  get(key: string): Promise<BlobObject>;
  put(key: string, body: string, contentType?: string): Promise<BlobObject>;
  delete(key: string): Promise<{ deleted: boolean; key: string }>;
  close(): Promise<void>;
}

export function objectStoreToolSchemas(bucket: string): McpToolSchema[] {
  return [
    {
      name: "list",
      description: `List objects in bucket ${bucket}`,
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

export async function invokeObjectStore(
  protocol: string,
  bucket: string,
  allowWrite: boolean,
  handle: ObjectStoreHandle,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (toolName === "list") {
    const prefix = typeof args.prefix === "string" ? args.prefix : undefined;
    const objects = await handle.list(prefix);
    return { bucket, objects };
  }
  if (toolName === "get") {
    const obj = await handle.get(requiredString(args, "key"));
    return { bucket, ...obj };
  }
  if (toolName === "put") {
    assertCanWrite(protocol, allowWrite);
    const key = requiredString(args, "key");
    const body = typeof args.body === "string" ? args.body : JSON.stringify(args.body ?? "");
    const contentType = typeof args.contentType === "string" ? args.contentType : undefined;
    const obj = await handle.put(key, body, contentType);
    return { bucket, ...obj };
  }
  if (toolName === "delete") {
    assertCanWrite(protocol, allowWrite);
    const key = requiredString(args, "key");
    const result = await handle.delete(key);
    return { bucket, ...result };
  }
  throw new AdapterError("E_UNKNOWN_TOOL", `Unknown ${protocol} tool "${toolName}"`, { protocol });
}

export { allowWriteFrom };
