import { AdapterError } from "../../runtime/errors.js";
import { createCodecHandle, slaveRespond, type FrameTransport, type ModbusMemory } from "./codec.js";

/** Modbus RTU CRC-16 (poly 0xA001, init 0xFFFF), little-endian on the wire. */
export function crc16Modbus(buf: Uint8Array): number {
  let crc = 0xffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]!;
    for (let b = 0; b < 8; b++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc & 0xffff;
}

export function appendRtuCrc(body: Buffer): Buffer {
  const crc = crc16Modbus(body);
  const out = Buffer.alloc(body.length + 2);
  body.copy(out, 0);
  out.writeUInt16LE(crc, body.length);
  return out;
}

export function verifyRtuCrc(frame: Buffer): Buffer {
  if (frame.length < 4) {
    throw new AdapterError("E_PROTOCOL", "Modbus RTU frame too short", { protocol: "modbus" });
  }
  const body = frame.subarray(0, frame.length - 2);
  const got = frame.readUInt16LE(frame.length - 2);
  const expect = crc16Modbus(body);
  if (got !== expect) {
    throw new AdapterError(
      "E_PROTOCOL",
      `Modbus RTU CRC mismatch (got 0x${got.toString(16)}, expected 0x${expect.toString(16)})`,
      { protocol: "modbus" },
    );
  }
  return body;
}

/** MBAP → RTU: drop transaction/protocol/length, keep unitId+PDU, append CRC16. */
export function mbapToRtu(mbap: Buffer): Buffer {
  if (mbap.length < 8) throw new AdapterError("E_PROTOCOL", "MBAP too short for RTU wrap", { protocol: "modbus" });
  return appendRtuCrc(mbap.subarray(6));
}

/** RTU → MBAP: verify CRC, wrap unitId+PDU with a transaction id. */
export function rtuToMbap(rtu: Buffer, transactionId = 1): Buffer {
  const body = verifyRtuCrc(rtu);
  const unitId = body.readUInt8(0);
  const pdu = body.subarray(1);
  const mbap = Buffer.alloc(7 + pdu.length);
  mbap.writeUInt16BE(transactionId & 0xffff, 0);
  mbap.writeUInt16BE(0, 2);
  mbap.writeUInt16BE(pdu.length + 1, 4);
  mbap.writeUInt8(unitId, 6);
  pdu.copy(mbap, 7);
  return mbap;
}

export function wrapRtuTransport(raw: (rtu: Buffer) => Promise<Buffer>): FrameTransport {
  return async (mbap) => {
    const rtu = mbapToRtu(mbap);
    const reply = await raw(rtu);
    return rtuToMbap(reply, mbap.readUInt16BE(0));
  };
}

export function createMemoryRtuTransport(mem: ModbusMemory, unitId = 1): FrameTransport {
  return wrapRtuTransport(async (rtu) => {
    const mbap = rtuToMbap(rtu, 1);
    return mbapToRtu(slaveRespond(mbap, mem, unitId));
  });
}

export interface BytePort {
  write(buf: Buffer): void;
  on(event: "data", listener: (buf: Buffer) => void): void;
  off?(event: "data", listener: (buf: Buffer) => void): void;
}

export function createVirtualSerialPair(): { master: BytePort; slave: BytePort } {
  const listenersA: Array<(buf: Buffer) => void> = [];
  const listenersB: Array<(buf: Buffer) => void> = [];
  const master: BytePort = {
    write(buf) {
      for (const fn of listenersB) fn(Buffer.from(buf));
    },
    on(_event, listener) {
      listenersA.push(listener);
    },
    off(_event, listener) {
      const i = listenersA.indexOf(listener);
      if (i >= 0) listenersA.splice(i, 1);
    },
  };
  const slave: BytePort = {
    write(buf) {
      for (const fn of listenersA) fn(Buffer.from(buf));
    },
    on(_event, listener) {
      listenersB.push(listener);
    },
    off(_event, listener) {
      const i = listenersB.indexOf(listener);
      if (i >= 0) listenersB.splice(i, 1);
    },
  };
  return { master, slave };
}

export function attachRtuSlave(port: BytePort, mem: ModbusMemory, unitId = 1): () => void {
  const onData = (buf: Buffer) => {
    try {
      const mbap = rtuToMbap(buf, 1);
      port.write(mbapToRtu(slaveRespond(mbap, mem, unitId)));
    } catch {
      /* bad CRC / short frame */
    }
  };
  port.on("data", onData);
  return () => port.off?.("data", onData);
}

export function streamRtuTransport(port: BytePort, timeoutMs = 2000): FrameTransport {
  return wrapRtuTransport(
    (rtu) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          port.off?.("data", onData);
          reject(new AdapterError("E_TIMEOUT", `Modbus RTU timed out after ${timeoutMs}ms`, { protocol: "modbus" }));
        }, timeoutMs);
        const onData = (buf: Buffer) => {
          clearTimeout(timer);
          port.off?.("data", onData);
          resolve(buf);
        };
        port.on("data", onData);
        port.write(rtu);
      }),
  );
}

export function createInMemoryRtuHandle(mem: ModbusMemory, unitId = 1) {
  return createCodecHandle(createMemoryRtuTransport(mem, unitId), unitId);
}

export function createStreamRtuHandle(port: BytePort, unitId = 1, timeoutMs = 2000) {
  return createCodecHandle(streamRtuTransport(port, timeoutMs), unitId);
}
