const SOH = "\x01";

export const MSG = {
  Heartbeat: "0",
  ResendRequest: "2",
  SequenceReset: "4",
  Logon: "A",
  Logout: "5",
  NewOrderSingle: "D",
} as const;

const TAG: Record<string, string> = {
  BeginString: "8",
  BodyLength: "9",
  MsgType: "35",
  SenderCompID: "49",
  TargetCompID: "56",
  MsgSeqNum: "34",
  SendingTime: "52",
  HeartBtInt: "108",
  EncryptMethod: "98",
  ClOrdID: "11",
  Symbol: "55",
  Side: "54",
  OrderQty: "38",
  OrdType: "40",
  Price: "44",
  Text: "58",
  ExecID: "17",
  ExecType: "150",
  OrdStatus: "39",
  CheckSum: "10",
  BeginSeqNo: "7",
  EndSeqNo: "16",
  GapFillFlag: "123",
  NewSeqNo: "36",
  PossDupFlag: "43",
};

export function encodeFix(fields: Record<string, string | number>): string {
  const copy: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    const tag = TAG[k] ?? k;
    copy[tag] = String(v);
  }
  const begin = copy["8"] ?? "FIX.4.2";
  delete copy["8"];
  delete copy["9"];
  delete copy["10"];
  const body = Object.entries(copy)
    .map(([k, v]) => `${k}=${v}`)
    .join(SOH);
  const withBegin = `8=${begin}${SOH}9=${body.length}${SOH}${body}${SOH}`;
  const checksum = checksumOf(withBegin);
  return `${withBegin}10=${checksum}${SOH}`;
}

export function decodeFix(message: string): Record<string, string> {
  const normalized = message.replace(/\|/g, SOH);
  const out: Record<string, string> = {};
  for (const part of normalized.split(SOH)) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

export function heartbeat(seq: number, sender: string, target: string): string {
  return encodeFix({
    MsgType: MSG.Heartbeat,
    SenderCompID: sender,
    TargetCompID: target,
    MsgSeqNum: seq,
    SendingTime: utcTimestamp(),
  });
}

export function logon(seq: number, sender: string, target: string, heartBtInt = 30): string {
  return encodeFix({
    MsgType: MSG.Logon,
    SenderCompID: sender,
    TargetCompID: target,
    MsgSeqNum: seq,
    SendingTime: utcTimestamp(),
    EncryptMethod: 0,
    HeartBtInt: heartBtInt,
  });
}

export function logout(seq: number, sender: string, target: string, text = "bye"): string {
  return encodeFix({
    MsgType: MSG.Logout,
    SenderCompID: sender,
    TargetCompID: target,
    MsgSeqNum: seq,
    SendingTime: utcTimestamp(),
    Text: text,
  });
}

export function executionReport(
  seq: number,
  sender: string,
  target: string,
  order: { clOrdId: string; execId: string; symbol?: string; status?: string },
): string {
  return encodeFix({
    MsgType: "8",
    SenderCompID: sender,
    TargetCompID: target,
    MsgSeqNum: seq,
    SendingTime: utcTimestamp(),
    ClOrdID: order.clOrdId,
    ExecID: order.execId,
    ExecType: "0",
    OrdStatus: order.status ?? "0",
    ...(order.symbol ? { Symbol: order.symbol } : {}),
  });
}

export function resendRequest(
  seq: number,
  sender: string,
  target: string,
  beginSeqNo: number,
  endSeqNo: number,
): string {
  return encodeFix({
    MsgType: MSG.ResendRequest,
    SenderCompID: sender,
    TargetCompID: target,
    MsgSeqNum: seq,
    SendingTime: utcTimestamp(),
    BeginSeqNo: beginSeqNo,
    EndSeqNo: endSeqNo,
  });
}

export function sequenceResetGapFill(
  seq: number,
  sender: string,
  target: string,
  newSeqNo: number,
): string {
  return encodeFix({
    MsgType: MSG.SequenceReset,
    SenderCompID: sender,
    TargetCompID: target,
    MsgSeqNum: seq,
    SendingTime: utcTimestamp(),
    GapFillFlag: "Y",
    NewSeqNo: newSeqNo,
  });
}

export function newOrderSingle(
  seq: number,
  sender: string,
  target: string,
  order: { clOrdId: string; symbol: string; side: "1" | "2"; qty: number; price?: number; ordType?: string },
): string {
  return encodeFix({
    MsgType: MSG.NewOrderSingle,
    SenderCompID: sender,
    TargetCompID: target,
    MsgSeqNum: seq,
    SendingTime: utcTimestamp(),
    ClOrdID: order.clOrdId,
    Symbol: order.symbol,
    Side: order.side,
    OrderQty: order.qty,
    OrdType: order.ordType ?? (order.price !== undefined ? "2" : "1"),
    ...(order.price !== undefined ? { Price: order.price } : {}),
  });
}

/** Re-encode a stored FIX message with PossDupFlag=Y (tag 43). Checksum is recomputed. */
export function withPossDup(message: string): string {
  const fields = decodeFix(message);
  return encodeFix({ ...fields, PossDupFlag: "Y" });
}

function checksumOf(s: string): string {
  let sum = 0;
  for (let i = 0; i < s.length; i += 1) sum += s.charCodeAt(i);
  return String(sum % 256).padStart(3, "0");
}

function utcTimestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

export { SOH };
