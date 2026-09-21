/** EtherNet/IP encapsulation (CIP) — List Identity only. Not a full CIP stack. */

export const ENIP_PORT = 44818;
export const CMD_LIST_IDENTITY = 0x0063;
export const CPF_IDENTITY = 0x000c;

export interface EnipIdentity {
  vendorId: number;
  deviceType: number;
  productCode: number;
  revision: string;
  serial: number;
  productName: string;
  ip?: string;
  port?: number;
}

export function encodeEncapsulation(command: number, data: Buffer = Buffer.alloc(0), session = 0): Buffer {
  const header = Buffer.alloc(24);
  header.writeUInt16LE(command, 0);
  header.writeUInt16LE(data.length, 2);
  header.writeUInt32LE(session, 4);
  header.writeUInt32LE(0, 8);
  header.fill(0, 12, 24);
  return Buffer.concat([header, data]);
}

export function decodeEncapsulation(buf: Buffer): { command: number; status: number; data: Buffer } | undefined {
  if (buf.length < 24) return undefined;
  const command = buf.readUInt16LE(0);
  const length = buf.readUInt16LE(2);
  const status = buf.readUInt32LE(8);
  if (buf.length < 24 + length) return undefined;
  return { command, status, data: buf.subarray(24, 24 + length) };
}

export function encodeListIdentityRequest(): Buffer {
  return encodeEncapsulation(CMD_LIST_IDENTITY);
}

export function encodeListIdentityReply(identity: EnipIdentity): Buffer {
  const name = Buffer.from(identity.productName, "utf8");
  const item = Buffer.alloc(2 + 16 + 2 + 2 + 2 + 2 + 2 + 4 + 1 + name.length);
  let o = 0;
  item.writeUInt16LE(1, o);
  o += 2; // encaps protocol version
  item.writeUInt16BE(2, o);
  o += 2; // AF_INET
  item.writeUInt16BE(identity.port ?? ENIP_PORT, o);
  o += 2;
  const ip = ipv4ToInt(identity.ip ?? "127.0.0.1");
  item.writeUInt32BE(ip, o);
  o += 4;
  item.fill(0, o, o + 8);
  o += 8;
  item.writeUInt16LE(identity.vendorId, o);
  o += 2;
  item.writeUInt16LE(identity.deviceType, o);
  o += 2;
  item.writeUInt16LE(identity.productCode, o);
  o += 2;
  const [maj, min] = identity.revision.split(".").map((n) => Number(n) || 0);
  item.writeUInt8(maj ?? 1, o);
  o += 1;
  item.writeUInt8(min ?? 0, o);
  o += 1;
  item.writeUInt16LE(0, o);
  o += 2; // status
  item.writeUInt32LE(identity.serial, o);
  o += 4;
  item.writeUInt8(name.length, o);
  o += 1;
  name.copy(item, o);

  const cpf = Buffer.alloc(2 + 4 + item.length);
  cpf.writeUInt16LE(1, 0); // item count
  cpf.writeUInt16LE(CPF_IDENTITY, 2);
  cpf.writeUInt16LE(item.length, 4);
  item.copy(cpf, 6);
  return encodeEncapsulation(CMD_LIST_IDENTITY, cpf);
}

export function decodeListIdentityReply(buf: Buffer): EnipIdentity | undefined {
  const enc = decodeEncapsulation(buf);
  if (!enc || enc.command !== CMD_LIST_IDENTITY || enc.status !== 0) return undefined;
  if (enc.data.length < 6) return undefined;
  const count = enc.data.readUInt16LE(0);
  if (count < 1) return undefined;
  const type = enc.data.readUInt16LE(2);
  const len = enc.data.readUInt16LE(4);
  if (type !== CPF_IDENTITY || enc.data.length < 6 + len) return undefined;
  const item = enc.data.subarray(6, 6 + len);
  if (item.length < 27) return undefined;
  let o = 2; // skip version
  o += 2; // family
  const port = item.readUInt16BE(o);
  o += 2;
  const ipInt = item.readUInt32BE(o);
  o += 4;
  o += 8; // zero
  const vendorId = item.readUInt16LE(o);
  o += 2;
  const deviceType = item.readUInt16LE(o);
  o += 2;
  const productCode = item.readUInt16LE(o);
  o += 2;
  const major = item.readUInt8(o);
  o += 1;
  const minor = item.readUInt8(o);
  o += 1;
  o += 2; // status
  const serial = item.readUInt32LE(o);
  o += 4;
  const nameLen = item.readUInt8(o);
  o += 1;
  const productName = item.subarray(o, o + nameLen).toString("utf8");
  return {
    vendorId,
    deviceType,
    productCode,
    revision: `${major}.${minor}`,
    serial,
    productName,
    ip: intToIpv4(ipInt),
    port,
  };
}

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return 0x7f000001;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function intToIpv4(n: number): string {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join(".");
}
