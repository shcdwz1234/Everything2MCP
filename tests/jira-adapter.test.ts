import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JiraAdapter, listenJiraLoopback } from "../src/adapters/jira/index.js";

describe("Jira read MVP", () => {
  it("simulator myself/search/get_issue", async () => {
    const a = new JiraAdapter("jira:t");
    await a.connect({ simulator: true });
    const me = (await a.invoke("myself", {})) as { displayName: string };
    assert.match(me.displayName, /Simulator/);
    const found = (await a.invoke("search", { jql: "E2M" })) as { issues: Array<{ key: string }> };
    assert.ok(found.issues.some((i) => i.key === "E2M-1"));
    const issue = (await a.invoke("get_issue", { key: "E2M-1" })) as { fields: { summary: string } };
    assert.match(issue.fields.summary, /Hot-add/);
    await a.disconnect();
  });

  it("HTTP loopback", async () => {
    const loop = await listenJiraLoopback();
    const a = new JiraAdapter("jira:http");
    try {
      await a.connect({ url: `http://127.0.0.1:${loop.port}` });
      const me = (await a.invoke("myself", {})) as { accountId: string };
      assert.equal(me.accountId, "sim");
    } finally {
      await a.disconnect();
      await loop.close();
    }
  });
});
