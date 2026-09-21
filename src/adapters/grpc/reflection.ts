import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

const REFLECTION_BODY = `
message ServerReflectionRequest {
  string host = 1;
  oneof message_request {
    string file_by_filename = 3;
    string file_containing_symbol = 4;
    string list_services = 7;
  }
}
message ServerReflectionResponse {
  string valid_host = 1;
  ServerReflectionRequest original_request = 2;
  oneof message_response {
    FileDescriptorResponse file_descriptor_response = 4;
    ListServiceResponse list_services_response = 6;
    ErrorResponse error_response = 7;
  }
}
message FileDescriptorResponse { repeated bytes file_descriptor_proto = 1; }
message ListServiceResponse { repeated ServiceResponse service = 1; }
message ServiceResponse { string name = 1; }
message ErrorResponse { int32 error_code = 1; string error_message = 2; }
service ServerReflection {
  rpc ServerReflectionInfo(stream ServerReflectionRequest) returns (stream ServerReflectionResponse);
}
`;

/** grpc.reflection.v1 then v1alpha (identical wire messages, different package). */
export const REFLECTION_VARIANTS = ["v1", "v1alpha"] as const;
export type ReflectionVariant = (typeof REFLECTION_VARIANTS)[number];

export function reflectionProto(variant: ReflectionVariant): string {
  const pkg = variant === "v1" ? "grpc.reflection.v1" : "grpc.reflection.v1alpha";
  return `syntax = "proto3";\npackage ${pkg};\n${REFLECTION_BODY}`;
}

const LOADER_OPTS: protoLoader.Options = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
};

export interface ReflectionDiscoverResult {
  services: string[];
  packageDefinition: protoLoader.PackageDefinition;
  variant: ReflectionVariant;
}

type ReflectionClient = grpc.Client & {
  ServerReflectionInfo: () => grpc.ClientDuplexStream<Record<string, unknown>, Record<string, unknown>>;
  serverReflectionInfo: () => grpc.ClientDuplexStream<Record<string, unknown>, Record<string, unknown>>;
};

function reflectionCredentials(
  opts: { tls?: boolean; credentials?: grpc.ChannelCredentials } = {},
): grpc.ChannelCredentials {
  if (opts.credentials) return opts.credentials;
  return opts.tls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
}

