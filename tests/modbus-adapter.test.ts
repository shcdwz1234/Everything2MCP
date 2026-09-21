import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  attachRtuSlave,
  createInMemoryModbusHandle,
  createInMemoryRtuHandle,
  createMemory,
  createStreamRtuHandle,
  createVirtualSerialPair,
  crc16Modbus,
  decodeFrame,
  encodeRead,
  encodeReadWriteRegisters,
  encodeWriteCoils,
  encodeWriteRegisters,
  FC,
  mbapToRtu,
  ModbusAdapter,
  rtuToMbap,
  slaveRespond,
} from "../src/adapters/modbus/index.js";

describe("ModbusAdapter", () => {
  it("rejects missing host", async () => {
    const handle = createInMemoryModbusHandle();
    await assert.rejects(() => new ModbusAdapter("m", async () => handle).connect({}), /host/);
  });

  it("reads/writes holding, input, coils, and discrete inputs over MBAP codec", async () => {
    const mem = createMemory();
    mem.holding[0] = 100;
    mem.input[0] = 42;
    mem.coils[0] = true;
    mem.discrete[0] = true;
    const adapter = new ModbusAdapter("plc", async () => createInMemoryModbusHandle(mem, 1));
    await adapter.connect({ host: "127.0.0.1", port: 502, unitId: 1, allowWrite: true });
    const names = (await adapter.listTools()).map((t) => t.name).sort();
    assert.deepEqual(names, [
      "read_coils",
      "read_discrete_inputs",
      "read_holding_registers",
      "read_input_registers",
      "read_write_registers",
      "write_coil",
      "write_coils",
      "write_register",
      "write_registers",
    ]);
    const holding = (await adapter.invoke("read_holding_registers", { address: 0, length: 1 })) as {
      values: number[];
    };
    assert.deepEqual(holding.values, [100]);
    await adapter.invoke("write_register", { address: 0, value: 7 });
    const again = (await adapter.invoke("read_holding_registers", { address: 0, length: 1 })) as {
      values: number[];
    };
    assert.deepEqual(again.values, [7]);
    const input = (await adapter.invoke("read_input_registers", { address: 0, length: 1 })) as { values: number[] };
    assert.deepEqual(input.values, [42]);
    const coils = (await adapter.invoke("read_coils", { address: 0, length: 1 })) as { values: boolean[] };
    assert.deepEqual(coils.values, [true]);
    await adapter.invoke("write_coil", { address: 0, value: false });
    const coils2 = (await adapter.invoke("read_coils", { address: 0, length: 1 })) as { values: boolean[] };
    assert.deepEqual(coils2.values, [false]);
    const discrete = (await adapter.invoke("read_discrete_inputs", { address: 0, length: 1 })) as {
      values: boolean[];
    };
    assert.deepEqual(discrete.values, [true]);
    await adapter.disconnect();
  });

  it("defaults allowWrite=false and blocks writes; reads still work", async () => {
    const mem = createMemory();
    mem.holding[0] = 100;
    const adapter = new ModbusAdapter("ro", async () => createInMemoryModbusHandle(mem, 1));
    await adapter.connect({ host: "127.0.0.1", port: 502 });
    try {
      const holding = (await adapter.invoke("read_holding_registers", { address: 0, length: 1 })) as {
        values: number[];
      };
      assert.deepEqual(holding.values, [100]);
      await assert.rejects(() => adapter.invoke("write_register", { address: 0, value: 7 }), /allowWrite/);
      await assert.rejects(() => adapter.invoke("write_coil", { address: 0, value: true }), /allowWrite/);
      await assert.rejects(() => adapter.invoke("write_coils", { address: 0, values: [true] }), /allowWrite/);
      await assert.rejects(() => adapter.invoke("write_registers", { address: 0, values: [1] }), /allowWrite/);
      await assert.rejects(
        () =>
          adapter.invoke("read_write_registers", {
            readAddress: 0,
            readQuantity: 1,
            writeAddress: 0,
            writeValues: [1],
          }),
        /allowWrite/,
      );
    } finally {
      await adapter.disconnect();
    }
  });

  it("writes multiple coils/registers and FC23 read/write when allowWrite=true", async () => {
    const mem = createMemory();
    mem.holding[0] = 1;
    mem.holding[1] = 2;
    mem.holding[2] = 3;
    const adapter = new ModbusAdapter("multi", async () => createInMemoryModbusHandle(mem, 1));
    await adapter.connect({ host: "127.0.0.1", allowWrite: true });
    try {
      const coils = (await adapter.invoke("write_coils", { address: 0, values: [true, false, true] })) as {
        quantity: number;
      };
      assert.equal(coils.quantity, 3);
      const readCoils = (await adapter.invoke("read_coils", { address: 0, length: 3 })) as { values: boolean[] };
      assert.deepEqual(readCoils.values, [true, false, true]);

      const regs = (await adapter.invoke("write_registers", { address: 0, values: [9, 8] })) as { quantity: number };
      assert.equal(regs.quantity, 2);
      const rw = (await adapter.invoke("read_write_registers", {
        readAddress: 0,
        readQuantity: 3,
        writeAddress: 2,
        writeValues: [42],
      })) as { values: number[] };
      assert.deepEqual(rw.values, [9, 8, 42]);
    } finally {
      await adapter.disconnect();
    }
  });

  it("rejects tools before connect and unknown tools", async () => {
    const adapter = new ModbusAdapter("plc", async () => createInMemoryModbusHandle());
    await assert.rejects(() => adapter.listTools(), /not connected/);
    await adapter.connect({ host: "127.0.0.1", port: 502 });
    try {
      await assert.rejects(() => adapter.invoke("nope", {}), /Unknown Modbus tool/);
    } finally {
      await adapter.disconnect();
    }
  });

  it("reads/writes existing FCs over RTU (CRC16 + virtual serial)", async () => {
    const mem = createMemory();
    mem.holding[0] = 55;
    mem.coils[0] = true;
    const adapter = new ModbusAdapter("rtu");
    await adapter.connect({
      host: "virtual",
      mode: "rtu",
      simulator: true,
      allowWrite: true,
      holding: [55],
      coils: [true],
    });
    try {
      const health = await adapter.health();
      assert.match(health.detail ?? "", /mode=rtu/);
      const holding = (await adapter.invoke("read_holding_registers", { address: 0, length: 1 })) as {
        values: number[];
      };
      assert.deepEqual(holding.values, [55]);
      await adapter.invoke("write_register", { address: 0, value: 9 });
      const again = (await adapter.invoke("read_holding_registers", { address: 0, length: 1 })) as {
        values: number[];
      };
      assert.deepEqual(again.values, [9]);
      await adapter.invoke("write_coils", { address: 0, values: [false, true] });
      const coils = (await adapter.invoke("read_coils", { address: 0, length: 2 })) as { values: boolean[] };
      assert.deepEqual(coils.values, [false, true]);
      await adapter.invoke("write_registers", { address: 1, values: [3, 4] });
      const rw = (await adapter.invoke("read_write_registers", {
        readAddress: 0,
        readQuantity: 3,
        writeAddress: 2,
        writeValues: [8],
      })) as { values: number[] };
      assert.deepEqual(rw.values, [9, 3, 8]);
    } finally {
      await adapter.disconnect();
    }
  });

  it("rejects a real serial path without serialport and keeps allowWrite on RTU", async () => {
    const adapter = new ModbusAdapter("rtu-path");
    await assert.rejects(
      () => adapter.connect({ host: "virtual", mode: "rtu", path: "/dev/ttyUSB0" }),
      /serialport|RTU/,
    );
    const mem = createMemory();
    mem.holding[0] = 1;
    const ro = new ModbusAdapter("rtu-ro", async () => createInMemoryRtuHandle(mem, 1));
    await ro.connect({ host: "virtual", mode: "rtu" });
    try {
      await assert.rejects(() => ro.invoke("write_register", { address: 0, value: 2 }), /allowWrite/);
    } finally {
      await ro.disconnect();
    }
  });
});

