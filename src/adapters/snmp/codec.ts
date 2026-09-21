/** Minimal SNMPv2c BER: Get / GetNext / Set / GetResponse. */

export const PDU_GET = 0xa0;
export const PDU_GET_NEXT = 0xa1;
export const PDU_RESPONSE = 0xa2;
export const PDU_SET = 0xa3;

export type SnmpValueType = "null" | "integer" | "octet" | "oid" | "timeticks";

export interface SnmpVarbind {
  oid: string;
  type: SnmpValueType;
  value: string | number;
}

export interface SnmpMessage {
  version: number;
  community: string;
  pduType: number;
  requestId: number;
  errorStatus: number;
  errorIndex: number;
  varbinds: SnmpVarbind[];
}

export function encodeLength(len: number): Buffer {
  if (len < 128) return Buffer.from([len]);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function encodeTlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(value.length), value]);
}

export function encodeInteger(n: number): Buffer {
  let v = n | 0;
  const bytes: number[] = [];
  if (v === 0) bytes.push(0);
  else {
    const neg = v < 0;
    if (neg) v = v & 0xffffffff;
    while (bytes.length === 0 || (v !== 0 && v !== -1)) {
      bytes.unshift(v & 0xff);
      v >>= 8;
      if (bytes.length > 6) break;
    }
    if (!neg && bytes[0]! & 0x80) bytes.unshift(0);
  }
  return encodeTlv(0x02, Buffer.from(bytes));
}

export function encodeOctetString(s: string | Buffer): Buffer {
  const buf = typeof s === "string" ? Buffer.from(s, "utf8") : s;
  return encodeTlv(0x04, buf);
}

export function encodeNull(): Buffer {
  return Buffer.from([0x05, 0x00]);
}

export function encodeOid(oid: string): Buffer {
  const parts = oid.split(".").map((x) => Number(x)).filter((n) => Number.isFinite(n));
  if (parts.length < 2) throw new Error(`OID needs two arcs: ${oid}`);
  const out: number[] = [40 * parts[0]! + parts[1]!];
  for (const arc of parts.slice(2)) {
    if (arc < 128) out.push(arc);
    else {
      const stack: number[] = [];
      let n = arc;
      stack.push(n & 0x7f);
      n >>= 7;
      while (n > 0) {
        stack.push(0x80 | (n & 0x7f));
        n >>= 7;
      }
      while (stack.length) out.push(stack.pop()!);
    }
  }
  return encodeTlv(0x06, Buffer.from(out));
}

export function encodeValue(vb: SnmpVarbind): Buffer {
  if (vb.type === "null") return encodeNull();
  if (vb.type === "integer") return encodeInteger(Number(vb.value));
  if (vb.type === "oid") return encodeOid(String(vb.value));
  if (vb.type === "timeticks") return encodeTlv(0x43, encodeInteger(Number(vb.value)).subarray(2));
  return encodeOctetString(String(vb.value));
}

export function encodeSnmpV2c(msg: Omit<SnmpMessage, "version"> & { version?: number }): Buffer {
  const varbinds = Buffer.concat(
    msg.varbinds.map((vb) => encodeTlv(0x30, Buffer.concat([encodeOid(vb.oid), encodeValue(vb)]))),
  );
  const pdu = encodeTlv(
    msg.pduType,
    Buffer.concat([
      encodeInteger(msg.requestId),
      encodeInteger(msg.errorStatus),
      encodeInteger(msg.errorIndex),
      encodeTlv(0x30, varbinds),
    ]),
  );
  return encodeTlv(
    0x30,
    Buffer.concat([encodeInteger(msg.version ?? 1), encodeOctetString(msg.community), pdu]),
  );
}

function readLength(buf: Buffer, offset: number): { len: number; next: number } {
  const first = buf[offset]!;
  if (first < 128) return { len: first, next: offset + 1 };
  const count = first & 0x7f;
  let len = 0;
  for (let i = 0; i < count; i += 1) len = (len << 8) | buf[offset + 1 + i]!;
  return { len, next: offset + 1 + count };
}

