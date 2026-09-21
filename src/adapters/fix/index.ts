import { AdapterError } from "../../runtime/errors.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { requiredNumber, requiredString, stringField } from "../helpers.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";
import {
  decodeFix,
  encodeFix,
  executionReport,
  heartbeat,
  logon,
  logout,
  MSG,
  newOrderSingle,
  resendRequest,
  sequenceResetGapFill,
  withPossDup,
} from "./codec.js";

export type FixTransport = (outbound: string) => Promise<string | undefined>;

export type SessionState = "disconnected" | "logged_on";

/** In-memory counterparty: replies to logon/heartbeat/logout/NOS. Not an exchange matching engine. */
export function createLoopbackTransport(): FixTransport {
  let peerSeq = 1;
  return async (outbound) => {
    const fields = decodeFix(outbound);
    const sender = fields["56"] ?? "TARGET";
    const target = fields["49"] ?? "SENDER";
    const type = fields["35"];
    if (type === MSG.Logon) {
      const hb = Number(fields["108"] ?? 30);
      return logon(peerSeq++, sender, target, Number.isFinite(hb) ? hb : 30);
    }
    if (type === MSG.Heartbeat) return heartbeat(peerSeq++, sender, target);
    if (type === MSG.Logout) return logout(peerSeq++, sender, target, "logged out");
    if (type === MSG.NewOrderSingle) {
      return executionReport(peerSeq++, sender, target, {
        clOrdId: fields["11"] ?? "",
        execId: `e${peerSeq}`,
        symbol: fields["55"],
      });
    }
    if (fields["43"] === "Y") return undefined;
    if (type === MSG.ResendRequest) {
      const begin = Number(fields["7"] ?? 1);
      const end = Number(fields["16"] ?? 0);
      const last = Number.isFinite(end) && end > 0 ? end : begin;
      const newSeqNo = (Number.isFinite(last) ? last : begin) + 1;
      return sequenceResetGapFill(peerSeq++, sender, target, newSeqNo);
    }
    return undefined;
  };
}

/**
 * Minimal FIX 4.2 session: logon / heartbeat / logout + sequence numbers over an injectable transport.
 * Default transport is in-memory loopback. resend_request sends 35=2 on the wire;
 * loopback replies SequenceReset 35=4 GapFill. Local outbox is still replayed and
 * holes are listed as gaps (not a drop-copy / not an exchange matching engine).
 */
export class FixAdapter implements ProtocolAdapter {
  readonly protocol = "fix";
  private connected = false;
  private sender = "SENDER";
  private target = "TARGET";
  private seq = 1;
  private lastIn = 0;
  private beginString = "FIX.4.2";
  private state: SessionState = "disconnected";
  private transport: FixTransport = createLoopbackTransport();
  private heartBtInt = 30;
  private allowWrite = false;
  private outbox = new Map<number, string>();

  constructor(
    readonly id: string,
    private readonly transportFn?: (config: Record<string, unknown>) => FixTransport,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    this.sender = stringField(config, "sender") ?? stringField(config, "senderCompId") ?? "SENDER";
    this.target = stringField(config, "target") ?? stringField(config, "targetCompId") ?? "TARGET";
    this.beginString = stringField(config, "beginString") ?? "FIX.4.2";
    this.seq = typeof config.nextSeq === "number" ? config.nextSeq : 1;
    this.lastIn = 0;
    this.state = "disconnected";
    this.transport = this.transportFn?.(config) ?? createLoopbackTransport();
    this.allowWrite = allowWriteFrom(config);
    this.outbox.clear();
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.state = "disconnected";
  }

