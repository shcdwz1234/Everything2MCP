import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CalDavAdapter, listenCalDavLoopback } from "../src/adapters/caldav/index.js";
import { AdapterError } from "../src/runtime/errors.js";

describe("CalDavAdapter", () => {
  it("memory propfind/report/get; put gated by allowWrite", async () => {
    const adapter = new CalDavAdapter("cal.mem");
    await adapter.connect({ simulator: true });
    const listed = (await adapter.invoke("propfind", {})) as { entries: Array<{ href: string }> };
    assert.ok(listed.entries.some((e) => e.href.includes("default")));
    const events = (await adapter.invoke("report", { filter: "Standup" })) as { events: Array<{ summary: string }> };
    assert.equal(events.events[0]?.summary, "Standup");
    const got = (await adapter.invoke("get", { path: "/calendars/user/default/evt-1.ics" })) as { body: string };
    assert.match(got.body, /VEVENT/);
    await assert.rejects(
      () => adapter.invoke("put", { path: "/calendars/user/default/x.ics", body: "BEGIN:VCALENDAR\nEND:VCALENDAR" }),
      (err: unknown) => err instanceof AdapterError && /allowWrite/.test(String(err)),
    );
    await adapter.disconnect();
  });

  it("HTTP REPORT/PUT loopback (not WebDAV-only)", async () => {
    const loop = await listenCalDavLoopback();
    const adapter = new CalDavAdapter("cal.live");
    try {
      await adapter.connect({ url: `http://127.0.0.1:${loop.port}`, allowWrite: true, timeoutMs: 1500 });
      const got = (await adapter.invoke("get", { path: "/calendars/user/default/evt-1.ics" })) as { body: string };
      assert.match(got.body, /Standup/);
      await adapter.invoke("put", {
        path: "/calendars/user/default/evt-2.ics",
        body: "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:evt-2\r\nSUMMARY:Retro\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
      });
      const again = (await adapter.invoke("report", { filter: "Retro" })) as { events: Array<{ uid: string }> };
      assert.equal(again.events[0]?.uid, "evt-2");
    } finally {
      await adapter.disconnect();
      await loop.close();
    }
  });

  it("time-range REPORT + freebusy; iTIP schedule is E_UNSUPPORTED", async () => {
    const adapter = new CalDavAdapter("cal.tr");
    await adapter.connect({ simulator: true });
    try {
      const names = (await adapter.listTools()).map((t) => t.name);
      assert.ok(names.includes("freebusy"));
      assert.ok(names.includes("schedule"));
      const hit = (await adapter.invoke("report", {
        start: "20260922T090000Z",
        end: "20260922T120000Z",
      })) as { events: Array<{ summary: string }> };
      assert.equal(hit.events[0]?.summary, "Standup");
      const miss = (await adapter.invoke("report", {
        start: "20260923T000000Z",
        end: "20260923T010000Z",
      })) as { events: unknown[] };
      assert.equal(miss.events.length, 0);
      const busy = (await adapter.invoke("freebusy", {
        start: "20260922T000000Z",
        end: "20260923T000000Z",
      })) as { busy: Array<{ uid: string }> };
      assert.equal(busy.busy[0]?.uid, "evt-1");
      await assert.rejects(
        () => adapter.invoke("schedule", { body: "BEGIN:VCALENDAR\nMETHOD:REQUEST\nEND:VCALENDAR" }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED" && /iTIP/.test(String(err)),
      );
    } finally {
      await adapter.disconnect();
    }
  });

  it("HTTP time-range REPORT and free-busy-query on loopback", async () => {
    const loop = await listenCalDavLoopback();
    const adapter = new CalDavAdapter("cal.range");
    try {
      await adapter.connect({ url: `http://127.0.0.1:${loop.port}`, timeoutMs: 1500 });
      const hit = (await adapter.invoke("report", {
        path: "/",
        start: "20260922T090000Z",
        end: "20260922T120000Z",
      })) as { events: Array<{ uid: string }> };
      assert.equal(hit.events[0]?.uid, "evt-1");
      const busy = (await adapter.invoke("freebusy", {
        start: "20260922T000000Z",
        end: "20260923T000000Z",
      })) as { busy: Array<{ uid: string }> };
      assert.equal(busy.busy[0]?.uid, "evt-1");
    } finally {
      await adapter.disconnect();
      await loop.close();
    }
  });
});