function readTlv(buf: Buffer, offset: number): { tag: number; value: Buffer; next: number } {
  const tag = buf[offset]!;
  const { len, next } = readLength(buf, offset + 1);
  return { tag, value: buf.subarray(next, next + len), next: next + len };
}

export function decodeOid(value: Buffer): string {
  if (!value.length) return "";
  const first = value[0]!;
  const parts = [Math.floor(first / 40), first % 40];
  let i = 1;
  while (i < value.length) {
    let n = 0;
    while (i < value.length) {
      const b = value[i]!;
      i += 1;
      n = (n << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) break;
    }
    parts.push(n);
  }
  return parts.join(".");
}

function decodeInteger(value: Buffer): number {
  if (!value.length) return 0;
  let n = value[0]! & 0x80 ? -1 : 0;
  for (const b of value) n = (n << 8) | b;
  return n;
}

function decodeValue(tag: number, value: Buffer): Pick<SnmpVarbind, "type" | "value"> {
  if (tag === 0x05) return { type: "null", value: "" };
  if (tag === 0x02) return { type: "integer", value: decodeInteger(value) };
  if (tag === 0x06) return { type: "oid", value: decodeOid(value) };
  if (tag === 0x43) return { type: "timeticks", value: decodeInteger(value) };
  return { type: "octet", value: value.toString("utf8") };
}

export function decodeSnmp(buf: Buffer): SnmpMessage {
  const seq = readTlv(buf, 0);
  if (seq.tag !== 0x30) throw new Error("SNMP message is not a SEQUENCE");
  let o = 0;
  const ver = readTlv(seq.value, o);
  o = ver.next;
  const comm = readTlv(seq.value, o);
  o = comm.next;
  const pdu = readTlv(seq.value, o);
  let p = 0;
  const rid = readTlv(pdu.value, p);
  p = rid.next;
  const err = readTlv(pdu.value, p);
  p = err.next;
  const idx = readTlv(pdu.value, p);
  p = idx.next;
  const list = readTlv(pdu.value, p);
  const varbinds: SnmpVarbind[] = [];
  let v = 0;
  while (v < list.value.length) {
    const vb = readTlv(list.value, v);
    v = vb.next;
    let i = 0;
    const oidT = readTlv(vb.value, i);
    i = oidT.next;
    const valT = readTlv(vb.value, i);
    const decoded = decodeValue(valT.tag, valT.value);
    varbinds.push({ oid: decodeOid(oidT.value), type: decoded.type, value: decoded.value });
  }
  return {
    version: decodeInteger(ver.value),
    community: comm.value.toString("utf8"),
    pduType: pdu.tag,
    requestId: decodeInteger(rid.value),
    errorStatus: decodeInteger(err.value),
    errorIndex: decodeInteger(idx.value),
    varbinds,
  };
}

export const SYS_DESCR = "1.3.6.1.2.1.1.1.0";
export const SYS_OBJECT_ID = "1.3.6.1.2.1.1.2.0";
export const SYS_UPTIME = "1.3.6.1.2.1.1.3.0";

export function defaultMib(): Map<string, SnmpVarbind> {
  return new Map([
    [SYS_DESCR, { oid: SYS_DESCR, type: "octet", value: "everything2mcp snmp" }],
    [SYS_OBJECT_ID, { oid: SYS_OBJECT_ID, type: "oid", value: "1.3.6.1.4.1.8072.3.2.10" }],
    [SYS_UPTIME, { oid: SYS_UPTIME, type: "timeticks", value: 1 }],
  ]);
}

export function nextOid(sorted: string[], oid: string): string | undefined {
  for (const key of sorted) {
    if (compareOid(key, oid) > 0) return key;
  }
  return undefined;
}

export function compareOid(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const da = pa[i] ?? -1;
    const db = pb[i] ?? -1;
    if (da !== db) return da - db;
  }
  return 0;
}

export function encodeGet(community: string, oid: string, requestId = 1): Buffer {
  return encodeSnmpV2c({
    community,
    pduType: PDU_GET,
    requestId,
    errorStatus: 0,
    errorIndex: 0,
    varbinds: [{ oid, type: "null", value: "" }],
  });
}
