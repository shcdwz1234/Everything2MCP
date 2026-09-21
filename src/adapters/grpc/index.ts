import { readFileSync } from "node:fs";
import { loadTlsMaterial, tlsMaterialSummary, watchTlsMaterial, type TlsWatchHandle } from "../tls-material.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { parseAuth } from "../../runtime/auth.js";
import { AdapterError } from "../../runtime/errors.js";
import { loadText } from "../../runtime/load.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { discoverViaReflection } from "./reflection.js";
import { allowWriteFrom } from "../sql/common.js";
import { assertRpcCanWrite } from "../rpc-gate.js";
import {
  BidiSessionHub,
  DEFAULT_SESSION_BUFFER,
  MAX_SESSION_BUFFER,
  type BidiMethodRef,
} from "./session.js";

export type GrpcDiscoverFn = (target: string) => Promise<protoLoader.PackageDefinition>;

type RpcKind = "unary" | "server-stream" | "client-stream" | "bidi-stream";

interface MountedMethod {
  localName: string;
  serviceName: string;
  originalName: string;
  path: string;
  kind: RpcKind;
  client: grpc.Client;
  metadata: grpc.Metadata;
}

const MAX_STREAM_MESSAGES = 64;

/**
 * gRPC adapter: unary, server/client streaming, one-shot bidi, and session bidi
 * (bidi_open / bidi_send / bidi_recv / bidi_close). Custom PEM via config.ca/cert/key.
 * tlsWatch:true re-reads PEM files and remounts ChannelCredentials in-process
 * (bidi sessions are dropped). mcp_update is only needed if remount fails.
 */
export class GrpcAdapter implements ProtocolAdapter {
  readonly protocol = "grpc";
  private methods = new Map<string, MountedMethod>();
  private clients: grpc.Client[] = [];
  private sessions = new BidiSessionHub();
  private tmpDir: string | undefined;
  private connected = false;
  private target = "";
  private viaReflection = false;
  private allowWrite = false;
  private tlsNote = "";
  private tlsWatch: TlsWatchHandle | undefined;
  private mountDef: protoLoader.PackageDefinition | undefined;
  private mountConfig: Record<string, unknown> | undefined;
  private tlsRemounts = 0;

  constructor(
    readonly id: string,
    private readonly discoverFn?: GrpcDiscoverFn,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    const target = stringField(config, "target") ?? stringField(config, "address");
    if (!target) throw new Error("gRPC adapter requires config.target (host:port)");
    const useReflection = config.reflection === true;
    try {
      let packageDef: protoLoader.PackageDefinition;
      if (useReflection) {
        this.viaReflection = true;
        packageDef = this.discoverFn
          ? await this.discoverFn(target)
          : (
              await discoverViaReflection(target, {
                tls: Boolean(config.tls),
                credentials: credentialsFromConfig(config),
              })
            ).packageDefinition;
      } else {
        const resolved = await resolveProtoPath(config);
        this.tmpDir = resolved.tmpDir;
        const includeDirs = Array.isArray(config.includeDirs)
          ? config.includeDirs.filter((d): d is string => typeof d === "string")
          : [];
        packageDef = protoLoader.loadSync(resolved.path, {
          keepCase: true,
          longs: String,
          enums: String,
          defaults: true,
          oneofs: true,
          includeDirs,
        });
      }
      this.mountDef = packageDef;
      this.mountConfig = config;
      this.mount(packageDef, target, config);
      this.target = target;
      this.allowWrite = allowWriteFrom(config);
      if (config.tlsWatch === true) {
        this.tlsWatch = watchTlsMaterial(config, "grpc", (material) => {
          try {
            this.remountChannels();
            this.tlsNote = `${tlsMaterialSummary(material)} watch=on remount gen=${this.tlsWatch?.generations ?? 0} remounts=${this.tlsRemounts}`;
          } catch (err) {
            this.tlsNote = `watch=on remount-failed ${err instanceof Error ? err.message : String(err)}`;
          }
        });
        this.tlsNote = `${tlsMaterialSummary(this.tlsWatch.get())} watch=on remount gen=${this.tlsWatch.generations} remounts=${this.tlsRemounts}`;
      } else {
        this.tlsNote = tlsMaterialSummary(loadTlsMaterial(config, "grpc"));
      }
      this.connected = true;
    } catch (err) {
      await this.disconnect();
      throw err;
    }
  }

