import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { looksLikeNetworkRange } from "../src/discovery/probe.js";

describe("discovery safety", () => {
  it("treats CIDR and ranges as scans", () => {
    assert.equal(looksLikeNetworkRange("192.168.0.0/24"), true);
    assert.equal(looksLikeNetworkRange("10.0.0.1-254"), true);
    assert.equal(looksLikeNetworkRange("10.0.0.1-10.0.0.20"), true);
    assert.equal(looksLikeNetworkRange("10.0.0.*"), true);
    assert.equal(looksLikeNetworkRange("127.0.0.1"), false);
    assert.equal(looksLikeNetworkRange("localhost"), false);
    assert.equal(looksLikeNetworkRange("api.example.com"), false);
  });
});
