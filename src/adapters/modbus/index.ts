import { Socket } from "node:net";
import { AdapterError } from "../../runtime/errors.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { requiredNumber, stringField } from "../helpers.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";
import {
  createCodecHandle,
  createMemory,
  slaveRespond,
  type FrameTransport,
  type ModbusMemory,
} from "./codec.js";
import {
  attachRtuSlave,
  createInMemoryRtuHandle,
  createMemoryRtuTransport,
  createStreamRtuHandle,
  createVirtualSerialPair,
  type BytePort,
} from "./rtu.js";

export interface ModbusHandle {
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
}

export type ModbusConnectFn = (config: Record<string, unknown>) => Promise<ModbusHandle>;

export function seedMemory(config: Record<string, unknown>, mem = createMemory()): ModbusMemory {
  const applyNums = (src: unknown, dest: number[]) => {
    if (!Array.isArray(src)) return;
    src.forEach((v, i) => {
      if (typeof v === "number") dest[i] = v;
    });
  };
  const applyBits = (src: unknown, dest: boolean[]) => {
    if (!Array.isArray(src)) return;
    src.forEach((v, i) => {
      dest[i] = Boolean(v);
    });
  };
  applyNums(config.holding, mem.holding);
  applyNums(config.input, mem.input);
  applyBits(config.coils, mem.coils);
  applyBits(config.discrete, mem.discrete);
  return mem;
}

/** In-process MBAP loopback — used by tests and `simulator: true`. */
export function createInMemoryModbusHandle(
  mem: ModbusMemory = createMemory(),
  unitId = 1,
): ModbusHandle {
  const inner = createCodecHandle(async (req) => slaveRespond(req, mem, unitId), unitId);
  return {
    readHoldingRegisters: inner.readHoldingRegisters,
    readInputRegisters: inner.readInputRegisters,
    readCoils: inner.readCoils,
    readDiscreteInputs: inner.readDiscreteInputs,
    writeRegister: inner.writeRegister,
    writeCoil: inner.writeCoil,
    writeCoils: inner.writeCoils,
    writeRegisters: inner.writeRegisters,
    readWriteRegisters: inner.readWriteRegisters,
    async close() {
      await inner.close();
    },
  };
}

function tcpTransport(socket: Socket): FrameTransport {
  return (request) =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const onData = (buf: Buffer) => {
        chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
        const all = Buffer.concat(chunks);
        if (all.length < 6) return;
        const len = all.readUInt16BE(4);
        if (all.length >= 6 + len) {
          cleanup();
          resolve(all.subarray(0, 6 + len));
        }
      };
      const onErr = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        socket.off("data", onData);
        socket.off("error", onErr);
      };
      socket.on("data", onData);
      socket.once("error", onErr);
      socket.write(request);
    });
}

function isRtu(config: Record<string, unknown>): boolean {
  const mode = stringField(config, "mode")?.toLowerCase();
  return mode === "rtu" || config.rtu === true;
}

async function defaultConnect(config: Record<string, unknown>): Promise<ModbusHandle> {
  const unitId = typeof config.unitId === "number" ? config.unitId : 1;
  if (isRtu(config)) {
    if (config.stream && typeof config.stream === "object") {
      return createStreamRtuHandle(config.stream as BytePort, unitId);
    }
    if (config.simulator === true || config.virtual === true || !stringField(config, "path")) {
      return createInMemoryRtuHandle(seedMemory(config), unitId);
    }
    throw new AdapterError(
      "E_UNSUPPORTED",
      "Modbus RTU has no bundled serialport. Use mode=rtu + simulator/virtual, inject a BytePort stream, or a connectFn.",
      { protocol: "modbus" },
    );
  }
  if (config.simulator === true) {
    return createInMemoryModbusHandle(seedMemory(config), unitId);
  }
  const host = stringField(config, "host") ?? "127.0.0.1";
  const port = typeof config.port === "number" ? config.port : 502;
  const socket = new Socket();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.connect({ host, port }, () => resolve());
  });
  const inner = createCodecHandle(tcpTransport(socket), unitId);
  return {
    readHoldingRegisters: inner.readHoldingRegisters,
    readInputRegisters: inner.readInputRegisters,
    readCoils: inner.readCoils,
    readDiscreteInputs: inner.readDiscreteInputs,
    writeRegister: inner.writeRegister,
    writeCoil: inner.writeCoil,
    writeCoils: inner.writeCoils,
    writeRegisters: inner.writeRegisters,
    readWriteRegisters: inner.readWriteRegisters,
    async close() {
      socket.end();
      socket.destroy();
    },
  };
}

export class ModbusAdapter implements ProtocolAdapter {
  readonly protocol = "modbus";
  private handle: ModbusHandle | undefined;
  private host = "";
  private connected = false;
  private simulator = false;
  private allowWrite = false;
  private mode: "tcp" | "rtu" = "tcp";

  constructor(
    readonly id: string,
    private readonly connectFn: ModbusConnectFn = defaultConnect,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    const host = stringField(config, "host") ?? stringField(config, "url");
    if (!host) throw new Error("Modbus adapter requires config.host");
    this.host = host.replace(/^modbus:\/\//i, "");
    this.simulator = config.simulator === true || config.virtual === true;
    this.allowWrite = allowWriteFrom(config);
    this.mode = isRtu(config) ? "rtu" : "tcp";
    this.handle = await this.connectFn({ ...config, host: this.host });
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.handle) await this.handle.close();
    this.handle = undefined;
    this.connected = false;
  }

