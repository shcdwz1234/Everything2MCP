/** Modbus TCP MBAP + PDU encode/decode (function codes 1–6, 15, 16, 23). */

export const FC = {
  ReadCoils: 1,
  ReadDiscreteInputs: 2,
  ReadHoldingRegisters: 3,
  ReadInputRegisters: 4,
  WriteSingleCoil: 5,
  WriteSingleRegister: 6,
  WriteMultipleCoils: 15,
  WriteMultipleRegisters: 16,
  ReadWriteMultipleRegisters: 23,
} as const;

export interface ModbusMemory {
  coils: boolean[];
  discrete: boolean[];
  holding: number[];
  input: number[];
}

export function createMemory(size = 64): ModbusMemory {
  return {
    coils: Array.from({ length: size }, () => false),
    discrete: Array.from({ length: size }, () => false),
    holding: Array.from({ length: size }, () => 0),
    input: Array.from({ length: size }, () => 0),
  };
}

export function encodeMbap(transactionId: number, unitId: number, pdu: Buffer): Buffer {
  const buf = Buffer.alloc(7 + pdu.length);
  buf.writeUInt16BE(transactionId & 0xffff, 0);
  buf.writeUInt16BE(0, 2);
  buf.writeUInt16BE(pdu.length + 1, 4);
  buf.writeUInt8(unitId & 0xff, 6);
  pdu.copy(buf, 7);
  return buf;
}

export function encodeRead(
  transactionId: number,
  unitId: number,
  functionCode: number,
  address: number,
  quantity: number,
): Buffer {
  const pdu = Buffer.alloc(5);
  pdu.writeUInt8(functionCode, 0);
  pdu.writeUInt16BE(address & 0xffff, 1);
  pdu.writeUInt16BE(quantity & 0xffff, 3);
  return encodeMbap(transactionId, unitId, pdu);
}

export function encodeWriteCoil(
  transactionId: number,
  unitId: number,
  address: number,
  value: boolean,
): Buffer {
  const pdu = Buffer.alloc(5);
  pdu.writeUInt8(FC.WriteSingleCoil, 0);
  pdu.writeUInt16BE(address & 0xffff, 1);
  pdu.writeUInt16BE(value ? 0xff00 : 0x0000, 3);
  return encodeMbap(transactionId, unitId, pdu);
}

export function encodeWriteRegister(
  transactionId: number,
  unitId: number,
  address: number,
  value: number,
): Buffer {
  const pdu = Buffer.alloc(5);
  pdu.writeUInt8(FC.WriteSingleRegister, 0);
  pdu.writeUInt16BE(address & 0xffff, 1);
  pdu.writeUInt16BE(value & 0xffff, 3);
  return encodeMbap(transactionId, unitId, pdu);
}

export function encodeWriteCoils(
  transactionId: number,
  unitId: number,
  address: number,
  values: boolean[],
): Buffer {
  const qty = values.length;
  const byteCount = Math.max(1, Math.ceil(qty / 8));
  const pdu = Buffer.alloc(6 + byteCount);
  pdu.writeUInt8(FC.WriteMultipleCoils, 0);
  pdu.writeUInt16BE(address & 0xffff, 1);
  pdu.writeUInt16BE(qty & 0xffff, 3);
  pdu.writeUInt8(byteCount, 5);
  for (let i = 0; i < qty; i += 1) {
    if (values[i]) pdu[6 + Math.floor(i / 8)]! |= 1 << i % 8;
  }
  return encodeMbap(transactionId, unitId, pdu);
}

export function encodeWriteRegisters(
  transactionId: number,
  unitId: number,
  address: number,
  values: number[],
): Buffer {
  const qty = values.length;
  const pdu = Buffer.alloc(6 + qty * 2);
  pdu.writeUInt8(FC.WriteMultipleRegisters, 0);
  pdu.writeUInt16BE(address & 0xffff, 1);
  pdu.writeUInt16BE(qty & 0xffff, 3);
  pdu.writeUInt8(qty * 2, 5);
  values.forEach((v, i) => pdu.writeUInt16BE(v & 0xffff, 6 + i * 2));
  return encodeMbap(transactionId, unitId, pdu);
}