  private mount(
    packageDef: protoLoader.PackageDefinition,
    target: string,
    config: Record<string, unknown>,
  ): void {
    const grpcObject = grpc.loadPackageDefinition(packageDef);
    const credentials = credentialsFromConfig(config);
    const metadata = metadataFromAuth(parseAuth(config));
    const services = collectServices(grpcObject);
    if (services.length === 0) {
      throw new Error("gRPC proto contained no services");
    }
    const used = new Set<string>();
    for (const svc of services) {
      const client = new svc.Client(target, credentials);
      this.clients.push(client);
      for (const [key, def] of Object.entries(svc.Client.service)) {
        const kind: RpcKind =
          def.requestStream && def.responseStream
            ? "bidi-stream"
            : def.responseStream
              ? "server-stream"
              : def.requestStream
                ? "client-stream"
                : "unary";
        const protoName = key;
        const jsName = def.originalName ?? protoName;
        const localName = uniqueName(sanitize(`${svc.shortName}_${protoName}`), used);
        used.add(localName);
        this.methods.set(localName, {
          localName,
          serviceName: svc.fullName,
          originalName: jsName,
          path: def.path,
          kind,
          client,
          metadata,
        });
      }
    }
  }

  /** Close live clients/sessions and remount with current PEM (no process restart). */
  private remountChannels(): void {
    if (!this.mountDef || !this.mountConfig) return;
    this.sessions.closeAll();
    const oldClients = this.clients;
    const oldMethods = this.methods;
    this.clients = [];
    this.methods = new Map();
    try {
      this.mount(this.mountDef, this.target, this.mountConfig);
      this.tlsRemounts += 1;
      for (const client of oldClients) {
        try {
          client.close();
        } catch {
          /* ignore */
        }
      }
    } catch (err) {
      this.clients = oldClients;
      this.methods = oldMethods;
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.tlsWatch?.stop();
    this.tlsWatch = undefined;
    this.sessions.closeAll();
    for (const client of this.clients) {
      try {
        client.close();
      } catch {
        /* ignore */
      }
    }
    this.clients = [];
    this.methods.clear();
    this.mountDef = undefined;
    this.mountConfig = undefined;
    this.tlsRemounts = 0;
    this.connected = false;
    if (this.tmpDir) {
      await rm(this.tmpDir, { recursive: true, force: true });
      this.tmpDir = undefined;
    }
  }

  async listTools(): Promise<McpToolSchema[]> {
    this.assertConnected();
    const tools = [...this.methods.values()].map((m) => toolSchema(m));
    if ([...this.methods.values()].some((m) => m.kind === "bidi-stream")) {
      tools.push(...sessionToolSchemas());
    }
    return tools;
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    if (toolName === "bidi_open") return this.bidiOpen(args);
    if (toolName === "bidi_send") return this.bidiSend(args);
    if (toolName === "bidi_recv") return this.bidiRecv(args);
    if (toolName === "bidi_close") return this.bidiClose(args);
    if (toolName === "bidi_status") return this.bidiStatus(args);
    const method = this.methods.get(toolName);
    if (!method) {
      throw new AdapterError("E_UNKNOWN_TOOL", `Unknown gRPC method "${toolName}"`, { protocol: "grpc" });
    }
    assertRpcCanWrite("grpc", this.allowWrite, method.originalName);
    const body = requestBody(args);
    const client = method.client as grpc.Client & Record<string, unknown>;
    const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : 10_000;
    const deadline = new Date(Date.now() + timeoutMs);
    if (method.kind === "unary") {
      const fn = findUnaryFn(client, method.originalName);
      const meta = method.metadata;
      return new Promise((resolve, reject) => {
        fn.call(client, body, meta, { deadline }, (err: grpc.ServiceError | null, res: unknown) => {
          if (err) reject(new Error(`gRPC ${method.path} failed: ${err.message}`));
          else resolve(res);
        });
      });
    }
    if (method.kind === "server-stream") {
      return collectServerStream(client, method, body, deadline, args);
    }
    if (method.kind === "bidi-stream") {
      return runBidiStream(client, method, args, deadline);
    }
    return sendClientStream(client, method, args, deadline);
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    let unary = 0;
    let serverStream = 0;
    let clientStream = 0;
    let bidiStream = 0;
    for (const m of this.methods.values()) {
      if (m.kind === "unary") unary += 1;
      else if (m.kind === "server-stream") serverStream += 1;
      else if (m.kind === "bidi-stream") bidiStream += 1;
      else clientStream += 1;
    }
    return {
      ok: true,
      detail: `unary=${unary} serverStream=${serverStream} clientStream=${clientStream} bidiStream=${bidiStream} sessionBidi=${this.sessions.size} target=${this.target}${this.viaReflection ? " reflection" : ""} allowWrite=${this.allowWrite} remounts=${this.tlsRemounts} ${this.tlsNote}`,
    };
  }

  private bidiMethod(name: string): BidiMethodRef {
    const method = this.methods.get(name);
    if (!method) {
      throw new AdapterError("E_UNKNOWN_TOOL", `Unknown gRPC method "${name}"`, { protocol: "grpc" });
    }
    if (method.kind !== "bidi-stream") {
      throw new AdapterError(
        "E_UNSUPPORTED",
        `gRPC ${method.path} is ${method.kind}, not a bidi-stream (use the method tool or a Chat-like RPC)`,
        { protocol: "grpc" },
      );
    }
    return method as BidiMethodRef;
  }

  private bidiOpen(args: Record<string, unknown>) {
    const name =
      (typeof args.method === "string" && args.method.trim()) ||
      (typeof args.rpc === "string" && args.rpc.trim()) ||
      "";
    if (!name) {
      throw new AdapterError("E_INVALID_CONFIG", "bidi_open requires args.method (mounted tool name)", {
        protocol: "grpc",
      });
    }
    return this.sessions.open(this.bidiMethod(name), args, this.allowWrite);
  }

  private bidiSend(args: Record<string, unknown>) {
    const streamId = typeof args.streamId === "string" ? args.streamId.trim() : "";
    if (!streamId) {
      throw new AdapterError("E_INVALID_CONFIG", "bidi_send requires args.streamId", { protocol: "grpc" });
    }
    const message =
      args.message && typeof args.message === "object" && !Array.isArray(args.message)
        ? (args.message as Record<string, unknown>)
        : requestBody(args);
    const end = args.end === true || args.close === true;
    return this.sessions.send(streamId, message, end, this.allowWrite);
  }

  private bidiRecv(args: Record<string, unknown>) {
    const streamId = typeof args.streamId === "string" ? args.streamId.trim() : "";
    if (!streamId) {
      throw new AdapterError("E_INVALID_CONFIG", "bidi_recv requires args.streamId", { protocol: "grpc" });
    }
    return this.sessions.recv(streamId, args.maxMessages, args.timeoutMs);
  }

  private bidiClose(args: Record<string, unknown>) {
    const streamId = typeof args.streamId === "string" ? args.streamId.trim() : "";
    if (!streamId) {
      throw new AdapterError("E_INVALID_CONFIG", "bidi_close requires args.streamId", { protocol: "grpc" });
    }
    return this.sessions.close(streamId);
  }

  private bidiStatus(args: Record<string, unknown>) {
    const streamId = typeof args.streamId === "string" ? args.streamId.trim() : "";
    if (!streamId) {
      throw new AdapterError("E_INVALID_CONFIG", "bidi_status requires args.streamId", { protocol: "grpc" });
    }
    return this.sessions.status(streamId);
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new AdapterError("E_NOT_CONNECTED", "gRPC adapter is not connected", { protocol: "grpc" });
    }
  }
}

