/** ISO-on-TCP (RFC 1006) + a S7comm Read/Write Var subset. Not a full S7 stack. */

export const S7_PORT = 102;
export const AREA = { I: 0x81, Q: 0x82, M: 0x83, DB: 0x84 } as const;
export type S7Area = keyof typeof AREA;

export const TRANSPORT = { BIT: 0x01, BYTE: 0x02, CHAR: 0x03, WORD: 0x04, INT: 0x05, DWORD: 0x06, DINT: 0x06, REAL: 0x07 } as const;

export interface S7Address {
  area: S7Area;
  db: number;
  byte: number;
  bit: number;
  type: keyof typeof TRANSPORT;
  count: number;
}

export function wrapTpkt(payload: Buffer): Buffer {
  const buf = Buffer.alloc(4 + payload.length);
  buf[0] = 0x03;
  buf[1] = 0x00;
  buf.writeUInt16BE(4 + payload.length, 2);
  payload.copy(buf, 4);
  return buf;
}

export function unwrapTpkt(buf: Buffer): Buffer | undefined {
  if (buf.length < 4 || buf[0] !== 0x03 || buf[1] !== 0x00) return undefined;
  const len = buf.readUInt16BE(2);
  if (buf.length < len) return buf.subarray(4);
  return buf.subarray(4, len);
}

/** COTP Connection Request (CR) for S7, dest TSAP encodes rack/slot. Unicast only. */
export function encodeCotpCr(rack = 0, slot = 1): Buffer {
  const dstTsap = Buffer.from([0x01, ((rack & 0x07) << 5) | (slot & 0x1f)]);
  const params = Buffer.concat([
    Buffer.from([0xc1, 0x02, 0x01, 0x00]), // src TSAP
    Buffer.from([0xc2, 0x02]),
    dstTsap,
    Buffer.from([0xc0, 0x01, 0x0a]), // TPDU size
  ]);
  const cotp = Buffer.alloc(1 + 1 + 2 + 2 + 1 + params.length);
  cotp[0] = cotp.length - 1;
  cotp[1] = 0xe0; // CR
  cotp.writeUInt16BE(0, 2);
  cotp.writeUInt16BE(1, 4);
  cotp[6] = 0x00;
  params.copy(cotp, 7);
  return wrapTpkt(cotp);
}

export function isCotpCc(buf: Buffer): boolean {
  const inner = unwrapTpkt(buf);
  if (!inner || inner.length < 2) return false;
  return inner[1] === 0xd0;
}

export function encodeCotpCc(): Buffer {
  const cotp = Buffer.from([0x0d, 0xd0, 0x00, 0x01, 0x00, 0x01, 0x00, 0xc0, 0x01, 0x0a, 0xc1, 0x02, 0x01, 0x00]);
  cotp[0] = cotp.length - 1;
  return wrapTpkt(cotp);
}

const COTP_DT = Buffer.from([0x02, 0xf0, 0x80]);

export function wrapS7(s7: Buffer): Buffer {
  return wrapTpkt(Buffer.concat([COTP_DT, s7]));
}

export function unwrapS7(buf: Buffer): Buffer | undefined {
  const inner = unwrapTpkt(buf);
  if (!inner || inner.length < 3) return undefined;
  if (inner[0] === 0x02 && inner[1] === 0xf0) return inner.subarray(3);
  return inner;
}

export function parseAddress(raw: string): S7Address {
  const s = raw.trim().toUpperCase();
  const db = s.match(/^DB(\d+)\.(DBX|DBB|DBW|DBD)(\d+)(?:\.(\d))?$/);
  if (db) {
    const kind = db[2]!;
    const type = kind === "DBX" ? "BIT" : kind === "DBB" ? "BYTE" : kind === "DBW" ? "INT" : "DINT";
    return { area: "DB", db: Number(db[1]), byte: Number(db[3]), bit: Number(db[4] ?? 0), type, count: 1 };
  }
  const mq = s.match(/^([MIQ])([XBWD])?(\d+)(?:\.(\d))?$/);
  if (mq) {
    const area = mq[1] as S7Area;
    const kind = mq[2] ?? "B";
    const type = kind === "X" ? "BIT" : kind === "B" ? "BYTE" : kind === "W" ? "INT" : "DINT";
    return { area, db: 0, byte: Number(mq[3]), bit: Number(mq[4] ?? 0), type, count: 1 };
  }
  throw new Error(`Unsupported S7 address "${raw}" (try DB1.DBW0, MW10, I0.0, Q0.0)`);
}

