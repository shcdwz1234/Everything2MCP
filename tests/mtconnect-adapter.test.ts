import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { AdapterError } from "../src/runtime/errors.js";
import { looksLikeMtConnect, MtConnectAdapter, parseMtConnectXml } from "../src/adapters/mtconnect/index.js";
import { MTCONNECT_PROBE_XML } from "./fixtures.js";

const probePath = fileURLToPath(new URL("../examples/mtconnect-probe.xml", import.meta.url));
const currentPath = fileURLToPath(new URL("../examples/mtconnect-current.xml", import.meta.url));
const probeFile = readFileSync(probePath, "utf8");
const currentFile = readFileSync(currentPath, "utf8");

describe("MTConnect XML", () => {
  it("parses Devices and Streams fixtures", () => {
    assert.equal(looksLikeMtConnect(probeFile), true);
    const devices = parseMtConnectXml(probeFile);
    assert.equal(devices.kind, "devices");
    assert.equal(devices.devices[0]?.name, "Mill");
    assert.ok(devices.devices[0]?.dataItems.some((d) => d.id === "avail"));
    const streams = parseMtConnectXml(currentFile);
    assert.equal(streams.kind, "streams");
    const avail = streams.samples.find((s) => s.dataItemId === "avail");
    assert.equal(avail?.value, "AVAILABLE");
  });
});

describe("MtConnectAdapter", () => {
  it("rejects connect without url/fixture/xml", async () => {
    const adapter = new MtConnectAdapter("mill");
    await assert.rejects(() => adapter.connect({}), AdapterError);
  });

  it("probe/current from inline + file fixtures", async () => {
    const inline = new MtConnectAdapter("mill");
    await inline.connect({ xml: MTCONNECT_PROBE_XML });
    const tools = (await inline.listTools()).map((t) => t.name);
    assert.deepEqual(tools, ["probe", "current", "sample"]);
    const probed = (await inline.invoke("probe", {})) as { devices: Array<{ name: string }> };
    assert.equal(probed.devices[0]?.name, "Mill");
    const current = (await inline.invoke("current", {})) as { samples: Array<{ dataItemId: string; value: unknown }> };
    assert.ok(current.samples.some((s) => s.dataItemId === "avail" && s.value === "AVAILABLE"));
    await inline.disconnect();

    const files = new MtConnectAdapter("mill2");
    await files.connect({ fixture: probePath, currentFixture: currentPath });
    const snap = (await files.invoke("current", {})) as { samples: Array<{ dataItemId: string; value: unknown }> };
    assert.equal(snap.samples.find((s) => s.dataItemId === "xact")?.value, 12.5);
    await files.disconnect();
  });

  it("HTTP /probe and /current against a loopback Agent", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/probe") {
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(probeFile);
        return;
      }
      if (req.url === "/current") {
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(currentFile);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
    const adapter = new MtConnectAdapter("http-mill");
    try {
      await adapter.connect({ url: `http://127.0.0.1:${port}` });
      const probed = (await adapter.invoke("probe", {})) as { devices: Array<{ name: string }> };
      assert.equal(probed.devices[0]?.name, "Mill");
      const cur = (await adapter.invoke("current", {})) as { samples: Array<{ dataItemId: string }> };
      assert.ok(cur.samples.some((s) => s.dataItemId === "avail"));
    } finally {
      await adapter.disconnect();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
