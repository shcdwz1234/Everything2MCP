import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { graphqlDocumentLooksLikeWrite, looksLikeReadRpc } from "../src/adapters/rpc-gate.js";

describe("rpc write heuristic", () => {
  it("treats Get/List/Read/system.listMethods as reads and unknown names as writes", () => {
    assert.equal(looksLikeReadRpc("GetStatus"), true);
    assert.equal(looksLikeReadRpc("Greeter.GetStatus"), true);
    assert.equal(looksLikeReadRpc("system.listMethods"), true);
    assert.equal(looksLikeReadRpc("echo"), true);
    assert.equal(looksLikeReadRpc("SayHello"), false);
    assert.equal(looksLikeReadRpc("Add"), false);
    assert.equal(looksLikeReadRpc("Chat"), false);
    assert.equal(looksLikeReadRpc("sum"), false);
    assert.equal(looksLikeReadRpc(""), false);
  });

  it("detects GraphQL mutation/subscription ops and ignores comments or quoted mutation", () => {
    assert.equal(graphqlDocumentLooksLikeWrite("mutation { setHello }"), true);
    assert.equal(graphqlDocumentLooksLikeWrite("subscription { hello }"), true);
    assert.equal(graphqlDocumentLooksLikeWrite("{ hello }"), false);
    assert.equal(graphqlDocumentLooksLikeWrite("query { hello } # mutation"), false);
    assert.equal(graphqlDocumentLooksLikeWrite(`query { f(x: "mutation") }`), false);
  });
});