export function encodeReadVar(addr: S7Address, pduRef = 1): Buffer {
  const item = Buffer.alloc(12);
  item[0] = 0x12;
  item[1] = 0x0a;
  item[2] = 0x10;
  item[3] = TRANSPORT[addr.type] ?? TRANSPORT.BYTE;
  item.writeUInt16BE(addr.count, 4);
  item.writeUInt16BE(addr.db, 6);
  item[8] = AREA[addr.area];
  const bitAddr = addr.byte * 8 + (addr.bit & 7);
  item[9] = (bitAddr >> 16) & 0xff;
  item[10] = (bitAddr >> 8) & 0xff;
  item[11] = bitAddr & 0xff;
  const params = Buffer.concat([Buffer.from([0x04, 0x01]), item]);
  const header = Buffer.alloc(10);
  header[0] = 0x32;
  header[1] = 0x01;
  header.writeUInt16BE(0, 2);
  header.writeUInt16BE(pduRef, 4);
  header.writeUInt16BE(params.length, 6);
  header.writeUInt16BE(0, 8);
  return wrapS7(Buffer.concat([header, params]));
}

export function decodeReadVar(buf: Buffer): S7Address | undefined {
  const s7 = unwrapS7(buf);
  if (!s7 || s7.length < 22 || s7[0] !== 0x32 || s7[10] !== 0x04) return undefined;
  const item = s7.subarray(12, 24);
  const areaCode = item[8];
  const area = (Object.entries(AREA).find(([, v]) => v === areaCode)?.[0] as S7Area | undefined) ?? "M";
  const bitAddr = (item[9]! << 16) | (item[10]! << 8) | item[11]!;
  const typeCode = item[3];
  const type = (Object.entries(TRANSPORT).find(([, v]) => v === typeCode)?.[0] as S7Address["type"] | undefined) ?? "BYTE";
  return {
    area,
    db: item.readUInt16BE(6),
    byte: Math.floor(bitAddr / 8),
    bit: bitAddr % 8,
    type,
    count: item.readUInt16BE(4),
  };
}

export function encodeReadVarResponse(addr: S7Address, data: Buffer, pduRef = 1): Buffer {
  const payload = Buffer.concat([Buffer.from([0xff, 0x04]), Buffer.alloc(2), data]);
  payload.writeUInt16BE(data.length * 8, 2);
  const header = Buffer.alloc(12);
  header[0] = 0x32;
  header[1] = 0x03;
  header.writeUInt16BE(0, 2);
  header.writeUInt16BE(pduRef, 4);
  header.writeUInt16BE(2, 6); // param: 0x04 0x01
  header.writeUInt16BE(payload.length, 8);
  header[10] = 0x04;
  header[11] = 0x01;
  void addr;
  return wrapS7(Buffer.concat([header, payload]));
}

export function decodeReadVarResponse(buf: Buffer): Buffer | undefined {
  const s7 = unwrapS7(buf);
  if (!s7 || s7.length < 16 || s7[0] !== 0x32) return undefined;
  const paramLen = s7.readUInt16BE(6);
  const data = s7.subarray(10 + paramLen);
  if (data.length < 4 || data[0] !== 0xff) return undefined;
  const bits = data.readUInt16BE(2);
  const n = Math.ceil(bits / 8);
  return data.subarray(4, 4 + n);
}