/** FC23: write is applied first, then the read window is returned. */
export function encodeReadWriteRegisters(
  transactionId: number,
  unitId: number,
  readAddress: number,
  readQuantity: number,
  writeAddress: number,
  writeValues: number[],
): Buffer {
  const writeQty = writeValues.length;
  const pdu = Buffer.alloc(10 + writeQty * 2);
  pdu.writeUInt8(FC.ReadWriteMultipleRegisters, 0);
  pdu.writeUInt16BE(readAddress & 0xffff, 1);
  pdu.writeUInt16BE(readQuantity & 0xffff, 3);
  pdu.writeUInt16BE(writeAddress & 0xffff, 5);
  pdu.writeUInt16BE(writeQty & 0xffff, 7);
  pdu.writeUInt8(writeQty * 2, 9);
  writeValues.forEach((v, i) => pdu.writeUInt16BE(v & 0xffff, 10 + i * 2));
  return encodeMbap(transactionId, unitId, pdu);
}

export interface DecodedPdu {
  transactionId: number;
  unitId: number;
  functionCode: number;
  values?: number[] | boolean[];
  exception?: number;
}

export function decodeFrame(buf: Buffer): DecodedPdu {
  if (buf.length < 8) throw new Error("Modbus frame too short");
  const transactionId = buf.readUInt16BE(0);
  const unitId = buf.readUInt8(6);
  const functionCode = buf.readUInt8(7);
  if (functionCode & 0x80) {
    return { transactionId, unitId, functionCode, exception: buf.length > 8 ? buf.readUInt8(8) : 0 };
  }
  if (functionCode === FC.ReadCoils || functionCode === FC.ReadDiscreteInputs) {
    const count = buf.readUInt8(8);
    const bits: boolean[] = [];
    for (let i = 0; i < count; i += 1) {
      const byte = buf.readUInt8(9 + i);
      for (let b = 0; b < 8; b += 1) bits.push(Boolean(byte & (1 << b)));
    }
    return { transactionId, unitId, functionCode, values: bits };
  }
  if (functionCode === FC.ReadHoldingRegisters || functionCode === FC.ReadInputRegisters) {
    const count = buf.readUInt8(8);
    const values: number[] = [];
    for (let i = 0; i < count; i += 2) values.push(buf.readUInt16BE(9 + i));
    return { transactionId, unitId, functionCode, values };
  }
  if (functionCode === FC.WriteSingleCoil || functionCode === FC.WriteSingleRegister) {
    return {
      transactionId,
      unitId,
      functionCode,
      values: [buf.readUInt16BE(8), buf.readUInt16BE(10)],
    };
  }
  if (functionCode === FC.WriteMultipleCoils || functionCode === FC.WriteMultipleRegisters) {
    return {
      transactionId,
      unitId,
      functionCode,
      values: [buf.readUInt16BE(8), buf.readUInt16BE(10)],
    };
  }
  if (functionCode === FC.ReadWriteMultipleRegisters) {
    const count = buf.readUInt8(8);
    const values: number[] = [];
    for (let i = 0; i < count; i += 2) values.push(buf.readUInt16BE(9 + i));
    return { transactionId, unitId, functionCode, values };
  }
  return { transactionId, unitId, functionCode };
}

