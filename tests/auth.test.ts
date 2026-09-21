import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyAuthHeaders, headersFromConfig, parseAuth } from "../src/runtime/auth.js";

describe("auth hooks", () => {
  it("applies bearer and basic consistently", () => {
    const bearer = applyAuthHeaders({ accept: "application/json" }, { type: "bearer", token: "tok" });
    assert.equal(bearer.Authorization, "Bearer tok");
    assert.equal(bearer.accept, "application/json");
    const basic = applyAuthHeaders({}, { type: "basic", username: "ada", password: "pw" });
    assert.equal(basic.Authorization, `Basic ${Buffer.from("ada:pw").toString("base64")}`);
  });

  it("headersFromConfig merges config.headers with auth for HTTP adapters", () => {
    const h = headersFromConfig(
      {
        headers: { "x-trace": "1" },
        auth: { type: "bearer", token: "abc" },
      },
      { "content-type": "application/json" },
    );
    assert.equal(h.Authorization, "Bearer abc");
    assert.equal(h["x-trace"], "1");
    assert.equal(h["content-type"], "application/json");
    assert.equal(parseAuth({ auth: { type: "apiKey", apiKey: "k", headerName: "X-Key" } })?.type, "apiKey");
  });
});
