import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CardDavAdapter, listenCardDavLoopback } from "../src/adapters/carddav/index.js";
import { AdapterError } from "../src/runtime/errors.js";

describe("CardDavAdapter", () => {
  it("memory propfind/report/get; put gated by allowWrite", async () => {
    const adapter = new CardDavAdapter("card.mem");
    await adapter.connect({ simulator: true });
    const listed = (await adapter.invoke("propfind", {})) as { entries: Array<{ href: string }> };
    assert.ok(listed.entries.some((e) => e.href.includes("ada.vcf")));
    const cards = (await adapter.invoke("report", { filter: "Ada" })) as { cards: Array<{ fn: string }> };
    assert.equal(cards.cards[0]?.fn, "Ada Lovelace");
    await assert.rejects(
      () => adapter.invoke("put", { path: "/addressbooks/user/default/bob.vcf", body: "BEGIN:VCARD\nFN:Bob\nEND:VCARD" }),
      (err: unknown) => err instanceof AdapterError && /allowWrite/.test(String(err)),
    );
    await adapter.disconnect();
  });

  it("HTTP REPORT/PUT loopback (not generic WebDAV)", async () => {
    const loop = await listenCardDavLoopback();
    const adapter = new CardDavAdapter("card.live");
    try {
      await adapter.connect({ url: `http://127.0.0.1:${loop.port}`, allowWrite: true, timeoutMs: 1500 });
      const got = (await adapter.invoke("get", { path: "/addressbooks/user/default/ada.vcf" })) as { body: string };
      assert.match(got.body, /Ada Lovelace/);
      await adapter.invoke("put", {
        path: "/addressbooks/user/default/bob.vcf",
        body: "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:bob\r\nFN:Bob\r\nEND:VCARD\r\n",
      });
      const again = (await adapter.invoke("report", { filter: "Bob" })) as { cards: Array<{ uid: string }> };
      assert.equal(again.cards[0]?.uid, "bob");
    } finally {
      await adapter.disconnect();
      await loop.close();
    }
  });
});
