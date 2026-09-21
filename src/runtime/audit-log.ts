import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { redactSecrets } from "./redact.js";
import type { InvokeAudit, InvokeAuditEvent } from "./metrics.js";

const MAX_EVENTS = 200;
const logs = new Map<string, AuditLog>();

export function registerAuditLog(log: AuditLog): void {
  logs.set(log.dataDir, log);
}

export function unregisterAuditLog(dataDir: string): void {
  logs.delete(dataDir);
}

export function auditLogFor(dataDir: string | undefined): AuditLog | undefined {
  if (!dataDir) return undefined;
  return logs.get(dataDir);
}

/** Append-only JSONL of invoke / policy / mode_change events. Restart reloads the tail. */
export class AuditLog {
  readonly filePath: string;
  private events: InvokeAuditEvent[] = [];
  private counts: InvokeAudit = { success: 0, fail: 0 };
  private writeChain: Promise<void> = Promise.resolve();

  constructor(readonly dataDir: string) {
    this.filePath = join(dataDir, "audit.jsonl");
  }

  async restore(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const loaded: InvokeAuditEvent[] = [];
      let success = 0;
      let fail = 0;
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = redactSecrets(JSON.parse(line) as InvokeAuditEvent);
          if (!parsed || typeof parsed.at !== "string") continue;
          loaded.push(parsed);
          if (parsed.ok) success += 1;
          else fail += 1;
        } catch {
          /* skip corrupt line */
        }
      }
      this.events = loaded.slice(-MAX_EVENTS);
      this.counts = { success, fail };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.events = [];
        this.counts = { success: 0, fail: 0 };
        return;
      }
      throw err;
    }
  }

  record(event: InvokeAuditEvent): void {
    const ev = redactSecrets({ ...event });
    this.events.push(ev);
    if (ev.ok) this.counts.success += 1;
    else this.counts.fail += 1;
    if (this.events.length > MAX_EVENTS) this.events.shift();
    const line = `${JSON.stringify(ev)}\n`;
    this.writeChain = this.writeChain
      .then(async () => {
        await mkdir(dirname(this.filePath), { recursive: true });
        await appendFile(this.filePath, line, "utf8");
      })
      .catch(() => undefined);
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  snapshot(limit = 50): { counts: InvokeAudit; events: InvokeAuditEvent[] } {
    const n = Number.isFinite(limit) ? Math.max(0, Math.min(MAX_EVENTS, Math.floor(limit))) : 50;
    return {
      counts: { success: this.counts.success, fail: this.counts.fail },
      events: this.events.slice(-n).reverse(),
    };
  }
}
