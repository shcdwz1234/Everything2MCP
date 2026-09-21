import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AdapterError } from "../../runtime/errors.js";
import { fetchSafe } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { requiredString, stringField } from "../helpers.js";

export interface K8sObject {
  kind: string;
  metadata: { name: string; namespace: string };
  [key: string]: unknown;
}

export interface KubernetesHandle {
  list(kind: "pods" | "services" | "configmaps", namespace: string): Promise<K8sObject[]>;
  get(kind: "pods" | "services" | "configmaps", namespace: string, name: string): Promise<K8sObject>;
  close(): Promise<void>;
}

export type KubernetesConnectFn = (config: Record<string, unknown>) => Promise<KubernetesHandle>;

const KINDS = {
  pods: "Pod",
  services: "Service",
  configmaps: "ConfigMap",
} as const;

export function createMemoryKubernetes(): KubernetesHandle {
  const store = new Map<string, K8sObject>([
    [
      "pods/default/web",
      { kind: "Pod", metadata: { name: "web", namespace: "default" }, status: { phase: "Running" } },
    ],
    [
      "services/default/web",
      { kind: "Service", metadata: { name: "web", namespace: "default" }, spec: { ports: [{ port: 80 }] } },
    ],
    [
      "configmaps/default/app",
      { kind: "ConfigMap", metadata: { name: "app", namespace: "default" }, data: { LOG: "info" } },
    ],
  ]);
  const key = (kind: string, ns: string, name: string) => `${kind}/${ns}/${name}`;
  return {
    async list(kind, namespace) {
      return [...store.values()]
        .filter((o) => o.kind === KINDS[kind] && o.metadata.namespace === namespace)
        .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
    },
    async get(kind, namespace, name) {
      const hit = store.get(key(kind, namespace, name));
      if (!hit) {
        throw new AdapterError("E_NOT_FOUND", `kubernetes ${kind} ${namespace}/${name} missing`, {
          protocol: "kubernetes",
        });
      }
      return { ...hit };
    },
    async close() {
      store.clear();
    },
  };
}

async function httpKubernetes(base: string, timeoutMs: number, token?: string): Promise<KubernetesHandle> {
  const root = base.replace(/\/+$/, "");
  const request = async (path: string) => {
    const headers: Record<string, string> = { accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetchSafe(`${root}${path}`, { method: "GET", headers, timeoutMs });
    const text = await res.text();
    if (res.status === 404) {
      throw new AdapterError("E_NOT_FOUND", `kubernetes ${path} missing`, { protocol: "kubernetes" });
    }
    if (res.status >= 400) {
      throw new AdapterError("E_PROTOCOL", `kubernetes GET ${path} ${res.status}: ${text.slice(0, 200)}`, {
        protocol: "kubernetes",
      });
    }
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  };
  const asList = (json: Record<string, unknown>): K8sObject[] => {
    const items = Array.isArray(json.items) ? json.items : [];
    return items.filter((x): x is K8sObject => Boolean(x) && typeof x === "object");
  };
  return {
    async list(kind, namespace) {
      return asList(await request(`/api/v1/namespaces/${encodeURIComponent(namespace)}/${kind}`));
    },
    async get(kind, namespace, name) {
      return (await request(
        `/api/v1/namespaces/${encodeURIComponent(namespace)}/${kind}/${encodeURIComponent(name)}`,
      )) as K8sObject;
    },
    async close() {
      /* stateless */
    },
  };
}

async function defaultConnect(config: Record<string, unknown>): Promise<KubernetesHandle> {
  const url = stringField(config, "url") ?? stringField(config, "server");
  if (config.simulator === true || !url) return createMemoryKubernetes();
  const timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 4000;
  return httpKubernetes(url, timeoutMs, stringField(config, "token"));
}

export async function listenKubernetesLoopback(mem: KubernetesHandle = createMemoryKubernetes()): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      res.setHeader("content-type", "application/json");
      try {
        if (req.method === "GET" && (path === "/version" || path === "/")) {
          res.end(JSON.stringify({ major: "1", minor: "29", gitVersion: "v1.29.0-e2mcp" }));
          return;
        }
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.end(JSON.stringify({ kind: "Status", message: "writes/exec unsupported" }));
          return;
        }
        const one = /^\/api\/v1\/namespaces\/([^/]+)\/(pods|services|configmaps)\/([^/]+)$/.exec(path);
        if (one) {
          res.end(
            JSON.stringify(
              await mem.get(one[2] as "pods" | "services" | "configmaps", decodeURIComponent(one[1]!), decodeURIComponent(one[3]!)),
            ),
          );
          return;
        }
        const list = /^\/api\/v1\/namespaces\/([^/]+)\/(pods|services|configmaps)$/.exec(path);
        if (list) {
          const items = await mem.list(list[2] as "pods" | "services" | "configmaps", decodeURIComponent(list[1]!));
          res.end(JSON.stringify({ kind: `${KINDS[list[2] as keyof typeof KINDS]}List`, items }));
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ kind: "Status", reason: "NotFound" }));
      } catch (err) {
        res.statusCode = err instanceof AdapterError && err.code === "E_NOT_FOUND" ? 404 : 500;
        res.end(JSON.stringify({ message: err instanceof Error ? err.message : String(err) }));
      }
    })();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as { port: number }).port, close: () => new Promise((r) => server.close(() => r())) };
}

