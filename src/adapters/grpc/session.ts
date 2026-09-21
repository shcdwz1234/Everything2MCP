import * as grpc from "@grpc/grpc-js";
import { AdapterError } from "../../runtime/errors.js";
import { assertRpcCanWrite } from "../rpc-gate.js";

export const MAX_SESSION_BUFFER = 256;
export const DEFAULT_SESSION_BUFFER = 32;

export interface BidiMethodRef {
  localName: string;
  serviceName: string;
  originalName: string;
  path: string;
  kind: "bidi-stream";
  client: grpc.Client;
  metadata: grpc.Metadata;
}

export interface BidiOpenResult {
  streamId: string;
  method: string;
  path: string;
  maxMessages: number;
  timeoutMs: number;
}

export interface BidiSendResult {
  streamId: string;
  written: true;
  ended: boolean;
}

export interface BidiRecvResult {
  streamId: string;
  messages: unknown[];
  count: number;
  truncated: boolean;
  ended: boolean;
  cancelled: boolean;
  paused: boolean;
  window: { maxMessages: number; buffered: number };
}

export interface BidiCloseResult {
  streamId: string;
  cancelled: boolean;
  closed: true;
}

export interface BidiStatusResult {
  streamId: string;
  method: string;
  path: string;
  ended: boolean;
  cancelled: boolean;
  closed: boolean;
  clientEnded: boolean;
  buffered: number;
  received: number;
  paused: boolean;
  maxMessages: number;
}

interface Session {
  id: string;
  method: BidiMethodRef;
  stream: grpc.ClientDuplexStream<unknown, unknown>;
  inbox: unknown[];
  waiters: Array<{
    resolve: (msgs: unknown[]) => void;
    reject: (err: Error) => void;
    want: number;
    timer: ReturnType<typeof setTimeout>;
  }>;
  maxMessages: number;
  received: number;
  paused: boolean;
  clientEnded: boolean;
  serverEnded: boolean;
  cancelled: boolean;
  closed: boolean;
  fail?: Error;
}

