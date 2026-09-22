import { createAdapter, knownProtocols, type ProtocolAdapter } from "../runtime/bootstrap.js";
import { AdapterError } from "../runtime/errors.js";
import { invokeWithMiddleware } from "../runtime/invoke.js";
import { log } from "../runtime/log.js";
import type {
  AdapterSnapshot,
  JsonObject,
  McpToolSchema,
  RegistrationRecord,
} from "../runtime/types.js";
import { inferIngress } from "./ingress.js";
import { assertNotBlacklisted, type BlacklistStore } from "./blacklist.js";
import { JsonStore } from "./store.js";

export interface LiveInstance {
  record: RegistrationRecord;
  adapter: ProtocolAdapter;
  tools: McpToolSchema[];
}

interface ToolBinding {
  registrationId: string;
  localName: string;
}

export class ToolRegistry {
  private readonly live = new Map<string, LiveInstance>();
  private readonly toolIndex = new Map<string, ToolBinding>();
  private readonly failed = new Map<string, { record: RegistrationRecord; error: string }>();
  private onChangeHandler: (() => void) | undefined;

  constructor(
    private readonly store: JsonStore,
    private readonly blacklist?: BlacklistStore,
  ) {}

  onChange(handler: () => void): void {
    this.onChangeHandler = handler;
  }

  async restore(): Promise<void> {
    const records = await this.store.load();
    for (const record of records) {
      try {
        await this.mount(record);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log("failed to restore registration", { id: record.id, error });
        this.failed.set(record.id, { record, error });
      }
    }
    this.emitChange();
  }

  async hotRegister(protocol: string, name: string, config: JsonObject): Promise<LiveInstance> {
    return this.add(protocol, name, config);
  }

  async unregister(id: string): Promise<boolean> {
    return this.remove(id);
  }

  async add(protocol: string, name: string, config: JsonObject): Promise<LiveInstance> {
    await assertNotBlacklisted(this.blacklist, protocol, config);
    const id = makeId(protocol, name);
    if (this.live.has(id)) {
      throw new AdapterError("E_CONFLICT", `Registration already exists: ${id}`, { details: { id } });
    }
    const now = new Date().toISOString();
    const record: RegistrationRecord = {
      id,
      name,
      protocol: protocol.toLowerCase(),
      config,
      createdAt: now,
      updatedAt: now,
    };
    const instance = await this.mount(record);
    await this.store.upsert(record);
    this.failed.delete(id);
    this.emitChange();
    return instance;
  }

  async update(id: string, config: JsonObject): Promise<LiveInstance> {
    const record =
      this.live.get(id)?.record ?? this.failed.get(id)?.record ?? (await this.findPersisted(id));
    if (!record) throw new AdapterError("E_NOT_FOUND", `Unknown registration id: ${id}`, { details: { id } });

    const merged: RegistrationRecord = {
      ...record,
      config: { ...record.config, ...config },
      updatedAt: new Date().toISOString(),
    };
    await assertNotBlacklisted(this.blacklist, merged.protocol, merged.config);
    await this.unmount(id);
    const instance = await this.mount(merged);
    await this.store.upsert(merged);
    this.failed.delete(id);
    this.emitChange();
    return instance;
  }

  async remove(id: string): Promise<boolean> {
    const hadLive = this.live.has(id) || this.failed.has(id);
    await this.unmount(id);
    this.failed.delete(id);
    const hadStore = await this.store.remove(id);
    if (hadLive || hadStore) this.emitChange();
    return hadLive || hadStore;
  }

  list(): {
    adapters: AdapterSnapshot[];
    tools: Array<McpToolSchema & { adapterId: string; protocol: string }>;
    protocols: string[];
  } {
    const adapters: AdapterSnapshot[] = [];
    const tools: Array<McpToolSchema & { adapterId: string; protocol: string }> = [];

    for (const inst of this.live.values()) {
      adapters.push({
        id: inst.record.id,
        name: inst.record.name,
        protocol: inst.record.protocol,
        toolCount: inst.tools.length,
        tools: inst.tools.map((t) => t.name),
        status: "live",
        ingress: inferIngress(inst.record.protocol, inst.record.config),
      });
      for (const tool of inst.tools) {
        tools.push({ ...tool, adapterId: inst.record.id, protocol: inst.record.protocol });
      }
    }
    for (const fail of this.failed.values()) {
      adapters.push({
        id: fail.record.id,
        name: fail.record.name,
        protocol: fail.record.protocol,
        toolCount: 0,
        tools: [],
        status: "restore_failed",
        error: fail.error,
        ingress: inferIngress(fail.record.protocol, fail.record.config),
      });
    }
    adapters.sort((a, b) => a.id.localeCompare(b.id));
    return { adapters, tools, protocols: knownProtocols() };
  }