  async listTools(): Promise<McpToolSchema[]> {
    this.assertConnected();
    const addrLen = {
      type: "object" as const,
      properties: {
        address: { type: "integer" },
        length: { type: "integer", default: 1 },
      },
      required: ["address"],
      additionalProperties: false,
    };
    return [
      {
        name: "read_holding_registers",
        description: "FC3 Read Holding Registers (MBAP or RTU)",
        inputSchema: addrLen,
      },
      {
        name: "read_input_registers",
        description: "FC4 Read Input Registers (MBAP or RTU)",
        inputSchema: addrLen,
      },
      {
        name: "read_coils",
        description: "FC1 Read Coils (MBAP or RTU)",
        inputSchema: addrLen,
      },
      {
        name: "read_discrete_inputs",
        description: "FC2 Read Discrete Inputs (MBAP or RTU)",
        inputSchema: addrLen,
      },
      {
        name: "write_register",
        description: "FC6 Write Single Register (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: {
            address: { type: "integer" },
            value: { type: "integer" },
          },
          required: ["address", "value"],
          additionalProperties: false,
        },
      },
      {
        name: "write_coil",
        description: "FC5 Write Single Coil (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: {
            address: { type: "integer" },
            value: { type: "boolean" },
          },
          required: ["address", "value"],
          additionalProperties: false,
        },
      },
      {
        name: "write_coils",
        description: "FC15 Write Multiple Coils (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: {
            address: { type: "integer" },
            values: { type: "array", items: { type: "boolean" } },
          },
          required: ["address", "values"],
          additionalProperties: false,
        },
      },
      {
        name: "write_registers",
        description: "FC16 Write Multiple Registers (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: {
            address: { type: "integer" },
            values: { type: "array", items: { type: "integer" } },
          },
          required: ["address", "values"],
          additionalProperties: false,
        },
      },
      {
        name: "read_write_registers",
        description: "FC23 Read/Write Multiple Registers (write first, then read; requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: {
            readAddress: { type: "integer" },
            readQuantity: { type: "integer" },
            writeAddress: { type: "integer" },
            writeValues: { type: "array", items: { type: "integer" } },
          },
          required: ["readAddress", "readQuantity", "writeAddress", "writeValues"],
          additionalProperties: false,
        },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const handle = this.handle!;
    const length = typeof args.length === "number" ? args.length : 1;
    if (toolName === "read_holding_registers") {
      return { values: await handle.readHoldingRegisters(requiredNumber(args, "address"), length) };
    }
    if (toolName === "read_input_registers") {
      return { values: await handle.readInputRegisters(requiredNumber(args, "address"), length) };
    }
    if (toolName === "read_coils") {
      return { values: await handle.readCoils(requiredNumber(args, "address"), length) };
    }
    if (toolName === "read_discrete_inputs") {
      return { values: await handle.readDiscreteInputs(requiredNumber(args, "address"), length) };
    }
    if (toolName === "write_register") {
      assertCanWrite("modbus", this.allowWrite);
      await handle.writeRegister(requiredNumber(args, "address"), requiredNumber(args, "value"));
      return { ok: true };
    }
    if (toolName === "write_coil") {
      assertCanWrite("modbus", this.allowWrite);
      if (typeof args.value !== "boolean") throw new Error('Missing required boolean "value"');
      await handle.writeCoil(requiredNumber(args, "address"), args.value);
      return { ok: true };
    }
    if (toolName === "write_coils") {
      assertCanWrite("modbus", this.allowWrite);
      return handle.writeCoils(requiredNumber(args, "address"), boolList(args.values, "values"));
    }
    if (toolName === "write_registers") {
      assertCanWrite("modbus", this.allowWrite);
      return handle.writeRegisters(requiredNumber(args, "address"), numberList(args.values, "values"));
    }
    if (toolName === "read_write_registers") {
      assertCanWrite("modbus", this.allowWrite);
      return {
        values: await handle.readWriteRegisters(
          requiredNumber(args, "readAddress"),
          requiredNumber(args, "readQuantity"),
          requiredNumber(args, "writeAddress"),
          numberList(args.writeValues, "writeValues"),
        ),
      };
    }
    throw new Error(`Unknown Modbus tool "${toolName}"`);
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return {
      ok: true,
      detail: `host=${this.host} mode=${this.mode} simulator=${this.simulator} allowWrite=${this.allowWrite} FC1-6,15,16,23`,
    };
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) throw new Error("Modbus adapter is not connected");
  }
}

function boolList(value: unknown, key: string): boolean[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Missing required non-empty boolean array "${key}"`);
  }
  return value.map((v) => Boolean(v));
}

function numberList(value: unknown, key: string): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Missing required non-empty number array "${key}"`);
  }
  return value.map((v) => {
    if (typeof v !== "number" || Number.isNaN(v)) throw new Error(`"${key}" must be an array of numbers`);
    return v;
  });
}

export {
  createCodecHandle,
  createMemory,
  slaveRespond,
  FC,
  decodeFrame,
  encodeRead,
  encodeWriteCoils,
  encodeWriteRegisters,
  encodeReadWriteRegisters,
} from "./codec.js";
export {
  crc16Modbus,
  mbapToRtu,
  rtuToMbap,
  wrapRtuTransport,
  createMemoryRtuTransport,
  createInMemoryRtuHandle,
  createStreamRtuHandle,
  createVirtualSerialPair,
  attachRtuSlave,
} from "./rtu.js";
export type { BytePort } from "./rtu.js";
export type { ModbusMemory, FrameTransport } from "./codec.js";
