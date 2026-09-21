/**
 * BACnet/IP BVLC + unconfirmed Who-Is / I-Am (ASHRAE 135 Annex J).
 * Unicast only: Original-Unicast-NPDU (0x0A). Never Original-Broadcast-NPDU (0x0B).
 */

export const BACNET_IP = 0x81;
export const BVLC_ORIGINAL_UNICAST_NPDU = 0x0a;
export const BVLC_ORIGINAL_BROADCAST_NPDU = 0x0b;
export const NPDU_VERSION = 0x01;
export const APDU_UNCONFIRMED_REQUEST = 0x10;
export const SERVICE_I_AM = 0;
export const SERVICE_WHO_IS = 8;
export const OBJECT_TYPE_DEVICE = 8;
export const BACNET_IP_PORT = 47808;
export const MAX_DEVICE_INSTANCE = 0x3fffff;

export const OBJECT_TYPES: Record<string, number> = {
  "analog-input": 0,
  "analog-output": 1,
  "analog-value": 2,
  "binary-input": 3,
  "binary-output": 4,
  "binary-value": 5,
  device: 8,
};

export interface WhoIsRange {
  low?: number;
  high?: number;
}

export interface IAmDevice {
  deviceId: number;
  maxApdu: number;
  segmentation: number;
  vendorId: number;
}

export function wrapBvlcUnicast(npduAndApdu: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from([BACNET_IP, BVLC_ORIGINAL_UNICAST_NPDU, 0, 0]), npduAndApdu]);
  body.writeUInt16BE(body.length, 2);
  return body;
}

function localNpdu(): Buffer {
  return Buffer.from([NPDU_VERSION, 0x00]);
}

