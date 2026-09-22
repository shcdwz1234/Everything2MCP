import { existsSync, readFileSync } from "node:fs";
import { AdapterError } from "../../runtime/errors.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowShellFrom, assertCanShell, osFamily } from "../platform/common.js";

export interface JournalHandle {
  read(limit: number): Promise<{ source: string; format: string; lines: string[]; events?: Array<Record<string, string>> }>;
  close(): Promise<void>;
}

export type JournalConnectFn = (config: Record<string, unknown>) => Promise<JournalHandle>;

export function parseJournalExport(raw: string): Array<Record<string, string>> {
  const events: Array<Record<string, string>> = [];
  let cur: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      if (Object.keys(cur).length) events.push(cur);
      cur = {};
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    cur[line.slice(0, eq)] = line.slice(eq + 1);
  }
  if (Object.keys(cur).length) events.push(cur);
  return events;
}

export function parseEvtxXml(raw: string): Array<Record<string, string>> {
  const events: Array<Record<string, string>> = [];
  const blocks = raw.split(/<Event\b/i).slice(1);
  for (const block of blocks) {
    const id = /<EventID[^>]*>(\d+)<\/EventID>/i.exec(block)?.[1] ?? "";
    const provider = /<Provider[^>]*Name="([^"]+)"/i.exec(block)?.[1] ?? "";
    const time = /<TimeCreated[^>]*SystemTime="([^"]+)"/i.exec(block)?.[1] ?? "";
    const data = /<EventData[^>]*>([\s\S]*?)<\/EventData>/i.exec(block)?.[1]?.replace(/<[^>]+>/g, " ").trim() ?? "";
    const message = /<Message[^>]*>([\s\S]*?)<\/Message>/i.exec(block)?.[1]?.trim() ?? data;
    events.push({ EventID: id, Provider: provider, TimeCreated: time, Message: message });
  }
  return events;
}

export function createMemoryJournal(lines?: string[]): JournalHandle {
  const stored = [...(lines ?? ["e2mcp: journal simulator line 1", "e2mcp: journal simulator line 2"])];
  return {
    async read(limit) {
      return { source: "simulator", format: "syslog", lines: stored.slice(-limit) };
    },
    async close() {
      stored.length = 0;
    },
  };
}

function fileHandle(file: string, format: string): JournalHandle {
  return {
    async read(limit) {
      const raw = readFileSync(file, "utf8");
      if (format === "journal-export") {
        const events = parseJournalExport(raw).slice(-limit);
        return {
          source: file,
          format,
          lines: events.map((e) => e.MESSAGE ?? JSON.stringify(e)),
          events,
        };
      }
      if (format === "evtx-xml") {
        const events = parseEvtxXml(raw).slice(-limit);
        return {
          source: file,
          format,
          lines: events.map((e) => `${e.EventID} ${e.Provider} ${e.Message}`.trim()),
          events,
        };
      }
      const lines = raw.split(/\r?\n/).filter(Boolean);
      return { source: file, format: "syslog", lines: lines.slice(-limit) };
    },
    async close() {
      /* file */
    },
  };
}

export class JournalAdapter implements ProtocolAdapter {
  readonly protocol = "journal";
  private handle: JournalHandle | undefined;
  private allowShell = false;
  private connectFn: JournalConnectFn;

  constructor(readonly id: string, connectFn?: JournalConnectFn) {
    this.connectFn = connectFn ?? ((cfg) => defaultConnect(cfg, allowShellFrom(cfg)));
  }

  async connect(config: Record<string, unknown>): Promise<void> {
    this.allowShell = allowShellFrom(config);
    this.handle = await this.connectFn(config);
  }

  async disconnect(): Promise<void> {
    await this.handle?.close();
    this.handle = undefined;
  }

  async listTools(): Promise<McpToolSchema[]> {
    return [
      {
        name: "read",
        description:
          "Read last N log lines. Supports syslog files, systemd journal export (key=value), and Windows Event XML export. journalctl/wevtutil stay E_UNSUPPORTED stubs.",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "integer", default: 40 } },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.handle) throw new AdapterError("E_NOT_CONNECTED", "journal not connected", { protocol: this.protocol });
    if (toolName !== "read") throw new AdapterError("E_UNKNOWN_TOOL", `Unknown tool ${toolName}`, { protocol: this.protocol });
    const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(args.limit, 200) : 40;
    return this.handle.read(limit);
  }

  async health(): Promise<AdapterHealth> {
    return { ok: Boolean(this.handle), detail: `allowShell=${this.allowShell}` };
  }
}

function detectFormat(config: Record<string, unknown>, path: string, family: string): string {
  if (typeof config.format === "string" && config.format.trim()) return config.format.trim();
  if (/\.xml$/i.test(path) || family === "win32") return "evtx-xml";
  if (/journal|export/i.test(path)) return "journal-export";
  return "syslog";
}

async function defaultConnect(config: Record<string, unknown>, allowShell: boolean): Promise<JournalHandle> {
  if (config.simulator === true) return createMemoryJournal();
  const family = osFamily(typeof config.platform === "string" ? (config.platform as NodeJS.Platform) : process.platform);
  const file =
    typeof config.path === "string"
      ? config.path
      : family === "linux"
        ? ["/var/log/syslog", "/var/log/messages"].find((p) => existsSync(p))
        : undefined;
  if (file) return fileHandle(file, detectFormat(config, file, family));
  if (family === "win32") {
    assertCanShell("journal", allowShell);
    throw new AdapterError(
      "E_UNSUPPORTED",
      "Windows Event Log (wevtutil) is not implemented; provide config.path to an Event XML export or simulator:true",
      { protocol: "journal" },
    );
  }
  if (family === "linux") {
    assertCanShell("journal", allowShell);
    throw new AdapterError("E_UNSUPPORTED", "journalctl binary path is a stub; no syslog file found", {
      protocol: "journal",
    });
  }
  throw new AdapterError("E_UNSUPPORTED", `journal read unsupported on ${family} without simulator or path`, {
    protocol: "journal",
  });
}