async function withReflectionClient<T>(
  target: string,
  credentials: grpc.ChannelCredentials,
  variant: ReflectionVariant,
  fn: (client: ReflectionClient) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "e2mcp-refl-"));
  const path = join(dir, "reflection.proto");
  await writeFile(path, reflectionProto(variant), "utf8");
  try {
    const def = protoLoader.loadSync(path, LOADER_OPTS);
    const obj = grpc.loadPackageDefinition(def) as grpc.GrpcObject;
    const Ctor = reflectionCtor(obj, variant);
    const client = new Ctor(target, credentials) as unknown as ReflectionClient;
    try {
      return await fn(client);
    } finally {
      client.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function reflectionCtor(obj: grpc.GrpcObject, variant: ReflectionVariant): grpc.ServiceClientConstructor {
  const grpcNs = obj.grpc as grpc.GrpcObject | undefined;
  const refl = grpcNs?.reflection as grpc.GrpcObject | undefined;
  const pkg = refl?.[variant] as grpc.GrpcObject | undefined;
  const Ctor = pkg?.ServerReflection;
  if (!isServiceCtor(Ctor)) {
    throw new Error(`Failed to load gRPC reflection ${variant} client`);
  }
  return Ctor;
}

function isServiceCtor(value: unknown): value is grpc.ServiceClientConstructor {
  return typeof value === "function" && Boolean((value as grpc.ServiceClientConstructor).service);
}

async function withReflectionFallback<T>(
  target: string,
  credentials: grpc.ChannelCredentials,
  fn: (client: ReflectionClient, variant: ReflectionVariant) => Promise<T>,
): Promise<T> {
  const errors: string[] = [];
  for (const variant of REFLECTION_VARIANTS) {
    try {
      return await withReflectionClient(target, credentials, variant, (client) => fn(client, variant));
    } catch (err) {
      errors.push(`${variant}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`gRPC reflection failed (tried v1 then v1alpha): ${errors.join("; ")}`);
}

function openStream(client: ReflectionClient): grpc.ClientDuplexStream<Record<string, unknown>, Record<string, unknown>> {
  const fn = client.ServerReflectionInfo ?? client.serverReflectionInfo;
  return fn.call(client);
}

function onceResponse(
  stream: grpc.ClientDuplexStream<Record<string, unknown>, Record<string, unknown>>,
  request: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stream.cancel();
      reject(new Error(`gRPC reflection timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    stream.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    stream.once("data", (msg) => {
      clearTimeout(timer);
      resolve(msg as Record<string, unknown>);
    });
    stream.write(request);
  });
}

export async function listGrpcServices(
  target: string,
  opts: { tls?: boolean; timeoutMs?: number; credentials?: grpc.ChannelCredentials } = {},
): Promise<string[]> {
  const timeoutMs = opts.timeoutMs ?? 2500;
  return withReflectionFallback(target, reflectionCredentials(opts), async (client) => {
    const stream = openStream(client);
    try {
      const msg = await onceResponse(stream, { list_services: "*" }, timeoutMs);
      const listed = (msg.list_services_response ?? msg.listServicesResponse) as
        | { service?: Array<{ name?: string }> }
        | undefined;
      return (listed?.service ?? []).map((s) => s.name).filter((n): n is string => Boolean(n));
    } finally {
      stream.end();
    }
  });
}

function wrapFileDescriptorSet(files: Buffer[]): Buffer {
  const parts: Buffer[] = [];
  for (const file of files) {
    parts.push(Buffer.from([0x0a]), encodeVarint(file.length), file);
  }
  return Buffer.concat(parts);
}

function encodeVarint(n: number): Buffer {
  const bytes: number[] = [];
  let x = n;
  do {
    let b = x & 0x7f;
    x >>>= 7;
    if (x) b |= 0x80;
    bytes.push(b);
  } while (x);
  return Buffer.from(bytes);
}

function asBuffers(value: unknown): Buffer[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (Buffer.isBuffer(item)) return item;
      if (item instanceof Uint8Array) return Buffer.from(item);
      if (typeof item === "string") return Buffer.from(item, "base64");
      return undefined;
    })
    .filter((b): b is Buffer => Boolean(b));
}

export async function discoverViaReflection(
  target: string,
  opts: { tls?: boolean; timeoutMs?: number; credentials?: grpc.ChannelCredentials } = {},
): Promise<ReflectionDiscoverResult> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  return withReflectionFallback(target, reflectionCredentials(opts), async (client, variant) => {
    const stream = openStream(client);
    try {
      const listedMsg = await onceResponse(stream, { list_services: "*" }, timeoutMs);
      const listed = (listedMsg.list_services_response ?? listedMsg.listServicesResponse) as
        | { service?: Array<{ name?: string }> }
        | undefined;
      const services = (listed?.service ?? []).map((s) => s.name).filter((n): n is string => Boolean(n));
      if (services.length === 0) {
        throw new Error("gRPC reflection listed no services");
      }
      const files: Buffer[] = [];
      const seen = new Set<string>();
      for (const symbol of services) {
        const msg = await onceResponse(stream, { file_containing_symbol: symbol }, timeoutMs);
        const fd = (msg.file_descriptor_response ?? msg.fileDescriptorResponse) as
          | { file_descriptor_proto?: unknown; fileDescriptorProto?: unknown }
          | undefined;
        const blobs = asBuffers(fd?.file_descriptor_proto ?? fd?.fileDescriptorProto);
        for (const blob of blobs) {
          const key = blob.toString("base64");
          if (seen.has(key)) continue;
          seen.add(key);
          files.push(blob);
        }
      }
      if (files.length === 0) {
        throw new Error("gRPC reflection returned no file descriptors");
      }
      const packageDefinition = protoLoader.loadFileDescriptorSetFromBuffer(wrapFileDescriptorSet(files), LOADER_OPTS);
      return { services, packageDefinition, variant };
    } finally {
      stream.end();
    }
  });
}