function sessionToolSchemas(): McpToolSchema[] {
  return [
    {
      name: "bidi_open",
      description: `Open a long-lived bidi session (write-gated). Returns streamId. Buffer cap default ${DEFAULT_SESSION_BUFFER} (max ${MAX_SESSION_BUFFER}); pause when unread hits cap.`,
      inputSchema: {
        type: "object",
        properties: {
          method: { type: "string", description: "Mounted bidi tool name, e.g. Greeter_Chat" },
          maxMessages: { type: "integer", default: DEFAULT_SESSION_BUFFER },
          timeoutMs: { type: "integer", default: 60_000, description: "Session deadline from open" },
        },
        required: ["method"],
        additionalProperties: false,
      },
    },
    {
      name: "bidi_send",
      description: "Write one message on an open bidi session (write-gated). end=true half-closes the client side.",
      inputSchema: {
        type: "object",
        properties: {
          streamId: { type: "string" },
          message: { type: "object", additionalProperties: true },
          end: { type: "boolean", default: false },
        },
        required: ["streamId"],
        additionalProperties: true,
      },
    },
    {
      name: "bidi_recv",
      description: "Read up to maxMessages from a session inbox. Times out with E_TIMEOUT. Recv/close are not write-gated.",
      inputSchema: {
        type: "object",
        properties: {
          streamId: { type: "string" },
          maxMessages: { type: "integer", default: 1 },
          timeoutMs: { type: "integer", default: 10_000 },
        },
        required: ["streamId"],
        additionalProperties: false,
      },
    },
    {
      name: "bidi_close",
      description: "Cancel the session (stream.cancel). Not write-gated.",
      inputSchema: {
        type: "object",
        properties: { streamId: { type: "string" } },
        required: ["streamId"],
        additionalProperties: false,
      },
    },
    {
      name: "bidi_status",
      description: "Inspect an open session (buffered/paused/ended). Not write-gated.",
      inputSchema: {
        type: "object",
        properties: { streamId: { type: "string" } },
        required: ["streamId"],
        additionalProperties: false,
      },
    },
  ];
}

