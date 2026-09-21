import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { registerBuiltinAdapters } from "../src/adapters/index.js";
import { AdapterError } from "../src/runtime/errors.js";
import { ToolRegistry } from "../src/catalog/registry.js";
import { JsonStore } from "../src/catalog/store.js";
import { validateRegistration } from "../src/catalog/validate.js";

const wsdlPath = fileURLToPath(new URL("../examples/calculator.wsdl", import.meta.url));

describe("cross-adapter registry", () => {
  let dataDir: string;
  let registry: ToolRegistry;

  before(async () => {
    registerBuiltinAdapters();
    dataDir = await mkdtemp(join(tmpdir(), "e2mcp-int-"));
    registry = new ToolRegistry(new JsonStore(dataDir));
  });

  after(async () => {
    await registry.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("registers FIX + OPC-UA + SOAP together and routes namespaced tools", async () => {
    const opc = await registry.add("opcua", "plant", {
      endpoint: "opc.tcp://127.0.0.1:4840",
      simulator: true,
      nodes: [{ nodeId: "ns=2;s=Temp", value: 7 }],
    });
    const fix = await registry.add("fix", "desk", { sender: "BUY", target: "EXCH", allowWrite: true });
    const soap = await registry.add("soap", "calc", { wsdl: wsdlPath });

    const listed = registry.list();
    assert.equal(listed.adapters.length, 3);
    assert.ok(listed.tools.some((t) => t.name === "opcua.plant.read"));
    assert.ok(listed.tools.some((t) => t.name === "fix.desk.logon"));
    assert.ok(listed.tools.some((t) => t.name === "soap.calc.Add"));

    const temp = (await registry.invoke("opcua.plant.read", { nodeId: "ns=2;s=Temp" })) as { value: number };
    assert.equal(temp.value, 7);
    const session = (await registry.invoke("fix.desk.logon", { heartBtInt: 10 })) as { state: string };
    assert.equal(session.state, "logged_on");
    await registry.invoke("fix.desk.logout", {});

    assert.equal(registry.queryByProtocol("opcua").adapters.length, 1);
    assert.equal(opc.record.id, "opcua:plant");
    assert.equal(fix.record.protocol, "fix");
    assert.equal(soap.tools[0]?.name, "soap.calc.Add");

    await registry.remove("opcua:plant");
    await registry.remove("fix:desk");
    await registry.remove("soap:calc");
    assert.equal(registry.list().adapters.length, 0);
  });

  it("blocks FIX session logon when allowWrite is omitted", async () => {
    await registry.add("fix", "ro", { sender: "BUY", target: "EXCH" });
    await assert.rejects(
      () => registry.invoke("fix.ro.logon", { heartBtInt: 10 }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED" && /allowWrite/.test(String(err)),
    );
    const status = (await registry.invoke("fix.ro.session_status", {})) as { state: string };
    assert.equal(status.state, "disconnected");
    await registry.remove("fix:ro");
  });

  it("surfaces structured errors for bad protocol config", () => {
    assert.throws(
      () => validateRegistration("redis", "cache", {}),
      (err: unknown) => err instanceof AdapterError && err.code === "E_INVALID_CONFIG",
    );
  });
});