export function encodeWriteVar(addr: S7Address, data: Buffer, pduRef = 1): Buffer {
  const item = Buffer.alloc(12);
  item[0] = 0x12;
  item[1] = 0x0a;
  item[2] = 0x10;
  item[3] = TRANSPORT[addr.type] ?? TRANSPORT.BYTE;
  item.writeUInt16BE(addr.count, 4);
  item.writeUInt16BE(addr.db, 6);
  item[8] = AREA[addr.area];
  const bitAddr = addr.byte * 8 + (addr.bit & 7);
  item[9] = (bitAddr >> 16) & 0xff;
  item[10] = (bitAddr >> 8) & 0xff;
  item[11] = bitAddr & 0xff;
  const params = Buffer.concat([Buffer.from([0x05, 0x01]), item]);
  const dataPart = Buffer.concat([Buffer.from([0x00, 0x04]), Buffer.alloc(2), data]);
  dataPart.writeUInt16BE(data.length * 8, 2);
  const header = Buffer.alloc(10);
  header[0] = 0x32;
  header[1] = 0x01;
  header.writeUInt16BE(0, 2);
  header.writeUInt16BE(pduRef, 4);
  header.writeUInt16BE(params.length, 6);
  header.writeUInt16BE(dataPart.length, 8);
  return wrapS7(Buffer.concat([header, params, dataPart]));
}

export function decodeWriteVar(buf: Buffer): { addr: S7Address; data: Buffer } | undefined {
  const s7 = unwrapS7(buf);
  if (!s7 || s7.length < 22 || s7[0] !== 0x32 || s7[10] !== 0x05) return undefined;
  const item = s7.subarray(12, 24);
  const areaCode = item[8];
  const area = (Object.entries(AREA).find(([, v]) => v === areaCode)?.[0] as S7Area | undefined) ?? "M";
  const bitAddr = (item[9]! << 16) | (item[10]! << 8) | item[11]!;
  const typeCode = item[3];
  const type = (Object.entries(TRANSPORT).find(([, v]) => v === typeCode)?.[0] as S7Address["type"] | undefined) ?? "BYTE";
  const paramLen = s7.readUInt16BE(6);
  const dataPart = s7.subarray(10 + paramLen);
  const bits = dataPart.length >= 4 ? dataPart.readUInt16BE(2) : 0;
  const n = Math.ceil(bits / 8);
  const data = dataPart.subarray(4, 4 + n);
  return {
    addr: {
      area,
      db: item.readUInt16BE(6),
      byte: Math.floor(bitAddr / 8),
      bit: bitAddr % 8,
      type,
      count: item.readUInt16BE(4),
    },
    data,
  };
}

export function sizeOf(type: S7Address["type"], count = 1): number {
  if (type === "BIT") return Math.ceil(count / 8) || 1;
  if (type === "BYTE" || type === "CHAR") return count;
  if (type === "WORD" || type === "INT") return 2 * count;
  return 4 * count;
}

export function decodeValue(type: S7Address["type"], buf: Buffer): unknown {
  if (type === "BIT") return (buf[0] ?? 0) !== 0;
  if (type === "BYTE" || type === "CHAR") return buf[0] ?? 0;
  if (type === "WORD" || type === "INT") return buf.length >= 2 ? buf.readUInt16BE(0) : 0;
  if (type === "REAL") return buf.length >= 4 ? buf.readFloatBE(0) : 0;
  return buf.length >= 4 ? buf.readUInt32BE(0) : 0;
}

export function encodeValue(type: S7Address["type"], value: unknown): Buffer {
  const buf = Buffer.alloc(sizeOf(type));
  if (type === "BIT") {
    buf[0] = value ? 1 : 0;
    return buf;
  }
  const n = typeof value === "number" ? value : Number(value);
  if (type === "BYTE" || type === "CHAR") {
    buf[0] = n & 0xff;
    return buf;
  }
  if (type === "WORD" || type === "INT") {
    buf.writeUInt16BE(n & 0xffff, 0);
    return buf;
  }
  if (type === "REAL") {
    buf.writeFloatBE(n, 0);
    return buf;
  }
  buf.writeUInt32BE(n >>> 0, 0);
  return buf;
}
