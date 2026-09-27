import { auditLogFor } from "./audit-log.js";
import { log } from "./log.js";
import { redactSecrets } from "./redact.js";

/** Process-wide adapter invoke counters (P6 audit hook). */
export interface InvokeAudit {
  success: number;
  fail: number;
}

/** One invoke in the in-memory ring (console audit timeline). */
export interface InvokeAuditEvent {
  at: string;
  ok: boolean;
  kind?: "invoke" | "mode_change" | "policy" | "unregister" | "discovery";
  tool?: string;
  protocol?: string;
  adapterId?: string;
  code?: string;
  detail?: string;
}

const MAX_EVENTS = 200;
const audit: InvokeAudit = { success: 0, fail: 0 };
const events: InvokeAuditEvent[] = [];

export function invokeAudit(): InvokeAudit {
  return { success: audit.success, fail: audit.fail };
}

export function invokeAuditEvents(limit = 50): InvokeAuditEvent[] {
  const n = Number.isFinite(limit) ? Math.max(0, Math.min(MAX_EVENTS, Math.floor(limit))) : 50;
  return events.slice(-n).reverse();
}

export function resetInvokeAudit(): void {
  audit.success = 0;
  audit.fail = 0;
  events.length = 0;
}

export function recordAdapterInvoke(ok: boolean, extra?: Record<string, unknown>): InvokeAudit {
  if (ok) audit.success += 1;
  else audit.fail += 1;
  const event: InvokeAuditEvent = redactSecrets({
    at: new Date().toISOString(),
    ok,
    kind:
      extra?.kind === "mode_change" || extra?.kind === "policy" || extra?.kind === "unregister" || extra?.kind === "discovery"
        ? extra.kind
        : "invoke",
    tool: typeof extra?.tool === "string" ? extra.tool : undefined,
    protocol: typeof extra?.protocol === "string" ? extra.protocol : undefined,
    adapterId: typeof extra?.adapterId === "string" ? extra.adapterId : undefined,
    code: typeof extra?.code === "string" ? extra.code : undefined,
    detail: typeof extra?.detail === "string" ? extra.detail : undefined,
  });
  events.push(event);
  if (events.length > MAX_EVENTS) events.shift();
  const dataDir = typeof extra?.dataDir === "string" ? extra.dataDir : undefined;
  auditLogFor(dataDir)?.record(event);
  const snapshot = invokeAudit();
  log(ok ? "adapter invoke ok" : "adapter invoke fail", redactSecrets({ ...snapshot, ...extra, dataDir: undefined }));
  return snapshot;
}

/** Security plane events (mode_change / policy deny) share the same ring. */
export function recordSecurityEvent(extra: Record<string, unknown>): InvokeAudit {
  return recordAdapterInvoke(extra.ok !== false, extra);
}
