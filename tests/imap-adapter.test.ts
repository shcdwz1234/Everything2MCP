import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ImapAdapter, listenImapLoopback } from "../src/adapters/imap/index.js";
import { AdapterError } from "../src/runtime/errors.js";

describe("ImapAdapter", () => {
  it("memory list/fetch; APPEND/STORE/EXPUNGE gated by allowWrite", async () => {
    const adapter = new ImapAdapter("imap.mem");
    await adapter.connect({ simulator: true });
    const boxes = (await adapter.invoke("list_mailboxes", {})) as { mailboxes: string[] };
    assert.ok(boxes.mailboxes.includes("INBOX"));
    const got = (await adapter.invoke("fetch", { uid: 1 })) as { raw: string };
    assert.match(got.raw, /hello imap/);
    await assert.rejects(
      () => adapter.invoke("append", { raw: "From: x\r\n\r\nnope" }),
      (err: unknown) => err instanceof AdapterError && /allowWrite/.test(String(err)),
    );
    await adapter.disconnect();

    const writer = new ImapAdapter("imap.w");
    await writer.connect({ simulator: true, allowWrite: true });
    const appended = (await writer.invoke("append", { raw: "From: w\r\n\r\nnew" })) as { uid: number };
    await writer.invoke("store_delete", { uid: appended.uid });
    const exp = (await writer.invoke("expunge", {})) as { expunged: number };
    assert.equal(exp.expunged, 1);
    await writer.disconnect();
  });

  it("IMAP4rev1 loopback LIST/SELECT/FETCH/SEARCH", async () => {
    const loop = await listenImapLoopback();
    const adapter = new ImapAdapter("imap.live");
    try {
      await adapter.connect({ host: "127.0.0.1", port: loop.port, timeoutMs: 1500 });
      const boxes = (await adapter.invoke("list_mailboxes", {})) as { mailboxes: string[] };
      assert.ok(boxes.mailboxes.includes("INBOX"));
      const sel = (await adapter.invoke("select", { mailbox: "INBOX" })) as { exists: number };
      assert.ok(sel.exists >= 1);
      const got = (await adapter.invoke("fetch", { uid: 1 })) as { raw: string };
      assert.match(got.raw, /hello imap|INBOX|FETCH/);
      const search = (await adapter.invoke("search", { query: "ALL" })) as { uids: number[] };
      assert.ok(search.uids.includes(1));
    } finally {
      await adapter.disconnect();
      await loop.close();
    }
  });

  it("IMAP loopback APPEND requires allowWrite and returns UID", async () => {
    const loop = await listenImapLoopback();
    const ro = new ImapAdapter("imap.ro");
    const writer = new ImapAdapter("imap.append");
    try {
      await ro.connect({ host: "127.0.0.1", port: loop.port, timeoutMs: 1500 });
      await assert.rejects(
        () => ro.invoke("append", { raw: "From: ro\r\n\r\nblocked" }),
        (err: unknown) => err instanceof AdapterError && /allowWrite/.test(String(err)),
      );
      await ro.disconnect();
      await writer.connect({ host: "127.0.0.1", port: loop.port, allowWrite: true, timeoutMs: 1500 });
      const appended = (await writer.invoke("append", { raw: "From: w\r\n\r\nloop" })) as { uid: number };
      assert.ok(appended.uid >= 2);
      const got = (await writer.invoke("fetch", { uid: appended.uid })) as { raw: string };
      assert.match(got.raw, /loop|FETCH|From: w/);
    } finally {
      await writer.disconnect();
      await loop.close();
    }
  });
});
