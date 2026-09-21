import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AdapterError } from "../src/runtime/errors.js";
import { DuckdbAdapter } from "../src/adapters/duckdb/index.js";
import { assertNotConnected, assertRelationalRoundTrip, assertWriteBlocked } from "./p1-helpers.js";

describe("P1 duckdb", () => {
  it("refuses tools before connect", async () => {
    await assertNotConnected(new DuckdbAdapter("x"));
  });

  it("simulator round-trip with dialect=duckdb", async () => {
    await assertRelationalRoundTrip(new DuckdbAdapter("duck"), "duckdb");
  });

  it("allowWrite=false blocks execute", async () => {
    await assertWriteBlocked(new DuckdbAdapter("ro"));
  });

  it("file/url without the duckdb package is E_UNSUPPORTED", async () => {
    await assert.rejects(
      () => new DuckdbAdapter("live").connect({ filename: "/tmp/ci.duckdb" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
  });
});