/** In-process slave used by tests (and codec-backed handles) to answer MBAP requests. */
export function slaveRespond(request: Buffer, mem: ModbusMemory, unitId = 1): Buffer {
  const tid = request.readUInt16BE(0);
  const unit = request.readUInt8(6);
  const fc = request.readUInt8(7);
  if (unit !== unitId) {
    return exception(tid, unit, fc, 0x0a);
  }
  if (fc === FC.ReadCoils || fc === FC.ReadDiscreteInputs) {
    const addr = request.readUInt16BE(8);
    const qty = request.readUInt16BE(10);
    const src = fc === FC.ReadCoils ? mem.coils : mem.discrete;
    const bits = src.slice(addr, addr + qty);
    const byteCount = Math.ceil(qty / 8);
    const pdu = Buffer.alloc(2 + byteCount);
    pdu.writeUInt8(fc, 0);
    pdu.writeUInt8(byteCount, 1);
    for (let i = 0; i < qty; i += 1) {
      if (bits[i]) pdu[2 + Math.floor(i / 8)]! |= 1 << i % 8;
    }
    return encodeMbap(tid, unit, pdu);
  }
  if (fc === FC.ReadHoldingRegisters || fc === FC.ReadInputRegisters) {
    const addr = request.readUInt16BE(8);
    const qty = request.readUInt16BE(10);
    const src = fc === FC.ReadHoldingRegisters ? mem.holding : mem.input;
    const vals = src.slice(addr, addr + qty);
    const pdu = Buffer.alloc(2 + vals.length * 2);
    pdu.writeUInt8(fc, 0);
    pdu.writeUInt8(vals.length * 2, 1);
    vals.forEach((v, i) => pdu.writeUInt16BE(v & 0xffff, 2 + i * 2));
    return encodeMbap(tid, unit, pdu);
  }
  if (fc === FC.WriteSingleCoil) {
    const addr = request.readUInt16BE(8);
    const raw = request.readUInt16BE(10);
    mem.coils[addr] = raw === 0xff00;
    return Buffer.from(request);
  }
  if (fc === FC.WriteSingleRegister) {
    const addr = request.readUInt16BE(8);
    const value = request.readUInt16BE(10);
    mem.holding[addr] = value;
    return Buffer.from(request);
  }
  if (fc === FC.WriteMultipleCoils) {
    const addr = request.readUInt16BE(8);
    const qty = request.readUInt16BE(10);
    for (let i = 0; i < qty; i += 1) {
      const byte = request.readUInt8(13 + Math.floor(i / 8));
      mem.coils[addr + i] = Boolean(byte & (1 << i % 8));
    }
    const pdu = Buffer.alloc(5);
    pdu.writeUInt8(fc, 0);
    pdu.writeUInt16BE(addr, 1);
    pdu.writeUInt16BE(qty, 3);
    return encodeMbap(tid, unit, pdu);
  }
  if (fc === FC.WriteMultipleRegisters) {
    const addr = request.readUInt16BE(8);
    const qty = request.readUInt16BE(10);
    for (let i = 0; i < qty; i += 1) {
      mem.holding[addr + i] = request.readUInt16BE(13 + i * 2);
    }
    const pdu = Buffer.alloc(5);
    pdu.writeUInt8(fc, 0);
    pdu.writeUInt16BE(addr, 1);
    pdu.writeUInt16BE(qty, 3);
    return encodeMbap(tid, unit, pdu);
  }
  if (fc === FC.ReadWriteMultipleRegisters) {
    const readAddr = request.readUInt16BE(8);
    const readQty = request.readUInt16BE(10);
    const writeAddr = request.readUInt16BE(12);
    const writeQty = request.readUInt16BE(14);
    for (let i = 0; i < writeQty; i += 1) {
      mem.holding[writeAddr + i] = request.readUInt16BE(17 + i * 2);
    }
    const vals = mem.holding.slice(readAddr, readAddr + readQty);
    const pdu = Buffer.alloc(2 + vals.length * 2);
    pdu.writeUInt8(fc, 0);
    pdu.writeUInt8(vals.length * 2, 1);
    vals.forEach((v, i) => pdu.writeUInt16BE(v & 0xffff, 2 + i * 2));
    return encodeMbap(tid, unit, pdu);
  }
  return exception(tid, unit, fc, 0x01);
}

function exception(tid: number, unit: number, fc: number, code: number): Buffer {
  const pdu = Buffer.from([fc | 0x80, code]);
  return encodeMbap(tid, unit, pdu);
}

export type FrameTransport = (request: Buffer) => Promise<Buffer>;