function encodeUnsignedBytes(n: number): Buffer {
  const v = n >>> 0;
  if (v <= 0xff) return Buffer.from([v]);
  if (v <= 0xffff) {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(v, 0);
    return b;
  }
  if (v <= 0xffffff) return Buffer.from([(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v, 0);
  return b;
}

function encodeApplicationUnsigned(n: number): Buffer {
  const bytes = encodeUnsignedBytes(n);
  return Buffer.concat([Buffer.from([0x20 | bytes.length]), bytes]);
}

function encodeContextUnsigned(tagNumber: number, n: number): Buffer {
  const bytes = encodeUnsignedBytes(n);
  const tag = ((tagNumber & 0x0f) << 4) | 0x08 | bytes.length;
  return Buffer.concat([Buffer.from([tag]), bytes]);
}

function encodeEnumerated(n: number): Buffer {
  const bytes = encodeUnsignedBytes(n);
  return Buffer.concat([Buffer.from([0x90 | bytes.length]), bytes]);
}

export function encodeObjectIdentifier(objectType: number, instance: number): Buffer {
  const value = ((objectType & 0x3ff) << 22) | (instance & MAX_DEVICE_INSTANCE);
  const b = Buffer.alloc(5);
  b[0] = 0xc4;
  b.writeUInt32BE(value >>> 0, 1);
  return b;
}

export function decodeObjectIdentifier(buf: Buffer, offset = 0): { objectType: number; instance: number; next: number } | undefined {
  if (buf.length < offset + 5) return undefined;
  if (buf[offset] !== 0xc4) return undefined;
  const value = buf.readUInt32BE(offset + 1);
  return {
    objectType: (value >>> 22) & 0x3ff,
    instance: value & MAX_DEVICE_INSTANCE,
    next: offset + 5,
  };
}

export function encodeWhoIs(range: WhoIsRange = {}): Buffer {
  const parts: Buffer[] = [Buffer.from([APDU_UNCONFIRMED_REQUEST, SERVICE_WHO_IS])];
  if (range.low !== undefined) parts.push(encodeContextUnsigned(0, range.low));
  if (range.high !== undefined) parts.push(encodeContextUnsigned(1, range.high));
  return wrapBvlcUnicast(Buffer.concat([localNpdu(), ...parts]));
}

export function encodeIAm(device: {
  deviceId: number;
  maxApdu?: number;
  segmentation?: number;
  vendorId?: number;
}): Buffer {
  const apdu = Buffer.concat([
    Buffer.from([APDU_UNCONFIRMED_REQUEST, SERVICE_I_AM]),
    encodeObjectIdentifier(OBJECT_TYPE_DEVICE, device.deviceId),
    encodeApplicationUnsigned(device.maxApdu ?? 1476),
    encodeEnumerated(device.segmentation ?? 3),
    encodeApplicationUnsigned(device.vendorId ?? 999),
  ]);
  return wrapBvlcUnicast(Buffer.concat([localNpdu(), apdu]));
}

export function unwrapBvlcNpdu(buf: Buffer): Buffer | undefined {
  if (buf.length < 6) return undefined;
  if (buf[0] !== BACNET_IP) return undefined;
  const fn = buf[1];
  // Accept a unicast or (peer-originated) broadcast function; we never *send* broadcast.
  if (fn !== BVLC_ORIGINAL_UNICAST_NPDU && fn !== BVLC_ORIGINAL_BROADCAST_NPDU) return undefined;
  const declared = buf.readUInt16BE(2);
  if (declared > buf.length || declared < 6) return undefined;
  if (buf[4] !== NPDU_VERSION) return undefined;
  const control = buf[5]!;
  let offset = 6;
  if (control & 0x80) return undefined;
  if (control & 0x20) {
    if (offset + 3 > buf.length) return undefined;
    offset += 2;
    const dlen = buf[offset]!;
    offset += 1 + dlen + 1;
  }
  if (control & 0x08) {
    if (offset + 3 > buf.length) return undefined;
    offset += 2;
    const slen = buf[offset]!;
    offset += 1 + slen;
  }
  if (offset > buf.length) return undefined;
  return buf.subarray(offset, declared);
}

function readLengthTagged(buf: Buffer, offset: number, expectedClass: 0 | 1, expectedNumber?: number): { value: number; next: number } | undefined {
  if (offset >= buf.length) return undefined;
  const tag = buf[offset]!;
  const tagNumber = (tag >> 4) & 0x0f;
  const cls = (tag >> 3) & 0x01;
  const length = tag & 0x07;
  if (cls !== expectedClass) return undefined;
  if (expectedNumber !== undefined && tagNumber !== expectedNumber) return undefined;
  if (length < 1 || length > 4) return undefined;
  if (offset + 1 + length > buf.length) return undefined;
  let value = 0;
  for (let i = 0; i < length; i++) value = (value << 8) | buf[offset + 1 + i]!;
  return { value, next: offset + 1 + length };
}

export function decodeWhoIs(buf: Buffer): WhoIsRange | undefined {
  const apdu = unwrapBvlcNpdu(buf);
  if (!apdu || apdu.length < 2) return undefined;
  if (apdu[0] !== APDU_UNCONFIRMED_REQUEST || apdu[1] !== SERVICE_WHO_IS) return undefined;
  const range: WhoIsRange = {};
  let offset = 2;
  const low = readLengthTagged(apdu, offset, 1, 0);
  if (low) {
    range.low = low.value;
    offset = low.next;
  }
  const high = readLengthTagged(apdu, offset, 1, 1);
  if (high) range.high = high.value;
  return range;
}

export function decodeIAm(buf: Buffer): IAmDevice | undefined {
  const apdu = unwrapBvlcNpdu(buf);
  if (!apdu || apdu.length < 7) return undefined;
  if (apdu[0] !== APDU_UNCONFIRMED_REQUEST || apdu[1] !== SERVICE_I_AM) return undefined;
  const oid = decodeObjectIdentifier(apdu, 2);
  if (!oid || oid.objectType !== OBJECT_TYPE_DEVICE) return undefined;
  const maxApdu = readLengthTagged(apdu, oid.next, 0, 2);
  if (!maxApdu) return undefined;
  const seg = readLengthTagged(apdu, maxApdu.next, 0, 9);
  if (!seg) return undefined;
  const vendor = readLengthTagged(apdu, seg.next, 0, 2);
  if (!vendor) return undefined;
  return {
    deviceId: oid.instance,
    maxApdu: maxApdu.value,
    segmentation: seg.value,
    vendorId: vendor.value,
  };
}

export function bvlcFunction(buf: Buffer): number | undefined {
  if (buf.length < 2 || buf[0] !== BACNET_IP) return undefined;
  return buf[1];
}
