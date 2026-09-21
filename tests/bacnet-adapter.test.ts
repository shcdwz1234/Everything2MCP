import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { describe, it } from "node:test";
import { AdapterError } from "../src/runtime/errors.js";
import { BacnetAdapter } from "../src/adapters/bacnet/index.js";
import {
  BACNET_IP,
  BVLC_ORIGINAL_BROADCAST_NPDU,
  BVLC_ORIGINAL_UNICAST_NPDU,
  bvlcFunction,
  decodeIAm,
  decodeWhoIs,
  encodeIAm,
  encodeObjectIdentifier,
  encodeWhoIs,
} from "../src/adapters/bacnet/codec.js";

function listenFakeBacnet(deviceId = 1001, vendorId = 555): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const sock = createSocket("udp4");
    sock.on("message", (msg, rinfo) => {
      const who = decodeWhoIs(msg);
      if (!who) return;
      if (who.low !== undefined && deviceId < who.low) return;
      if (who.high !== undefined && deviceId > who.high) return;
      sock.send(encodeIAm({ deviceId, vendorId, maxApdu: 1476, segmentation: 3 }), rinfo.port, rinfo.address);
    });
    sock.bind(0, "127.0.0.1", () => {
      const addr = sock.address();
      const port = typeof addr === "object" ? addr.port : 0;
      resolve({
        port,
        close: () =>
          new Promise((done) => {
            sock.close(() => done());
          }),
      });
    });
  });
}

describe("BACnet codec", () => {
  it("round-trips Who-Is range and I-Am on Original-Unicast-NPDU", () => {
    const who = encodeWhoIs({ low: 1000, high: 2000 });
    assert.equal(who[0], BACNET_IP);
    assert.equal(bvlcFunction(who), BVLC_ORIGINAL_UNICAST_NPDU);
    assert.notEqual(bvlcFunction(who), BVLC_ORIGINAL_BROADCAST_NPDU);
    const range = decodeWhoIs(who);
    assert.deepEqual(range, { low: 1000, high: 2000 });

    const iamBuf = encodeIAm({ deviceId: 1001, maxApdu: 1476, segmentation: 3, vendorId: 999 });
    assert.equal(bvlcFunction(iamBuf), BVLC_ORIGINAL_UNICAST_NPDU);
    const iam = decodeIAm(iamBuf);
    assert.deepEqual(iam, { deviceId: 1001, maxApdu: 1476, segmentation: 3, vendorId: 999 });

    const oid = encodeObjectIdentifier(8, 1001);
    assert.equal(oid[0], 0xc4);
  });

  it("decodes empty Who-Is and rejects non-I-Am APDUs", () => {
    const empty = decodeWhoIs(encodeWhoIs({}));
    assert.deepEqual(empty, {});
    assert.equal(decodeIAm(encodeWhoIs({})), undefined);
    assert.equal(decodeWhoIs(Buffer.from([0x00, 0x01])), undefined);
  });
});

