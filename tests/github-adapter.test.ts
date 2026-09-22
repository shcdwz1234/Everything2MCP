import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GithubAdapter, listenGithubLoopback } from "../src/adapters/github/index.js";
import { AdapterError } from "../src/runtime/errors.js";

describe("github native adapter", () => {
  it("lists issues/PRs; create gated", async () => {
    const a = new GithubAdapter("github:t");
    await a.connect({ simulator: true });
    const issues = (await a.invoke("list_issues", {})) as { issues: unknown[] };
    const pulls = (await a.invoke("list_pulls", {})) as { pulls: unknown[] };
    assert.ok(issues.issues.length >= 1);
    assert.ok(pulls.pulls.length >= 1);
    await assert.rejects(
      () => a.invoke("create_issue", { title: "nope" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
    await a.disconnect();
  });

  it("HTTP loopback", async () => {
    const loop = await listenGithubLoopback();
    const a = new GithubAdapter("github:http");
    try {
      await a.connect({ url: `http://127.0.0.1:${loop.port}`, owner: "acme", repo: "e2mcp" });
      const issues = (await a.invoke("list_issues", {})) as IssueLike;
      assert.ok(issues.issues ?? issues);
    } finally {
      await a.disconnect();
      await loop.close();
    }
  });
});

type IssueLike = { issues?: unknown[] };
