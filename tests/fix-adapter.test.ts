import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AdapterError } from "../src/runtime/errors.js";
import { decodeFix, SOH } from "../src/adapters/fix/codec.js";
import { FixAdapter } from "../src/adapters/fix/index.js";

describe("FixAdapter", () => {
  it("runs a minimal logon/heartbeat/logout session over loopback", async () => {
    const adapter = new FixAdapter("desk");
    await adapter.connect({ sender: "BUY", target: "EXCH", beginString: "FIX.4.2", allowWrite: true });
    const names = (await adapter.listTools()).map((t) => t.name).sort();
    assert.ok(names.includes("logon"));
    assert.ok(names.includes("logout"));
    assert.ok(names.includes("session_status"));

    await assert.rejects(() => adapter.invoke("heartbeat", {}), /logged-on/);

    const logon = (await adapter.invoke("logon", { heartBtInt: 15 })) as {
      state: string;
      fields: Record<string, string>;
      nextSeq: number;
    };
    assert.equal(logon.state, "logged_on");
    assert.equal(logon.fields["35"], "A");
    assert.equal(logon.nextSeq, 2);

    const hb = (await adapter.invoke("heartbeat", {})) as { message: string; state: string };
    assert.ok(hb.message.includes(SOH));
    assert.equal(hb.state, "logged_on");

    const order = (await adapter.invoke("new_order_single", {
      clOrdId: "c1",
      symbol: "AAPL",
      side: "1",
      qty: 100,
      price: 12.5,
    })) as { fields: Record<string, string>; reply?: string };
    assert.equal(order.fields["35"], "D");
    assert.equal(order.fields["11"], "c1");
    assert.ok(order.reply);
    assert.equal(decodeFix(order.reply)["35"], "8");

    const status = (await adapter.invoke("session_status", {})) as { state: string; lastInboundSeq: number };
    assert.equal(status.state, "logged_on");
    assert.ok(status.lastInboundSeq >= 1);

    const out = await adapter.invoke("logout", {});
    assert.equal((out as { state: string }).state, "disconnected");

    const pipe = "8=FIX.4.2|35=0|49=BUY|56=EXCH|10=000|";
    const decoded = (await adapter.invoke("decode", { message: pipe })) as { fields: Record<string, string> };
    assert.equal(decoded.fields["35"], "0");

    const health = await adapter.health();
    assert.match(health.detail ?? "", /session/);
    await adapter.disconnect();
  });

  it("rejects tools before connect and unknown tools", async () => {
    const adapter = new FixAdapter("desk");
    await assert.rejects(() => adapter.listTools(), /not connected/);
    await adapter.connect({ sender: "BUY", target: "EXCH" });
    try {
      await assert.rejects(() => adapter.invoke("nope", {}), /Unknown FIX tool/);
    } finally {
      await adapter.disconnect();
    }
  });

  it("defaults allowWrite=false: session logon/logout and NOS are writes; encode/status are not", async () => {
    const adapter = new FixAdapter("ro");
    await adapter.connect({ sender: "BUY", target: "EXCH" });
    try {
      const status = (await adapter.invoke("session_status", {})) as { state: string };
      assert.equal(status.state, "disconnected");
      const decoded = (await adapter.invoke("decode", { message: "8=FIX.4.2|35=0|10=000|" })) as {
        fields: Record<string, string>;
      };
      assert.equal(decoded.fields["35"], "0");
      await assert.rejects(() => adapter.invoke("logon", { heartBtInt: 15 }), /allowWrite/);
      await assert.rejects(() => adapter.invoke("logout", {}), /allowWrite/);
      await assert.rejects(
        () => adapter.invoke("new_order_single", { clOrdId: "c1", symbol: "AAPL", side: "1", qty: 1 }),
        /allowWrite/,
      );
    } finally {
      await adapter.disconnect();
    }
  });

  it("decode works without logon; new_order_single requires logged-on", async () => {
    const adapter = new FixAdapter("desk");
    await adapter.connect({ sender: "BUY", target: "EXCH", allowWrite: true });
    try {
      const decoded = (await adapter.invoke("decode", { message: "8=FIX.4.2|35=0|10=000|" })) as {
        fields: Record<string, string>;
      };
      assert.equal(decoded.fields["35"], "0");
      await assert.rejects(
        () => adapter.invoke("new_order_single", { clOrdId: "c1", symbol: "AAPL", side: "1", qty: 1 }),
        /logged-on/,
      );
    } finally {
      await adapter.disconnect();
    }
  });

  it("resend_request replays the local outbox and lists gaps", async () => {
    const adapter = new FixAdapter("desk");
    await adapter.connect({ sender: "BUY", target: "EXCH", allowWrite: true });
    try {
      await adapter.invoke("logon", { heartBtInt: 15 });
      await adapter.invoke("heartbeat", {});
      const replay = (await adapter.invoke("resend_request", { beginSeq: 1 })) as {
        replayed: Array<{ seq: number; msgType?: string; possDup: boolean }>;
        gaps: number[];
        beginSeq: number;
        replyFields?: Record<string, string>;
        sequenceReset?: { gapFill: boolean; newSeqNo?: number };
      };
      assert.equal(replay.beginSeq, 1);
      assert.ok(replay.replayed.some((m) => m.msgType === "A" && m.possDup));
      assert.ok(replay.replayed.some((m) => m.msgType === "0"));
      assert.deepEqual(replay.gaps, []);
      assert.equal(replay.replyFields?.["35"], "4");
      assert.equal(replay.replyFields?.["123"], "Y");
      assert.equal(replay.sequenceReset?.gapFill, true);
      assert.ok((replay.sequenceReset?.newSeqNo ?? 0) >= 2);
      const withWire = replay as { wirePossDup?: Array<{ seq: number; msgType?: string }> };
      assert.ok((withWire.wirePossDup?.length ?? 0) >= 2);
      assert.ok(withWire.wirePossDup?.some((m) => m.msgType === "A"));
    } finally {
      await adapter.disconnect();
    }

    const ro = new FixAdapter("ro");
    await ro.connect({ sender: "BUY", target: "EXCH" });
    try {
      await assert.rejects(
        () => ro.invoke("resend_request", { beginSeq: 1 }),
        (err: unknown) => err instanceof AdapterError && /allowWrite/.test(err.message),
      );
    } finally {
      await ro.disconnect();
    }
  });

  it("resend_request lists local gaps and still gets SequenceReset GapFill on the wire", async () => {
    const adapter = new FixAdapter("gaps");
    await adapter.connect({ sender: "BUY", target: "EXCH", allowWrite: true });
    try {
      await adapter.invoke("logon", { heartBtInt: 15 });
      await adapter.invoke("encode", { msgType: "0" });
      await adapter.invoke("heartbeat", {});
      const replay = (await adapter.invoke("resend_request", { beginSeq: 1 })) as {
        gaps: number[];
        sequenceReset?: { gapFill: boolean };
        replyFields?: Record<string, string>;
      };
      assert.ok(replay.gaps.includes(2));
      assert.equal(replay.replyFields?.["35"], "4");
      assert.equal(replay.sequenceReset?.gapFill, true);
    } finally {
      await adapter.disconnect();
    }
  });
});
