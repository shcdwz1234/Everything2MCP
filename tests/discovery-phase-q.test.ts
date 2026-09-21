import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listenCalDavLoopback } from "../src/adapters/caldav/index.js";
import { listenCardDavLoopback } from "../src/adapters/carddav/index.js";
import { listenBeanstalkLoopback } from "../src/adapters/beanstalkd/index.js";
import { listenZkLoopback } from "../src/adapters/zookeeper/index.js";
import { fingerprintBeanstalkd, fingerprintCalDav, fingerprintCardDav, fingerprintZookeeper } from "../src/discovery/fingerprint.js";
import { scanHost } from "../src/discovery/scan.js";
import { suggestFromCandidates } from "../src/discovery/suggest.js";

describe("Phase Q discovery (CalDAV / CardDAV / Beanstalkd / ZooKeeper)", () => {
  it("fingerprints CalDAV calendar-access and CardDAV addressbook", async () => {
    const cal = await listenCalDavLoopback();
    const card = await listenCardDavLoopback();
    try {
      const a = await fingerprintCalDav(`http://127.0.0.1:${cal.port}`, 800);
      assert.equal(a?.protocol, "caldav");
      assert.equal((a?.config as { allowWrite?: boolean }).allowWrite, false);
      const b = await fingerprintCardDav(`http://127.0.0.1:${card.port}`, 800);
      assert.equal(b?.protocol, "carddav");
    } finally {
      await cal.close();
      await card.close();
    }
  });

  it("fingerprints beanstalkd stats and zookeeper ruok", async () => {
    const bs = await listenBeanstalkLoopback();
    const zk = await listenZkLoopback();
    try {
      const bean = await fingerprintBeanstalkd("127.0.0.1", bs.port, 800);
      assert.equal(bean?.protocol, "beanstalkd");
      const z = await fingerprintZookeeper("127.0.0.1", zk.port, 800);
      assert.equal(z?.protocol, "zookeeper");
      const scanned = await scanHost({
        host: "127.0.0.1",
        port: bs.port,
        onlyGivenPort: true,
        protocols: ["beanstalkd"],
        timeoutMs: 800,
      });
      const suggestions = suggestFromCandidates(scanned);
      assert.equal(suggestions[0]?.protocol, "beanstalkd");
      assert.equal((suggestions[0]?.config as { allowWrite?: boolean }).allowWrite, false);
    } finally {
      await bs.close();
      await zk.close();
    }
  });
});
