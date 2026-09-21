import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { SoapAdapter, parseSoapFault } from "../src/adapters/soap/index.js";

const wsdlPath = fileURLToPath(new URL("../examples/calculator.wsdl", import.meta.url));

describe("SoapAdapter", () => {
  it("rejects missing wsdl", async () => {
    await assert.rejects(() => new SoapAdapter("s").connect({}), /wsdl/);
  });

  it("maps WSDL operations including XSD sequence params", async () => {
    const adapter = new SoapAdapter("calc");
    await adapter.connect({ wsdl: wsdlPath });
    const tools = await adapter.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.name, "Add");
    const props = tools[0]?.inputSchema.properties ?? {};
    assert.ok("intA" in props);
    assert.ok("intB" in props);
    assert.deepEqual(tools[0]?.inputSchema.required, ["intA", "intB"]);
    assert.match(tools[0]?.description ?? "", /SOAP 1\.1/);
    const health = await adapter.health?.();
    assert.equal(health?.ok, true);
    await adapter.disconnect();
  });

  it("sends SOAP 1.2 and parses faults via an injected transport", async () => {
    let captured: { headers: Record<string, string>; body: string } | undefined;
    const adapter = new SoapAdapter("calc", () => async (_url, headers, body) => {
      captured = { headers, body };
      return {
        status: 500,
        text: `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><soap:Fault><soap:Code><soap:Value>soap:Sender</soap:Value></soap:Code><soap:Reason><soap:Text>bad args</soap:Text></soap:Reason></soap:Fault></soap:Body></soap:Envelope>`,
      };
    });
    await adapter.connect({
      wsdl: wsdlPath,
      soapVersion: "1.2",
      auth: { type: "bearer", token: "t" },
      allowWrite: true,
    });
    const res = (await adapter.invoke("Add", { intA: 1, intB: 2 })) as {
      fault: boolean;
      code: string;
      reason: string;
    };
    assert.equal(res.fault, true);
    assert.match(res.reason, /bad args/);
    assert.ok(captured?.headers["content-type"]?.includes("application/soap+xml"));
    assert.equal(captured?.headers.Authorization, "Bearer t");
    assert.match(captured?.body ?? "", /soap12:Envelope/);
    await adapter.disconnect();
  });

  it("defaults allowWrite=false and blocks SOAP invoke; listTools still works", async () => {
    const adapter = new SoapAdapter("ro");
    await adapter.connect({ wsdl: wsdlPath });
    try {
      const tools = await adapter.listTools();
      assert.equal(tools[0]?.name, "Add");
      await assert.rejects(() => adapter.invoke("Add", { intA: 1, intB: 2 }), /allowWrite/);
    } finally {
      await adapter.disconnect();
    }
  });

  it("rejects tools before connect and unknown operations", async () => {
    const adapter = new SoapAdapter("calc");
    await assert.rejects(() => adapter.listTools(), /not connected|connect/i);
    await adapter.connect({ wsdl: wsdlPath });
    try {
      await assert.rejects(() => adapter.invoke("NoSuchOp", {}), /Unknown SOAP/);
    } finally {
      await adapter.disconnect();
    }
  });
});

describe("parseSoapFault", () => {
  it("reads SOAP 1.1 faultcode/faultstring", () => {
    const xml = `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultcode>soap:Client</faultcode><faultstring>nope</faultstring></soap:Fault></soap:Body></soap:Envelope>`;
    const fault = parseSoapFault(xml);
    assert.equal(fault?.reason, "nope");
    assert.match(fault?.code ?? "", /Client/);
  });
});