describe("BacnetAdapter", () => {
  it("rejects tools before connect", async () => {
    const adapter = new BacnetAdapter("plant");
    const health = await adapter.health();
    assert.equal(health.ok, false);
    await assert.rejects(() => adapter.listTools(), AdapterError);
    await assert.rejects(() => adapter.invoke("who_is", {}), /not connected/i);
  });

  it("who_is / i_am / read_property / list_objects on the in-memory table", async () => {
    const adapter = new BacnetAdapter("plant");
    await adapter.connect({
      host: "127.0.0.1",
      devices: [
        {
          deviceId: 1001,
          name: "ahu-1",
          objects: [{ objectType: "analog-input", objectInstance: 1, objectName: "ZoneTemp", presentValue: 22.4 }],
        },
        { deviceId: 2002, name: "boiler", objects: [] },
      ],
    });
    const names = (await adapter.listTools()).map((t) => t.name).sort();
    assert.deepEqual(names, ["i_am", "list_objects", "read_property", "who_is", "write_property"]);
    const who = (await adapter.invoke("who_is", { low: 1000, high: 1500 })) as {
      devices: Array<{ deviceId: number }>;
      transport: string;
    };
    assert.equal(who.devices.length, 1);
    assert.equal(who.devices[0]?.deviceId, 1001);
    assert.equal(who.transport, "memory");
    const iam = (await adapter.invoke("i_am", {})) as { deviceId: number; name: string };
    assert.equal(iam.deviceId, 1001);
    assert.equal(iam.name, "ahu-1");
    const pv = (await adapter.invoke("read_property", {
      deviceId: 1001,
      objectType: "analog-input",
      objectInstance: 1,
      property: "present-value",
    })) as { value: number };
    assert.equal(pv.value, 22.4);
    const listed = (await adapter.invoke("list_objects", { deviceId: 1001 })) as {
      objects: Array<{ objectType: string }>;
    };
    assert.ok(listed.objects.some((o) => o.objectType === "analog-input"));
    await assert.rejects(() => adapter.invoke("nope", {}), /Unknown/);
    await adapter.disconnect();
  });

  it("defaults allowWrite=false and gates write_property", async () => {
    const adapter = new BacnetAdapter("plant");
    await adapter.connect({
      host: "127.0.0.1",
      devices: [
        {
          deviceId: 1001,
          name: "ahu-1",
          objects: [{ objectType: "analog-input", objectInstance: 1, presentValue: 22.4 }],
        },
      ],
    });
    const health = await adapter.health();
    assert.match(health.detail ?? "", /allowWrite=false/);
    await assert.rejects(
      () =>
        adapter.invoke("write_property", {
          deviceId: 1001,
          objectType: "analog-input",
          objectInstance: 1,
          property: "present-value",
          value: 30,
        }),
      /allowWrite=false/,
    );
    const still = (await adapter.invoke("read_property", {
      deviceId: 1001,
      objectType: "analog-input",
      objectInstance: 1,
    })) as { value: number };
    assert.equal(still.value, 22.4);
    await adapter.disconnect();
  });

  it("write_property mutates present-value when allowWrite=true", async () => {
    const adapter = new BacnetAdapter("plant");
    await adapter.connect({
      allowWrite: true,
      devices: [
        {
          deviceId: 1001,
          name: "ahu-1",
          objects: [{ objectType: "analog-input", objectInstance: 1, presentValue: 22.4 }],
        },
      ],
    });
    await adapter.invoke("write_property", {
      deviceId: 1001,
      objectType: "analog-input",
      objectInstance: 1,
      value: 18.1,
    });
    const pv = (await adapter.invoke("read_property", {
      deviceId: 1001,
      objectType: "analog-input",
      objectInstance: 1,
    })) as { value: number };
    assert.equal(pv.value, 18.1);
    await adapter.disconnect();
  });

  it("fails on unknown device and unknown object", async () => {
    const adapter = new BacnetAdapter("plant");
    await adapter.connect({ deviceId: 1001 });
    await assert.rejects(
      () => adapter.invoke("read_property", { deviceId: 9, objectType: "analog-input", objectInstance: 1 }),
      /Unknown BACnet device/,
    );
    await assert.rejects(
      () => adapter.invoke("read_property", { deviceId: 1001, objectType: "binary-input", objectInstance: 99 }),
      /Unknown object/,
    );
    await adapter.disconnect();
  });

  it("unicast Who-Is against a loopback I-Am responder (never broadcast)", async () => {
    const fake = await listenFakeBacnet(4242, 777);
    const adapter = new BacnetAdapter("udp");
    try {
      await adapter.connect({
        host: "127.0.0.1",
        port: fake.port,
        udp: true,
        timeoutMs: 400,
        deviceId: 1,
      });
      const health = await adapter.health();
      assert.match(health.detail ?? "", /udp-unicast/);
      const who = (await adapter.invoke("who_is", {})) as {
        devices: Array<{ deviceId: number; vendorId?: number }>;
        transport: string;
        note: string;
      };
      assert.equal(who.transport, "udp-unicast");
      assert.match(who.note, /not broadcast/i);
      assert.equal(who.devices.length, 1);
      assert.equal(who.devices[0]?.deviceId, 4242);
      assert.equal(who.devices[0]?.vendorId, 777);
      const miss = (await adapter.invoke("who_is", { low: 1, high: 10 })) as { devices: unknown[] };
      assert.equal(miss.devices.length, 0);
    } finally {
      await adapter.disconnect();
      await fake.close();
    }
  });
});
