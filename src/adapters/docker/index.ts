import { AdapterError } from "../../runtime/errors.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";
import { stringField } from "../helpers.js";

export interface DockerContainer {
  Id: string;
  Names?: string[];
  Image?: string;
  State?: string;
  Status?: string;
}

export interface DockerHandle {
  listContainers(): Promise<DockerContainer[]>;
  inspect(id: string): Promise<Record<string, unknown>>;
  listImages(): Promise<Array<{ Id: string; RepoTags?: string[] }>>;
  logs(id: string, tail: number): Promise<{ id: string; lines: string[] }>;
  close(): Promise<void>;
}

export type DockerConnectFn = (config: Record<string, unknown>) => Promise<DockerHandle>;

export function createMemoryDocker(seed?: DockerContainer[]): DockerHandle {
  const containers = [...(seed ?? [{ Id: "abc123", Names: ["/web"], Image: "nginx:alpine", State: "running", Status: "Up" }])];
  const images = [{ Id: "sha256:img", RepoTags: ["nginx:alpine"] }];
  const logMap = new Map<string, string[]>([["abc123", ["listening on :80", "ready"]]]);
  for (const c of containers) {
    if (!logMap.has(c.Id)) logMap.set(c.Id, [`${c.Names?.[0] ?? c.Id} started`]);
  }
  const find = (id: string) =>
    containers.find((x) => x.Id === id || x.Id.startsWith(id) || x.Names?.includes(`/${id}`) || x.Names?.includes(id));
  return {
    async listContainers() {
      return containers;
    },
    async inspect(id) {
      const c = find(id);
      if (!c) throw new AdapterError("E_NOT_FOUND", `container ${id} not found`, { protocol: "docker" });
      return { ...c };
    },
    async listImages() {
      return images;
    },
    async logs(id, tail) {
      const c = find(id);
      if (!c) throw new AdapterError("E_NOT_FOUND", `container ${id} not found`, { protocol: "docker" });
      const lines = logMap.get(c.Id) ?? [];
      return { id: c.Id, lines: lines.slice(-tail) };
    },
    async close() {
      containers.length = 0;
    },
  };
}

function decodeDockerLogs(raw: Uint8Array): string[] {
  const buf = Buffer.from(raw);
  if (buf.length >= 8 && buf[0]! <= 2) {
    const lines: string[] = [];
    let i = 0;
    while (i + 8 <= buf.length) {
      const size = buf.readUInt32BE(i + 4);
      if (size < 0 || i + 8 + size > buf.length) break;
      const chunk = buf.subarray(i + 8, i + 8 + size).toString("utf8");
      lines.push(...chunk.split(/\r?\n/).filter(Boolean));
      i += 8 + size;
    }
    if (lines.length) return lines;
  }
  return buf.toString("utf8").split(/\r?\n/).filter(Boolean);
}

async function liveDocker(config: Record<string, unknown>): Promise<DockerHandle> {
  const url = stringField(config, "url") ?? stringField(config, "engine");
  if (!url) {
    throw new AdapterError("E_UNSUPPORTED", "live docker/podman needs config.url (http) or simulator:true; unix socket HTTP is not bundled", {
      protocol: "docker",
    });
  }
  const base = url.replace(/\/+$/, "");
  const get = async (path: string, asText = false): Promise<unknown> => {
    const res = await fetch(`${base}${path}`);
    if (!res.ok) throw new AdapterError("E_PROTOCOL", `engine HTTP ${res.status} ${path}`, { protocol: "docker" });
    return asText ? Buffer.from(await res.arrayBuffer()) : res.json();
  };
  return {
    async listContainers() {
      return (await get("/containers/json?all=1")) as DockerContainer[];
    },
    async inspect(id) {
      return (await get(`/containers/${encodeURIComponent(id)}/json`)) as Record<string, unknown>;
    },
    async listImages() {
      return (await get("/images/json")) as Array<{ Id: string; RepoTags?: string[] }>;
    },
    async logs(id, tail) {
      const raw = (await get(`/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&tail=${tail}`, true)) as Buffer;
      return { id, lines: decodeDockerLogs(raw) };
    },
    async close() {
      /* http */
    },
  };
}

/** Docker Engine API (and Podman docker-compat). Read-only list/inspect/logs. */
export class DockerAdapter implements ProtocolAdapter {
  readonly protocol: string;
  private handle: DockerHandle | undefined;
  private allowWrite = false;
  private connectFn: DockerConnectFn;

  constructor(readonly id: string, protocol = "docker", connectFn?: DockerConnectFn) {
    this.protocol = protocol;
    this.connectFn = connectFn ?? defaultConnect;
  }

  async connect(config: Record<string, unknown>): Promise<void> {
    this.allowWrite = allowWriteFrom(config);
    this.handle = await this.connectFn(config);
  }

  async disconnect(): Promise<void> {
    await this.handle?.close();
    this.handle = undefined;
  }

  async listTools(): Promise<McpToolSchema[]> {
    const engine = this.protocol === "podman" ? "Podman docker-compat" : "Docker Engine";
    return [
      {
        name: "list_containers",
        description: `Read-only ${engine} containers/json.`,
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
      },
      {
        name: "inspect",
        description: "Inspect one container by id/name.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: "list_images",
        description: "Read-only images/json.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
      },
      {
        name: "logs",
        description: "Read last N stdout/stderr lines (Engine logs API).",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" }, tail: { type: "integer", default: 40 } },
          required: ["id"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: "run",
        description: "Not implemented. Write path always E_UNSUPPORTED (even with allowWrite).",
        inputSchema: { type: "object", properties: { image: { type: "string" } }, additionalProperties: false },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.handle) throw new AdapterError("E_NOT_CONNECTED", `${this.protocol} not connected`, { protocol: this.protocol });
    if (toolName === "run") {
      assertCanWrite(this.protocol, this.allowWrite);
      throw new AdapterError("E_UNSUPPORTED", `${this.protocol} run/start/stop are not implemented (read-only MVP)`, {
        protocol: this.protocol,
      });
    }
    if (toolName === "list_containers") return { containers: await this.handle.listContainers() };
    if (toolName === "list_images") return { images: await this.handle.listImages() };
    if (toolName === "inspect") {
      const id = typeof args.id === "string" ? args.id : "";
      if (!id) throw new AdapterError("E_INVALID_ARGUMENT", "id required", { protocol: this.protocol });
      return this.handle.inspect(id);
    }
    if (toolName === "logs") {
      const id = typeof args.id === "string" ? args.id : "";
      if (!id) throw new AdapterError("E_INVALID_ARGUMENT", "id required", { protocol: this.protocol });
      const tail = typeof args.tail === "number" && args.tail > 0 ? Math.min(args.tail, 200) : 40;
      return this.handle.logs(id, tail);
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown tool ${toolName}`, { protocol: this.protocol });
  }

  async health(): Promise<AdapterHealth> {
    return { ok: Boolean(this.handle), detail: this.allowWrite ? "allowWrite" : "readonly" };
  }
}

async function defaultConnect(config: Record<string, unknown>): Promise<DockerHandle> {
  if (config.simulator === true || (!stringField(config, "url") && !stringField(config, "engine"))) {
    return createMemoryDocker();
  }
  return liveDocker(config);
}