function toolSchema(m: MountedMethod): McpToolSchema {
  if (m.kind === "server-stream") {
    return {
      name: m.localName,
      description: `Server-streaming gRPC ${m.serviceName}/${m.originalName} (${m.path}); collects up to maxMessages then cancels`,
      inputSchema: {
        type: "object",
        properties: {
          body: {
            type: "object",
            additionalProperties: true,
            description: "JSON request message fields",
          },
          maxMessages: { type: "integer", default: 8, description: `Cap ${MAX_STREAM_MESSAGES}` },
          timeoutMs: { type: "integer", default: 10_000 },
        },
        additionalProperties: true,
      },
    };
  }
  if (m.kind === "client-stream") {
    return {
      name: m.localName,
      description: `Client-streaming gRPC ${m.serviceName}/${m.originalName} (${m.path}); send messages[] then wait for one reply`,
      inputSchema: {
        type: "object",
        properties: {
          messages: {
            type: "array",
            items: { type: "object", additionalProperties: true },
            description: "JSON request messages to write, then end the stream",
          },
          timeoutMs: { type: "integer", default: 10_000 },
        },
        additionalProperties: true,
      },
    };
  }
  if (m.kind === "bidi-stream") {
    return {
      name: m.localName,
      description: `One-shot bidi gRPC ${m.serviceName}/${m.originalName} (${m.path}); write messages[], collect up to maxMessages, then cancel. Not a long-lived duplex session.`,
      inputSchema: {
        type: "object",
        properties: {
          messages: {
            type: "array",
            items: { type: "object", additionalProperties: true },
            description: "JSON request messages to write, then end the client half",
          },
          maxMessages: {
            type: "integer",
            default: 8,
            description: `Collect at most this many replies then cancel (cap ${MAX_STREAM_MESSAGES})`,
          },
          timeoutMs: { type: "integer", default: 10_000 },
        },
        additionalProperties: true,
      },
    };
  }
  return {
    name: m.localName,
    description: `Unary gRPC ${m.serviceName}/${m.originalName} (${m.path})`,
    inputSchema: {
      type: "object",
      properties: {
        body: {
          type: "object",
          additionalProperties: true,
          description: "JSON request message fields",
        },
      },
      additionalProperties: true,
    },
  };
}

function requestBody(args: Record<string, unknown>): Record<string, unknown> {
  if (args.body && typeof args.body === "object" && !Array.isArray(args.body)) {
    return args.body as Record<string, unknown>;
  }
  return Object.fromEntries(
    Object.entries(args).filter(
      ([k]) =>
        k !== "body" &&
        k !== "metadata" &&
        k !== "messages" &&
        k !== "maxMessages" &&
        k !== "timeoutMs" &&
        k !== "streamId" &&
        k !== "method" &&
        k !== "rpc" &&
        k !== "end" &&
        k !== "close",
    ),
  );
}