function newStreamId(): string {
  return `bidi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function findClientFn(client: Record<string, unknown>, originalName: string): (...args: unknown[]) => unknown {
  const camel = originalName.charAt(0).toLowerCase() + originalName.slice(1);
  const fn = client[originalName] ?? client[camel];
  if (typeof fn !== "function") {
    throw new AdapterError("E_INVALID_CONFIG", `Client has no method ${originalName}`, { protocol: "grpc" });
  }
  return fn as (...args: unknown[]) => unknown;
}

/**
 * Long-lived bidi sessions: open_stream / send / recv / close.
 * Backpressure: pause the gRPC stream when unread inbox hits maxMessages.
 * Cancel: bidi_close or adapter disconnect. allowWrite gates open + send.
 */
export class BidiSessionHub {
  private readonly sessions = new Map<string, Session>();

  get size(): number {
    return this.sessions.size;
  }

  open(
    method: BidiMethodRef,
    args: Record<string, unknown>,
    allowWrite: boolean,
  ): BidiOpenResult {
    assertRpcCanWrite("grpc", allowWrite, method.originalName);
    const maxMessages = clampInt(args.maxMessages, 1, MAX_SESSION_BUFFER, DEFAULT_SESSION_BUFFER);
    const timeoutMs = clampInt(args.timeoutMs, 1, 3_600_000, 60_000);
    const deadline = new Date(Date.now() + timeoutMs);
    const client = method.client as grpc.Client & Record<string, unknown>;
    const fn = findClientFn(client, method.originalName);
    const stream = fn.call(client, method.metadata, { deadline }) as grpc.ClientDuplexStream<unknown, unknown>;
    const id = newStreamId();
    const session: Session = {
      id,
      method,
      stream,
      inbox: [],
      waiters: [],
      maxMessages,
      received: 0,
      paused: false,
      clientEnded: false,
      serverEnded: false,
      cancelled: false,
      closed: false,
    };
    stream.on("data", (msg) => {
      session.received += 1;
      session.inbox.push(msg);
      if (session.inbox.length >= session.maxMessages && !session.paused) {
        try {
          stream.pause();
        } catch {
          /* ignore */
        }
        session.paused = true;
      }
      this.flushWaiters(session);
    });
    stream.on("end", () => {
      session.serverEnded = true;
      this.flushWaiters(session);
    });
    stream.on("error", (err: Error) => {
      if (session.closed || session.cancelled) {
        session.serverEnded = true;
        this.flushWaiters(session);
        return;
      }
      if (/CANCELLED|cancelled/i.test(err.message)) {
        session.cancelled = true;
        session.serverEnded = true;
        this.flushWaiters(session);
        return;
      }
      session.fail = new AdapterError("E_PROTOCOL", `gRPC ${method.path} session failed: ${err.message}`, {
        protocol: "grpc",
      });
      this.failWaiters(session, session.fail);
    });
    this.sessions.set(id, session);
    return { streamId: id, method: method.localName, path: method.path, maxMessages, timeoutMs };
  }

  send(streamId: string, message: Record<string, unknown>, end: boolean, allowWrite: boolean): BidiSendResult {
    const session = this.require(streamId);
    assertRpcCanWrite("grpc", allowWrite, session.method.originalName);
    if (session.closed || session.cancelled) {
      throw new AdapterError("E_PROTOCOL", `gRPC bidi stream ${streamId} is closed`, { protocol: "grpc" });
    }
    if (session.clientEnded) {
      throw new AdapterError("E_PROTOCOL", `gRPC bidi stream ${streamId} client half already ended`, {
        protocol: "grpc",
      });
    }
    if (session.fail) throw session.fail;
    try {
      session.stream.write(message);
      if (end) {
        session.stream.end();
        session.clientEnded = true;
      }
    } catch (err) {
      throw new AdapterError(
        "E_PROTOCOL",
        `gRPC bidi send failed: ${err instanceof Error ? err.message : String(err)}`,
        { protocol: "grpc" },
      );
    }
    return { streamId, written: true, ended: session.clientEnded };
  }

  recv(streamId: string, maxMessages: unknown, timeoutMs: unknown): Promise<BidiRecvResult> {
    const session = this.require(streamId);
    if (session.fail) return Promise.reject(session.fail);
    const want = clampInt(maxMessages, 1, session.maxMessages, 1);
    const ms = clampInt(timeoutMs, 1, 3_600_000, 10_000);
    return new Promise((resolve, reject) => {
      const deliver = (msgs: unknown[]) => {
        this.maybeResume(session);
        resolve({
          streamId,
          messages: msgs,
          count: msgs.length,
          truncated: msgs.length >= want && session.inbox.length > 0,
          ended: session.serverEnded && session.inbox.length === 0,
          cancelled: session.cancelled,
          paused: session.paused,
          window: { maxMessages: session.maxMessages, buffered: session.inbox.length },
        });
      };
      if (session.inbox.length > 0 || session.serverEnded || session.closed) {
        deliver(session.inbox.splice(0, want));
        return;
      }
      const entry = {
        resolve: (msgs: unknown[]) => deliver(msgs),
        reject,
        want,
        timer: setTimeout(() => {
          const idx = session.waiters.indexOf(entry);
          if (idx >= 0) session.waiters.splice(idx, 1);
          reject(
            new AdapterError("E_TIMEOUT", `Timed out waiting for gRPC bidi recv on ${streamId} after ${ms}ms`, {
              protocol: "grpc",
            }),
          );
        }, ms),
      };
      session.waiters.push(entry);
    });
  }

  close(streamId: string): BidiCloseResult {
    const session = this.require(streamId);
    session.cancelled = true;
    session.closed = true;
    session.serverEnded = true;
    try {
      session.stream.cancel();
    } catch {
      /* ignore */
    }
    this.failWaiters(
      session,
      new AdapterError("E_PROTOCOL", `gRPC bidi stream ${streamId} cancelled`, { protocol: "grpc" }),
    );
    this.sessions.delete(streamId);
    return { streamId, cancelled: true, closed: true };
  }

  status(streamId: string): BidiStatusResult {
    const session = this.require(streamId);
    return {
      streamId,
      method: session.method.localName,
      path: session.method.path,
      ended: session.serverEnded,
      cancelled: session.cancelled,
      closed: session.closed,
      clientEnded: session.clientEnded,
      buffered: session.inbox.length,
      received: session.received,
      paused: session.paused,
      maxMessages: session.maxMessages,
    };
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) {
      try {
        this.close(id);
      } catch {
        /* ignore */
      }
    }
  }

  private require(streamId: string): Session {
    const session = this.sessions.get(streamId);
    if (!session) {
      throw new AdapterError("E_INVALID_CONFIG", `Unknown or closed gRPC bidi stream "${streamId}"`, {
        protocol: "grpc",
      });
    }
    return session;
  }

  private flushWaiters(session: Session): void {
    while (session.waiters.length && (session.inbox.length > 0 || session.serverEnded || session.closed)) {
      const waiter = session.waiters.shift();
      if (!waiter) break;
      clearTimeout(waiter.timer);
      waiter.resolve(session.inbox.splice(0, waiter.want));
    }
  }

  private failWaiters(session: Session, err: Error): void {
    while (session.waiters.length) {
      const waiter = session.waiters.shift();
      if (!waiter) break;
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
  }

  private maybeResume(session: Session): void {
    if (session.paused && session.inbox.length < session.maxMessages && !session.closed) {
      try {
        session.stream.resume();
      } catch {
        /* ignore */
      }
      session.paused = false;
    }
  }
}