describe("Modbus RTU codec", () => {
  it("CRC-16 and MBAP↔RTU wrap preserve FC3", () => {
    const mem = createMemory();
    mem.holding[1] = 0xabcd;
    const mbap = encodeRead(9, 1, FC.ReadHoldingRegisters, 1, 1);
    const rtu = mbapToRtu(mbap);
    assert.equal(crc16Modbus(rtu.subarray(0, rtu.length - 2)), rtu.readUInt16LE(rtu.length - 2));
    const back = rtuToMbap(rtu, 9);
    const res = slaveRespond(back, mem, 1);
    const decoded = decodeFrame(res);
    assert.deepEqual(decoded.values, [0xabcd]);
  });

  it("talks RTU over a virtual serial pair", async () => {
    const mem = createMemory();
    mem.holding[0] = 77;
    const { master, slave } = createVirtualSerialPair();
    const stop = attachRtuSlave(slave, mem, 1);
    const handle = createStreamRtuHandle(master, 1);
    try {
      const vals = await handle.readHoldingRegisters(0, 1);
      assert.deepEqual(vals, [77]);
      await handle.writeRegister(0, 12);
      assert.deepEqual(await handle.readHoldingRegisters(0, 1), [12]);
    } finally {
      stop();
      await handle.close();
    }
  });
});

describe("Modbus MBAP codec", () => {
  it("slaveRespond answers FC3 with encoded values", () => {
    const mem = createMemory();
    mem.holding[1] = 0xabcd;
    const req = encodeRead(9, 1, FC.ReadHoldingRegisters, 1, 1);
    const res = slaveRespond(req, mem, 1);
    const decoded = decodeFrame(res);
    assert.equal(decoded.functionCode, FC.ReadHoldingRegisters);
    assert.deepEqual(decoded.values, [0xabcd]);
  });

  it("encodes and decodes FC15 / FC16 / FC23", () => {
    const mem = createMemory();
    const coilsReq = encodeWriteCoils(1, 1, 2, [true, false, true]);
    const coilsRes = decodeFrame(slaveRespond(coilsReq, mem, 1));
    assert.equal(coilsRes.functionCode, FC.WriteMultipleCoils);
    assert.deepEqual(coilsRes.values, [2, 3]);
    assert.deepEqual(mem.coils.slice(2, 5), [true, false, true]);

    const regsReq = encodeWriteRegisters(2, 1, 0, [0x1111, 0x2222]);
    const regsRes = decodeFrame(slaveRespond(regsReq, mem, 1));
    assert.equal(regsRes.functionCode, FC.WriteMultipleRegisters);
    assert.deepEqual(regsRes.values, [0, 2]);
    assert.deepEqual(mem.holding.slice(0, 2), [0x1111, 0x2222]);

    const rwReq = encodeReadWriteRegisters(3, 1, 0, 2, 1, [0x3333]);
    const rwRes = decodeFrame(slaveRespond(rwReq, mem, 1));
    assert.equal(rwRes.functionCode, FC.ReadWriteMultipleRegisters);
    assert.deepEqual(rwRes.values, [0x1111, 0x3333]);
    assert.equal(mem.holding[1], 0x3333);
  });
});