  queryByProtocol(protocol: string): ReturnType<ToolRegistry["list"]> {
    const wanted = protocol.toLowerCase();
    const all = this.list();
    return {
      adapters: all.adapters.filter((a) => a.protocol === wanted),
      tools: all.tools.filter((t) => t.protocol === wanted),
      protocols: all.protocols,
    };
  }

  adapterTools(): McpToolSchema[] {
    const tools: McpToolSchema[] = [];
    for (const inst of this.live.values()) tools.push(...inst.tools);
    return tools;
  }

  lookupTool(toolName: string): {
    name: string;
    localName: string;
    adapterId: string;
    protocol: string;
    adapterName: string;
    schema?: McpToolSchema;
    configKeys: string[];
  } | undefined {
    const binding = this.toolIndex.get(toolName);
    if (!binding) return undefined;
    const inst = this.live.get(binding.registrationId);
    if (!inst) return undefined;
    return {
      name: toolName,
      localName: binding.localName,
      adapterId: inst.record.id,
      protocol: inst.record.protocol,
      adapterName: inst.record.name,
      schema: inst.tools.find((t) => t.name === toolName),
      configKeys: Object.keys(inst.record.config),
    };
  }

  get(id: string): LiveInstance | undefined {
    return this.live.get(id);
  }

  /** Live or restore-failed registration, if any. */
  getRecord(id: string): RegistrationRecord | undefined {
    return this.live.get(id)?.record ?? this.failed.get(id)?.record;
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const binding = this.toolIndex.get(toolName);
    if (!binding) throw new AdapterError("E_UNKNOWN_TOOL", `Unknown tool: ${toolName}`, { details: { tool: toolName } });
    const inst = this.live.get(binding.registrationId);
    if (!inst) {
      throw new AdapterError("E_NOT_CONNECTED", `Tool ${toolName} is not bound to a live adapter`, {
        details: { tool: toolName },
      });
    }
    await assertNotBlacklisted(this.blacklist, inst.record.protocol, inst.record.config);
    const rawTimeout = inst.record.config.timeoutMs;
    const timeoutMs = typeof rawTimeout === "number" && rawTimeout > 0 ? rawTimeout : undefined;
    return invokeWithMiddleware(() => inst.adapter.invoke(binding.localName, args), {
      timeoutMs,
      tool: toolName,
      protocol: inst.record.protocol,
      adapterId: inst.record.id,
      dataDir: this.store.dataDir,
    });
  }

  async shutdown(): Promise<void> {
    const ids = [...this.live.keys()];
    for (const id of ids) {
      await this.unmount(id);
    }
  }

  async enrichHealth(adapters: AdapterSnapshot[]): Promise<AdapterSnapshot[]> {
    const out: AdapterSnapshot[] = [];
    for (const snap of adapters) {
      const inst = this.live.get(snap.id);
      if (!inst) {
        out.push(snap);
        continue;
      }
      try {
        const health = inst.adapter.health ? await inst.adapter.health() : { ok: true };
        out.push({ ...snap, health });
      } catch (err) {
        out.push({
          ...snap,
          health: { ok: false, detail: err instanceof Error ? err.message : String(err) },
        });
      }
    }
    return out;
  }

  private async mount(record: RegistrationRecord): Promise<LiveInstance> {
    const adapter = createAdapter(record.protocol, record.id);
    try {
      await adapter.connect(record.config);
      const localTools = await adapter.listTools();
      const tools = localTools.map((tool) => ({
        ...tool,
        name: qualify(record.protocol, record.name, tool.name),
        annotations: {
          title: `Business · ${record.protocol}.${tool.name}`,
          openWorldHint: true,
          ...tool.annotations,
        },
        _meta: { layer: "business" as const, adapterId: record.id, protocol: record.protocol, ...(tool._meta ?? {}) },
      }));
      const inst: LiveInstance = { record, adapter, tools };
      this.live.set(record.id, inst);
      for (const [i, tool] of tools.entries()) {
        const local = localTools[i];
        if (!local) continue;
        this.toolIndex.set(tool.name, { registrationId: record.id, localName: local.name });
      }
      return inst;
    } catch (err) {
      try {
        await adapter.disconnect();
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  private async unmount(id: string): Promise<void> {
    const inst = this.live.get(id);
    if (!inst) return;
    for (const tool of inst.tools) this.toolIndex.delete(tool.name);
    this.live.delete(id);
    try {
      await inst.adapter.disconnect();
    } catch (err) {
      log("adapter disconnect error", { id, error: String(err) });
    }
  }

  private async findPersisted(id: string): Promise<RegistrationRecord | undefined> {
    const all = await this.store.load();
    return all.find((r) => r.id === id);
  }

  private emitChange(): void {
    this.onChangeHandler?.();
  }
}

export function makeId(protocol: string, name: string): string {
  return `${protocol.toLowerCase()}:${name}`;
}

export function qualify(protocol: string, name: string, op: string): string {
  return `${protocol.toLowerCase()}.${name}.${op}`;
}
