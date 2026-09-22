import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { JournalAdapter, parseEvtxXml, parseJournalExport } from "../src/adapters/journal/index.js";
import { AdapterError } from "../src/runtime/errors.js";

describe("Phase P1 journal / Event Log read subset", () => {
  const cleanups: Array<() => Promise<void>> = [];
  after(async () => {
    for (const fn of [...cleanups].reverse()) await fn().catch(() => undefined);
  });

  it("simulator read", async () => {
    const a = new JournalAdapter("journal:t");
    await a.connect({ simulator: true });
    const out = (await a.invoke("read", { limit: 2 })) as { source: string; lines: string[] };
    assert.equal(out.source, "simulator");
    assert.ok(out.lines.length >= 1);
    await a.disconnect();
  });

  it("file path read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "e2mcp-j-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, "syslog");
    await writeFile(file, "one\ntwo\nthree\n");
    const a = new JournalAdapter("journal:f");
    await a.connect({ path: file });
    const out = (await a.invoke("read", { limit: 2 })) as { lines: string[] };
    assert.deepEqual(out.lines, ["two", "three"]);
    await a.disconnect();
  });

  it("parses systemd journal export and Windows Event XML", async () => {
    const exportEvents = parseJournalExport("MESSAGE=hello\nPRIORITY=6\n\nMESSAGE=world\n");
    assert.equal(exportEvents[0]?.MESSAGE, "hello");
    const xml = `<Events><Event><System><Provider Name="e2mcp"/><EventID>42</EventID><TimeCreated SystemTime="2026-01-01T00:00:00Z"/></System><EventData>boom</EventData></Event></Events>`;
    const ev = parseEvtxXml(xml);
    assert.equal(ev[0]?.EventID, "42");
    const dir = await mkdtemp(join(tmpdir(), "e2mcp-jxml-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, "export.xml");
    await writeFile(file, xml);
    const a = new JournalAdapter("journal:xml");
    await a.connect({ path: file, format: "evtx-xml" });
    const out = (await a.invoke("read", { limit: 5 })) as { events?: Array<{ EventID: string }> };
    assert.equal(out.events?.[0]?.EventID, "42");
    await a.disconnect();
  });

  it("win32 without simulator is E_UNSUPPORTED (no fake events)", async () => {
    const a = new JournalAdapter("journal:w");
    await assert.rejects(
      () => a.connect({ platform: "win32", allowShell: true }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
  });
});