export function createCodecHandle(
  transport: FrameTransport,
  unitId = 1,
): {
  readHoldingRegisters(address: number, length: number): Promise<number[]>;
  readInputRegisters(address: number, length: number): Promise<number[]>;
  readCoils(address: number, length: number): Promise<boolean[]>;
  readDiscreteInputs(address: number, length: number): Promise<boolean[]>;
  writeRegister(address: number, value: number): Promise<void>;
  writeCoil(address: number, value: boolean): Promise<void>;
  writeCoils(address: number, values: boolean[]): Promise<{ address: number; quantity: number }>;
  writeRegisters(address: number, values: number[]): Promise<{ address: number; quantity: number }>;
  readWriteRegisters(
    readAddress: number,
    readQuantity: number,
    writeAddress: number,
    writeValues: number[],
  ): Promise<number[]>;
  close(): Promise<void>;
} {
  let tid = 1;
  const nextTid = () => {
    const n = tid;
    tid = (tid + 1) & 0xffff || 1;
    return n;
  };
  const asNums = (d: DecodedPdu, length: number) => (d.values as number[]).slice(0, length);
  const asBits = (d: DecodedPdu, length: number) => (d.values as boolean[]).slice(0, length);
  return {
    async readHoldingRegisters(address, length) {
      const d = decodeFrame(
        await transport(encodeRead(nextTid(), unitId, FC.ReadHoldingRegisters, address, length)),
      );
      if (d.exception) throw new Error(`Modbus exception ${d.exception}`);
      return asNums(d, length);
    },
    async readInputRegisters(address, length) {
      const d = decodeFrame(
        await transport(encodeRead(nextTid(), unitId, FC.ReadInputRegisters, address, length)),
      );
      if (d.exception) throw new Error(`Modbus exception ${d.exception}`);
      return asNums(d, length);
    },
    async readCoils(address, length) {
      const d = decodeFrame(await transport(encodeRead(nextTid(), unitId, FC.ReadCoils, address, length)));
      if (d.exception) throw new Error(`Modbus exception ${d.exception}`);
      return asBits(d, length);
    },
    async readDiscreteInputs(address, length) {
      const d = decodeFrame(
        await transport(encodeRead(nextTid(), unitId, FC.ReadDiscreteInputs, address, length)),
      );
      if (d.exception) throw new Error(`Modbus exception ${d.exception}`);
      return asBits(d, length);
    },
    async writeRegister(address, value) {
      const d = decodeFrame(await transport(encodeWriteRegister(nextTid(), unitId, address, value)));
      if (d.exception) throw new Error(`Modbus exception ${d.exception}`);
    },
    async writeCoil(address, value) {
      const d = decodeFrame(await transport(encodeWriteCoil(nextTid(), unitId, address, value)));
      if (d.exception) throw new Error(`Modbus exception ${d.exception}`);
    },
    async writeCoils(address, values) {
      if (values.length === 0) throw new Error("writeCoils requires a non-empty values array");
      const d = decodeFrame(await transport(encodeWriteCoils(nextTid(), unitId, address, values)));
      if (d.exception) throw new Error(`Modbus exception ${d.exception}`);
      const qty = (d.values as number[] | undefined)?.[1] ?? values.length;
      return { address, quantity: qty };
    },
    async writeRegisters(address, values) {
      if (values.length === 0) throw new Error("writeRegisters requires a non-empty values array");
      const d = decodeFrame(await transport(encodeWriteRegisters(nextTid(), unitId, address, values)));
      if (d.exception) throw new Error(`Modbus exception ${d.exception}`);
      const qty = (d.values as number[] | undefined)?.[1] ?? values.length;
      return { address, quantity: qty };
    },
    async readWriteRegisters(readAddress, readQuantity, writeAddress, writeValues) {
      if (writeValues.length === 0) throw new Error("readWriteRegisters requires a non-empty writeValues array");
      const d = decodeFrame(
        await transport(
          encodeReadWriteRegisters(nextTid(), unitId, readAddress, readQuantity, writeAddress, writeValues),
        ),
      );
      if (d.exception) throw new Error(`Modbus exception ${d.exception}`);
      return asNums(d, readQuantity);
    },
    async close() {
      /* transport-specific */
    },
  };
}
