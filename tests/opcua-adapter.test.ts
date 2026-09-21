import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeAck, encodeHello, decodeAck } from "../src/adapters/opcua/hello.js";
import { OpcUaAdapter, STANDARD_NODES } from "../src/adapters/opcua/index.js";

describe("OpcUaAdapter", () => {
  it("rejects missing endpoint", async () => {
    await assert.rejects(() => new OpcUaAdapter("o").connect({}), /endpoint/);
  });

  it("reads, writes, and browses standard + configured nodes", async () => {
    const adapter = new OpcUaAdapter("plant");
    await adapter.connect({
      endpoint: "opc.tcp://127.0.0.1:4840",
      nodes: [{ nodeId: "ns=2;s=Temp", value: 21, displayName: "Temperature" }],
      allowWrite: true,
    });
    const names = (await adapter.listTools()).map((t) => t.name).sort();
    assert.ok(names.includes("read"));
    assert.ok(names.includes("session_info"));
    assert.ok(names.includes("subscribe_once"));
    const root = (await adapter.invoke("read", { nodeId: "RootFolder" })) as { nodeId: string; value: unknown };
    assert.equal(root.nodeId, STANDARD_NODES.RootFolder);
    const got = (await adapter.invoke("read", { nodeId: "ns=2;s=Temp" })) as {
      value: number;
      dataType: string;
      statusCode: string;
    };
    assert.equal(got.value, 21);
    assert.equal(got.statusCode, "Good");
    await adapter.invoke("write", { nodeId: "ns=2;s=Temp", value: 22.5 });
    const again = (await adapter.invoke("read", { nodeId: "ns=2;s=Temp" })) as { value: number; dataType: string };
    assert.equal(again.value, 22.5);
    assert.equal(again.dataType, "Double");
    const objects = (await adapter.invoke("browse", { nodeId: "i=85" })) as {
      references: Array<{ nodeId: string; displayName: string }>;
    };
    assert.ok(objects.references.some((r) => r.nodeId === "ns=2;s=Temp"));
    const listed = (await adapter.invoke("list_nodes", {})) as { nodes: Array<{ nodeId: string }> };
    assert.ok(listed.nodes.some((n) => n.nodeId === STANDARD_NODES.RootFolder));
    assert.ok(listed.nodes.some((n) => n.nodeId === "ns=2;s=Temp"));
    const session = (await adapter.invoke("session_info", {})) as { mode: string; sessionId?: string };
    assert.equal(session.mode, "simulator");
    assert.ok(session.sessionId);
    const gotWithSession = (await adapter.invoke("read", { nodeId: "ns=2;s=Temp" })) as { sessionId?: string };
    assert.equal(gotWithSession.sessionId, session.sessionId);
    const sub = (await adapter.invoke("subscribe_once", { nodeId: "ns=2;s=Temp" })) as {
      value: number;
      subscription: string;
      sessionId?: string;
    };
    assert.equal(sub.value, 22.5);
    assert.equal(sub.subscription, "once");
    assert.equal(sub.sessionId, session.sessionId);
    const mon = (await adapter.invoke("create_monitored_item", { nodeId: "ns=2;s=Temp" })) as {
      monitoredItemId: string;
    };
    assert.match(mon.monitoredItemId, /^mon-/);
    const pending = adapter.invoke("wait_data_change", { nodeId: "ns=2;s=Temp", timeoutMs: 800 });
    await new Promise((r) => setTimeout(r, 20));
    await adapter.invoke("write", { nodeId: "ns=2;s=Temp", value: 30 });
    const change = (await pending) as { value: number; subscription: string };
    assert.equal(change.value, 30);
    assert.equal(change.subscription, "monitored");
    await adapter.invoke("delete_monitored_item", { nodeId: "ns=2;s=Temp" });
    await adapter.disconnect();
  });

  it("defaults allowWrite=false and blocks write; read still works", async () => {
    const adapter = new OpcUaAdapter("ro");
    await adapter.connect({
      endpoint: "opc.tcp://127.0.0.1:4840",
      nodes: [{ nodeId: "ns=2;s=Temp", value: 21 }],
    });
    try {
      const got = (await adapter.invoke("read", { nodeId: "ns=2;s=Temp" })) as { value: number };
      assert.equal(got.value, 21);
      await assert.rejects(() => adapter.invoke("write", { nodeId: "ns=2;s=Temp", value: 99 }), /allowWrite/);
    } finally {
      await adapter.disconnect();
    }
  });

  it("uses an injected session handle for browse/read/write (CI live-like path)", async () => {
    const store = new Map<string, unknown>([["ns=2;s=Temp", 7]]);
    const adapter = new OpcUaAdapter("injected", async () => ({
      sessionId: "sess-42",
      async read(nodeId) {
        return { nodeId, value: store.get(nodeId), statusCode: "Good", sessionId: "sess-42" };
      },
      async write(nodeId, value) {
        store.set(nodeId, value);
        return { nodeId, value, statusCode: "Good", sessionId: "sess-42" };
      },
      async browse() {
        return {
          nodeId: STANDARD_NODES.ObjectsFolder,
          references: [...store.keys()].map((nodeId) => ({ nodeId, browseName: nodeId, displayName: nodeId, nodeClass: "Variable" })),
          sessionId: "sess-42",
        };
      },
      async list() {
        return [...store.entries()].map(([nodeId, value]) => ({
          nodeId,
          value,
          displayName: nodeId,
          browseName: nodeId,
          nodeClass: "Variable",
          dataType: "Variant",
        }));
      },
      async close() {
        store.clear();
      },
    }));
    await adapter.connect({ endpoint: "opc.tcp://127.0.0.1:4840", simulator: false, allowWrite: true });
    const info = (await adapter.invoke("session_info", {})) as { mode: string; sessionId?: string };
    assert.equal(info.mode, "injected");
    assert.equal(info.sessionId, "sess-42");
    const read = (await adapter.invoke("read", { nodeId: "ns=2;s=Temp" })) as { value: number; sessionId: string };
    assert.equal(read.value, 7);
    assert.equal(read.sessionId, "sess-42");
    await adapter.invoke("write", { nodeId: "ns=2;s=Temp", value: 9 });
    const again = (await adapter.invoke("read", { nodeId: "ns=2;s=Temp" })) as { value: number };
    assert.equal(again.value, 9);
    const browsed = (await adapter.invoke("browse", {})) as { sessionId: string; references: Array<{ nodeId: string }> };
    assert.equal(browsed.sessionId, "sess-42");
    assert.ok(browsed.references.some((r) => r.nodeId === "ns=2;s=Temp"));
    await adapter.disconnect();
  });

  it("runs Hello/ACK when simulator=false then keeps the node-map data plane", async () => {
    let helloCalled = false;
    const adapter = new OpcUaAdapter("live", undefined, async () => {
      helloCalled = true;
      return { ok: true, messageType: "ACK", protocolVersion: 0 };
    });
    await adapter.connect({
      endpoint: "opc.tcp://127.0.0.1:4840",
      simulator: false,
      nodes: [{ nodeId: "ns=2;s=Temp", value: 1 }],
    });
    assert.equal(helloCalled, true);
    const health = await adapter.health();
    assert.match(health.detail ?? "", /hello-session/);
    const info = (await adapter.invoke("session_info", {})) as { mode: string };
    assert.equal(info.mode, "hello-session");
    const got = (await adapter.invoke("read", { nodeId: "ns=2;s=Temp" })) as { value: number };
    assert.equal(got.value, 1);
    await adapter.disconnect();
  });
});

describe("opcua hello framing", () => {
  it("encodes HELLO and decodes ACK", () => {
    const hello = encodeHello("opc.tcp://127.0.0.1:4840");
    assert.equal(hello.subarray(0, 3).toString("ascii"), "HEL");
    const ack = encodeAck(0);
    const decoded = decodeAck(ack);
    assert.equal(decoded.ok, true);
    assert.equal(decoded.messageType, "ACK");
  });
});