function collectServerStream(
  client: grpc.Client & Record<string, unknown>,
  method: MountedMethod,
  body: Record<string, unknown>,
  deadline: Date,
  args: Record<string, unknown>,
): Promise<{ messages: unknown[]; count: number; truncated: boolean }> {
  const maxMessages = clampInt(args.maxMessages, 1, MAX_STREAM_MESSAGES, 8);
  const fn = findClientFn(client, method.originalName);
  const stream = fn.call(client, body, method.metadata, { deadline }) as grpc.ClientReadableStream<unknown>;
  return new Promise((resolve, reject) => {
    const messages: unknown[] = [];
    let settled = false;
    const finish = (truncated: boolean) => {
      if (settled) return;
      settled = true;
      try {
        stream.cancel();
      } catch {
        /* ignore */
      }
      resolve({ messages, count: messages.length, truncated });
    };
    stream.on("data", (msg) => {
      messages.push(msg);
      if (messages.length >= maxMessages) finish(true);
    });
    stream.on("end", () => finish(false));
    stream.on("error", (err: Error) => {
      if (settled) return;
      if (messages.length > 0 && /CANCELLED|cancelled/i.test(err.message)) {
        finish(messages.length >= maxMessages);
        return;
      }
      settled = true;
      reject(new Error(`gRPC ${method.path} stream failed: ${err.message}`));
    });
  });
}

function runBidiStream(
  client: grpc.Client & Record<string, unknown>,
  method: MountedMethod,
  args: Record<string, unknown>,
  deadline: Date,
): Promise<{
  messages: unknown[];
  count: number;
  truncated: boolean;
  cancelled: boolean;
  window: { maxMessages: number };
}> {
  const messages = Array.isArray(args.messages)
    ? args.messages.filter((m): m is Record<string, unknown> => Boolean(m) && typeof m === "object" && !Array.isArray(m))
    : [];
  if (messages.length === 0) {
    throw new Error(`Bidi-streaming gRPC ${method.path} requires args.messages (non-empty array)`);
  }
  const maxMessages = clampInt(args.maxMessages, 1, MAX_STREAM_MESSAGES, 8);
  const fn = findClientFn(client, method.originalName);
  const stream = fn.call(client, method.metadata, { deadline }) as grpc.ClientDuplexStream<unknown, unknown>;
  return new Promise((resolve, reject) => {
    const out: unknown[] = [];
    let settled = false;
    const finish = (truncated: boolean, cancelled: boolean) => {
      if (settled) return;
      settled = true;
      try {
        stream.cancel();
      } catch {
        /* ignore */
      }
      resolve({
        messages: out,
        count: out.length,
        truncated,
        cancelled,
        window: { maxMessages },
      });
    };
    stream.on("data", (msg) => {
      out.push(msg);
      if (out.length >= maxMessages) finish(true, true);
    });
    stream.on("end", () => finish(false, false));
    stream.on("error", (err: Error) => {
      if (settled) return;
      if (out.length > 0 && /CANCELLED|cancelled/i.test(err.message)) {
        finish(out.length >= maxMessages, true);
        return;
      }
      settled = true;
      reject(new Error(`gRPC ${method.path} bidi stream failed: ${err.message}`));
    });
    for (const msg of messages) stream.write(msg);
    stream.end();
  });
}