  async listTools(): Promise<McpToolSchema[]> {
    this.assertConnected();
    return [
      {
        name: "encode",
        description: "Build a FIX message from MsgType + fields (does not send)",
        inputSchema: {
          type: "object",
          properties: {
            msgType: { type: "string" },
            fields: { type: "object", additionalProperties: true },
          },
          required: ["msgType"],
          additionalProperties: false,
        },
      },
      {
        name: "decode",
        description: "Parse a FIX string (SOH or | separated)",
        inputSchema: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false,
        },
      },
      {
        name: "logon",
        description: "Send Logon (35=A). Session control is a write: requires allowWrite=true",
        inputSchema: {
          type: "object",
          properties: { heartBtInt: { type: "integer", default: 30 } },
          additionalProperties: false,
        },
      },
      {
        name: "heartbeat",
        description: "Send Heartbeat (35=0); requires logged-on session",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "logout",
        description: "Send Logout (35=5) and drop the session. Session control is a write: requires allowWrite=true",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          additionalProperties: false,
        },
      },
      {
        name: "new_order_single",
        description: "Send NewOrderSingle (35=D); requires logged-on session and allowWrite=true",
        inputSchema: {
          type: "object",
          properties: {
            clOrdId: { type: "string" },
            symbol: { type: "string" },
            side: { type: "string", description: "1=Buy 2=Sell" },
            qty: { type: "number" },
            price: { type: "number" },
          },
          required: ["clOrdId", "symbol", "side", "qty"],
          additionalProperties: false,
        },
      },
      {
        name: "session_status",
        description: "Session state and sequence numbers",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "resend_request",
        description:
          "Send Resend Request (35=2). Loopback replies SequenceReset (35=4) GapFill. Outbox hits resent with PossDupFlag=Y; holes listed as gaps. Session write: allowWrite=true.",
        inputSchema: {
          type: "object",
          properties: {
            beginSeq: { type: "integer", default: 1 },
            endSeq: { type: "integer", description: "0 or omit = last sent" },
          },
          additionalProperties: false,
        },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    if (toolName === "decode") {
      return { fields: decodeFix(requiredString(args, "message")) };
    }
    if (toolName === "encode") {
      const msgType = requiredString(args, "msgType");
      const fields = (args.fields && typeof args.fields === "object" ? args.fields : {}) as Record<
        string,
        string | number
      >;
      const message = encodeFix({
        BeginString: this.beginString,
        MsgType: msgType,
        SenderCompID: this.sender,
        TargetCompID: this.target,
        MsgSeqNum: this.seq++,
        ...fields,
      });
      return { message, fields: decodeFix(message), seq: this.seq - 1 };
    }
    if (toolName === "session_status") {
      return this.snapshot();
    }
    if (toolName === "logon") {
      assertCanWrite("fix", this.allowWrite);
      this.heartBtInt = typeof args.heartBtInt === "number" ? args.heartBtInt : 30;
      const outbound = logon(this.seq++, this.sender, this.target, this.heartBtInt);
      this.rememberOutbound(outbound);
      const reply = await this.transport(outbound);
      const inbound = reply ? decodeFix(reply) : undefined;
      if (!inbound || inbound["35"] !== MSG.Logon) {
        this.seq -= 1;
        throw new AdapterError("E_PROTOCOL", "FIX logon did not receive a Logon (35=A) reply", {
          protocol: "fix",
          details: { inbound },
        });
      }
      this.noteInbound(inbound);
      this.state = "logged_on";
      return { message: outbound, reply, fields: inbound, ...this.snapshot() };
    }
    if (toolName === "heartbeat") {
      this.requireLoggedOn("heartbeat");
      const outbound = heartbeat(this.seq++, this.sender, this.target);
      this.rememberOutbound(outbound);
      const reply = await this.transport(outbound);
      if (reply) this.noteInbound(decodeFix(reply));
      return { message: outbound, reply, msgType: MSG.Heartbeat, fields: decodeFix(outbound), ...this.snapshot() };
    }
    if (toolName === "logout") {
      assertCanWrite("fix", this.allowWrite);
      this.requireLoggedOn("logout");
      const outbound = logout(this.seq++, this.sender, this.target, typeof args.text === "string" ? args.text : "bye");
      this.rememberOutbound(outbound);
      const reply = await this.transport(outbound);
      if (reply) this.noteInbound(decodeFix(reply));
      this.state = "disconnected";
      return { message: outbound, reply, msgType: MSG.Logout, ...this.snapshot() };
    }
    if (toolName === "new_order_single") {
      assertCanWrite("fix", this.allowWrite);
      this.requireLoggedOn("new_order_single");
      const outbound = newOrderSingle(this.seq++, this.sender, this.target, {
        clOrdId: requiredString(args, "clOrdId"),
        symbol: requiredString(args, "symbol"),
        side: requiredString(args, "side") === "2" ? "2" : "1",
        qty: requiredNumber(args, "qty"),
        price: typeof args.price === "number" ? args.price : undefined,
      });
      this.rememberOutbound(outbound);
      const reply = await this.transport(outbound);
      if (reply) this.noteInbound(decodeFix(reply));
      return { message: outbound, reply, msgType: MSG.NewOrderSingle, fields: decodeFix(outbound), ...this.snapshot() };
    }
    if (toolName === "resend_request") {
      assertCanWrite("fix", this.allowWrite);
      this.requireLoggedOn("resend_request");
      const beginSeq = typeof args.beginSeq === "number" && args.beginSeq > 0 ? Math.floor(args.beginSeq) : 1;
      const lastSent = this.seq - 1;
      const endSeq =
        typeof args.endSeq === "number" && args.endSeq > 0 ? Math.min(Math.floor(args.endSeq), lastSent) : lastSent;
      const request = resendRequest(this.seq++, this.sender, this.target, beginSeq, endSeq);
      this.rememberOutbound(request);
      const reply = await this.transport(request);
      const inbound = reply ? decodeFix(reply) : undefined;
      if (inbound) this.noteInbound(inbound);
      const replayed: Array<{ seq: number; msgType?: string; possDup: boolean }> = [];
      const gaps: number[] = [];
      const wirePossDup: Array<{ seq: number; msgType?: string }> = [];
      for (let i = beginSeq; i <= endSeq; i += 1) {
        const raw = this.outbox.get(i);
        if (!raw) {
          gaps.push(i);
          continue;
        }
        const fields = decodeFix(raw);
        await this.transport(withPossDup(raw));
        replayed.push({ seq: i, msgType: fields["35"], possDup: true });
        wirePossDup.push({ seq: i, msgType: fields["35"] });
      }
      const sequenceReset =
        inbound && inbound["35"] === MSG.SequenceReset
          ? {
              gapFill: inbound["123"] === "Y",
              newSeqNo: Number(inbound["36"] ?? 0) || undefined,
              msgSeqNum: Number(inbound["34"] ?? 0) || undefined,
            }
          : undefined;
      return {
        request: decodeFix(request),
        reply,
        replyFields: inbound,
        sequenceReset,
        beginSeq,
        endSeq,
        replayed,
        wirePossDup,
        gaps,
        note: sequenceReset
          ? "Wire Resend Request (35=2) received SequenceReset (35=4) GapFill. Outbox hits resent with PossDupFlag=Y; loopback ignores 43=Y. Holes listed as gaps. Not a drop-copy."
          : "Resend Request (35=2) sent; peer did not return SequenceReset. Outbox hits resent with PossDupFlag=Y. Holes listed as gaps.",
        ...this.snapshot(),
      };
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown FIX tool "${toolName}"`, { protocol: "fix" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return {
      ok: true,
      detail: `FIX ${this.beginString} session state=${this.state} seq=${this.seq} allowWrite=${this.allowWrite} sessionWrites=logon+logout+resend outbox=${this.outbox.size}`,
    };
  }

  private snapshot() {
    return {
      state: this.state,
      nextSeq: this.seq,
      lastInboundSeq: this.lastIn,
      sender: this.sender,
      target: this.target,
    };
  }

  private rememberOutbound(message: string): void {
    const fields = decodeFix(message);
    const n = Number(fields["34"]);
    if (Number.isFinite(n)) this.outbox.set(n, message);
  }

  private noteInbound(fields: Record<string, string>): void {
    const n = Number(fields["34"]);
    if (Number.isFinite(n)) this.lastIn = n;
  }

  private requireLoggedOn(op: string): void {
    if (this.state !== "logged_on") {
      throw new AdapterError("E_PROTOCOL", `FIX ${op} requires a logged-on session (call logon first)`, {
        protocol: "fix",
        details: { state: this.state },
      });
    }
  }

  private assertConnected(): void {
    if (!this.connected) throw new AdapterError("E_NOT_CONNECTED", "FIX adapter is not connected", { protocol: "fix" });
  }
}