/** Kubernetes API read-only subset. Writes / exec stay E_UNSUPPORTED. */
export class KubernetesAdapter implements ProtocolAdapter {
  readonly protocol = "kubernetes";
  private handle: KubernetesHandle | undefined;
  private connected = false;
  private namespace = "default";

  constructor(
    readonly id: string,
    private readonly connectFn: KubernetesConnectFn = defaultConnect,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    this.namespace = stringField(config, "namespace") ?? "default";
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
    const ns = { type: "string" as const };
    const name = { type: "string" as const };
    return [
      {
        name: "list_pods",
        description: "GET /api/v1/namespaces/{ns}/pods",
        inputSchema: { type: "object", properties: { namespace: ns }, additionalProperties: false },
      },
      {
        name: "get_pod",
        description: "GET /api/v1/namespaces/{ns}/pods/{name}",
        inputSchema: { type: "object", properties: { name, namespace: ns }, required: ["name"], additionalProperties: false },
      },
      {
        name: "list_services",
        description: "GET /api/v1/namespaces/{ns}/services",
        inputSchema: { type: "object", properties: { namespace: ns }, additionalProperties: false },
      },
      {
        name: "get_service",
        description: "GET /api/v1/namespaces/{ns}/services/{name}",
        inputSchema: { type: "object", properties: { name, namespace: ns }, required: ["name"], additionalProperties: false },
      },
      {
        name: "list_configmaps",
        description: "GET /api/v1/namespaces/{ns}/configmaps",
        inputSchema: { type: "object", properties: { namespace: ns }, additionalProperties: false },
      },
      {
        name: "get_configmap",
        description: "GET /api/v1/namespaces/{ns}/configmaps/{name}",
        inputSchema: { type: "object", properties: { name, namespace: ns }, required: ["name"], additionalProperties: false },
      },
      {
        name: "exec",
        description: "Pod exec — not implemented (E_UNSUPPORTED)",
        inputSchema: { type: "object", properties: { name, command: { type: "string" } }, required: ["name"], additionalProperties: false },
      },
      {
        name: "apply",
        description: "Write/apply — not implemented (E_UNSUPPORTED)",
        inputSchema: { type: "object", properties: { manifest: { type: "object" } }, required: ["manifest"], additionalProperties: false },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const ns = typeof args.namespace === "string" && args.namespace ? args.namespace : this.namespace;
    const h = this.handle!;
    if (toolName === "list_pods") return { items: await h.list("pods", ns) };
    if (toolName === "get_pod") return h.get("pods", ns, requiredString(args, "name"));
    if (toolName === "list_services") return { items: await h.list("services", ns) };
    if (toolName === "get_service") return h.get("services", ns, requiredString(args, "name"));
    if (toolName === "list_configmaps") return { items: await h.list("configmaps", ns) };
    if (toolName === "get_configmap") return h.get("configmaps", ns, requiredString(args, "name"));
    if (toolName === "exec" || toolName === "apply") {
      throw new AdapterError(
        "E_UNSUPPORTED",
        `kubernetes ${toolName} is not implemented (read-only subset; no exec/write)`,
        { protocol: "kubernetes" },
      );
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown kubernetes tool "${toolName}"`, { protocol: "kubernetes" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return { ok: true, detail: `kubernetes namespace=${this.namespace} read-only (exec/apply E_UNSUPPORTED)` };
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_NOT_CONNECTED", "kubernetes adapter is not connected", { protocol: "kubernetes" });
    }
  }
}