function sendClientStream(
  client: grpc.Client & Record<string, unknown>,
  method: MountedMethod,
  args: Record<string, unknown>,
  deadline: Date,
): Promise<unknown> {
  const messages = Array.isArray(args.messages)
    ? args.messages.filter((m): m is Record<string, unknown> => Boolean(m) && typeof m === "object" && !Array.isArray(m))
    : [];
  if (messages.length === 0) {
    throw new Error(`Client-streaming gRPC ${method.path} requires args.messages (non-empty array)`);
  }
  const fn = findClientFn(client, method.originalName);
  return new Promise((resolve, reject) => {
    type ClientStreamFn = (
      meta: grpc.Metadata,
      opts: { deadline: Date },
      cb: (err: grpc.ServiceError | null, res: unknown) => void,
    ) => grpc.ClientWritableStream<unknown>;
    const call = (fn as unknown as ClientStreamFn).call(
      client,
      method.metadata,
      { deadline },
      (err: grpc.ServiceError | null, res: unknown) => {
        if (err) reject(new Error(`gRPC ${method.path} failed: ${err.message}`));
        else resolve(res);
      },
    );
    for (const msg of messages) call.write(msg);
    call.end();
  });
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

async function resolveProtoPath(
  config: Record<string, unknown>,
): Promise<{ path: string; tmpDir?: string }> {
  const file =
    stringField(config, "proto") ??
    stringField(config, "protoFile") ??
    stringField(config, "spec");
  const inline =
    stringField(config, "protoInline") ?? (file && looksLikeProto(file) ? file : undefined);
  if (inline) {
    const dir = await mkdtemp(join(tmpdir(), "e2mcp-grpc-"));
    const path = join(dir, "service.proto");
    await writeFile(path, inline, "utf8");
    return { path, tmpDir: dir };
  }
  if (!file) throw new Error("gRPC adapter requires config.proto (file path) or config.protoInline");
  if (/^https?:\/\//i.test(file)) {
    const { text } = await loadText(file);
    const dir = await mkdtemp(join(tmpdir(), "e2mcp-grpc-"));
    const path = join(dir, "service.proto");
    await writeFile(path, text, "utf8");
    return { path, tmpDir: dir };
  }
  if (file.startsWith("file://")) return { path: fileURLToPath(file) };
  return { path: resolve(file) };
}

function looksLikeProto(value: unknown): value is string {
  return typeof value === "string" && /syntax\s*=|service\s+\w+/.test(value);
}

function stringField(config: Record<string, unknown>, key: string): string | undefined {
  const v = config[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function collectServices(
  obj: grpc.GrpcObject,
  prefix: string[] = [],
): Array<{ fullName: string; shortName: string; Client: grpc.ServiceClientConstructor }> {
  const out: Array<{ fullName: string; shortName: string; Client: grpc.ServiceClientConstructor }> = [];
  for (const [key, value] of Object.entries(obj)) {
    if (isServiceCtor(value)) {
      const fullName = [...prefix, key].join(".");
      out.push({ fullName, shortName: key, Client: value });
    } else if (value && typeof value === "object" && !("format" in value)) {
      out.push(...collectServices(value as grpc.GrpcObject, [...prefix, key]));
    }
  }
  return out;
}

function isServiceCtor(value: unknown): value is grpc.ServiceClientConstructor {
  return typeof value === "function" && Boolean((value as grpc.ServiceClientConstructor).service);
}

function findUnaryFn(
  client: Record<string, unknown>,
  originalName: string,
): (
  req: unknown,
  meta: grpc.Metadata,
  opts: { deadline: Date },
  cb: (err: grpc.ServiceError | null, res: unknown) => void,
) => void {
  const fn = findClientFn(client, originalName);
  return fn as (
    req: unknown,
    meta: grpc.Metadata,
    opts: { deadline: Date },
    cb: (err: grpc.ServiceError | null, res: unknown) => void,
  ) => void;
}

function findClientFn(client: Record<string, unknown>, originalName: string): (...args: unknown[]) => unknown {
  const camel = originalName.charAt(0).toLowerCase() + originalName.slice(1);
  const fn = client[originalName] ?? client[camel];
  if (typeof fn !== "function") {
    throw new Error(`Client has no method ${originalName}`);
  }
  return fn as (...args: unknown[]) => unknown;
}

function metadataFromAuth(auth: ReturnType<typeof parseAuth>): grpc.Metadata {
  const md = new grpc.Metadata();
  if (!auth || auth.type === "none") return md;
  if (auth.type === "bearer" && auth.token) md.set("authorization", `Bearer ${auth.token}`);
  if (auth.type === "apiKey" && auth.apiKey) md.set(auth.headerName ?? "x-api-key", auth.apiKey);
  if (auth.type === "basic") {
    const token = Buffer.from(`${auth.username ?? ""}:${auth.password ?? ""}`).toString("base64");
    md.set("authorization", `Basic ${token}`);
  }
  return md;
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, "_") || "rpc";
}

function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}_${i}`)) i += 1;
  return `${base}_${i}`;
}

/** Load channel creds from current PEM (file paths re-read). tlsWatch remounts clients in-process. */
export function credentialsFromConfig(config: Record<string, unknown>): grpc.ChannelCredentials {
  const material = loadTlsMaterial(config, "grpc");
  const wantTls = config.tls === true || Boolean(material.ca || material.cert || material.key);
  if (!wantTls) return grpc.credentials.createInsecure();
  try {
    return grpc.credentials.createSsl(
      material.ca?.buffer ?? null,
      material.key?.buffer ?? null,
      material.cert?.buffer ?? null,
    );
  } catch (err) {
    throw new AdapterError(
      "E_INVALID_CONFIG",
      `gRPC TLS credentials failed: ${err instanceof Error ? err.message : String(err)}`,
      { protocol: "grpc" },
    );
  }
}
