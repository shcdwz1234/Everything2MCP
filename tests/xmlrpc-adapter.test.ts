import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeMethodResponse, encodeMethodCall, encodeMethodResponse } from "../src/adapters/xmlrpc/codec.js";
import { XmlRpcAdapter, type XmlRpcTransport } from "../src/adapters/xmlrpc/index.js";

function fakeXmlRpc(): XmlRpcTransport {
  return async (xml) => {
    const name = /<methodName>([^<]+)<\/methodName>/.exec(xml)?.[1] ?? "";
    if (name === "system.listMethods") {
      return encodeMethodResponse(["system.listMethods", "add", "echo"]);
    }
    if (name === "add") {
      const decoded = decodeMethodResponse(
        `<?xml version="1.0"?><methodResponse><params><param><value>${xml}</value></param></params></methodResponse>`,
      );
      void decoded;
      const ints = [...xml.matchAll(/<int>([^<]+)<\/int>/g)].map((m) => Number(m[1]));
      return encodeMethodResponse((ints[0] ?? 0) + (ints[1] ?? 0));
    }
    if (name === "echo") {
      const str = /<string>([^<]*)<\/string>/.exec(xml)?.[1] ?? "";
      return encodeMethodResponse(str);
    }
    return encodeMethodResponse(null);
  };
}

describe("XmlRpcAdapter", () => {
  it("rejects missing url", async () => {
    await assert.rejects(() => new XmlRpcAdapter("x", () => fakeXmlRpc()).connect({}), /url/);
  });

  it("lists methods, calls, and exposes introspected methods as tools", async () => {
    const adapter = new XmlRpcAdapter("blog", () => fakeXmlRpc());
    await adapter.connect({ url: "http://127.0.0.1:8080/RPC2", introspect: true, allowWrite: true });
    const names = (await adapter.listTools()).map((t) => t.name).sort();
    assert.ok(names.includes("list_methods"));
    assert.ok(names.includes("call"));
    assert.ok(names.includes("rpc_add"));
    const listed = (await adapter.invoke("list_methods", {})) as { methods: string[] };
    assert.ok(listed.methods.includes("add"));
    const sum = (await adapter.invoke("call", { method: "add", params: [2, 3] })) as { result: number };
    assert.equal(sum.result, 5);
    const viaTool = (await adapter.invoke("rpc_add", { params: [10, 7] })) as { result: number };
    assert.equal(viaTool.result, 17);
    const echo = (await adapter.invoke("rpc_echo", { params: ["hi"] })) as { result: string };
    assert.equal(echo.result, "hi");
    await adapter.disconnect();
  });

  it("defaults allowWrite=false and blocks call; list_methods still works", async () => {
    const adapter = new XmlRpcAdapter("ro", () => fakeXmlRpc());
    await adapter.connect({ url: "http://127.0.0.1:8080/RPC2", introspect: true });
    try {
      const listed = (await adapter.invoke("list_methods", {})) as { methods: string[] };
      assert.ok(listed.methods.includes("add"));
      await assert.rejects(() => adapter.invoke("call", { method: "add", params: [1, 2] }), /allowWrite/);
      await assert.rejects(() => adapter.invoke("rpc_add", { params: [1, 2] }), /allowWrite/);
      const echo = (await adapter.invoke("call", { method: "echo", params: ["hi"] })) as { result: string };
      assert.equal(echo.result, "hi");
      const via = (await adapter.invoke("rpc_echo", { params: ["yo"] })) as { result: string };
      assert.equal(via.result, "yo");
    } finally {
      await adapter.disconnect();
    }
  });

  it("rejects tools before connect and unknown tools", async () => {
    const adapter = new XmlRpcAdapter("blog", () => fakeXmlRpc());
    await assert.rejects(() => adapter.listTools(), /not connected/);
    await adapter.connect({ url: "http://127.0.0.1:8080/RPC2", introspect: false });
    try {
      await assert.rejects(() => adapter.invoke("nope", {}), /Unknown XML-RPC tool/);
      await assert.rejects(() => adapter.invoke("rpc_missing", {}), /Unknown XML-RPC tool/);
    } finally {
      await adapter.disconnect();
    }
  });
});

describe("xmlrpc codec", () => {
  it("round-trips int/string/array/struct", () => {
    const xml = encodeMethodCall("add", [1, { k: "v" }, ["a", true]]);
    assert.match(xml, /<methodName>add<\/methodName>/);
    const response = encodeMethodResponse({ ok: true, n: 3 });
    const decoded = decodeMethodResponse(response) as { ok: boolean; n: number };
    assert.equal(decoded.ok, true);
    assert.equal(decoded.n, 3);
  });
});
