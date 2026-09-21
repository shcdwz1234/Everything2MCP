import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AdapterError } from "../src/runtime/errors.js";
import { SqlServerAdapter } from "../src/adapters/sqlserver/index.js";
import { assertNotConnected, assertRelationalRoundTrip, assertWriteBlocked } from "./p1-helpers.js";

describe("P1 sqlserver", () => {
  it("refuses tools before connect", async () => {
    await assertNotConnected(new SqlServerAdapter("x"));
  });

  it("simulator round-trip with dialect=sqlserver", async () => {
    await assertRelationalRoundTrip(new SqlServerAdapter("ms"), "sqlserver");
  });

  it("allowWrite=false blocks execute", async () => {
    await assertWriteBlocked(new SqlServerAdapter("ro"));
  });

  it("live TDS url without a client is E_UNSUPPORTED", async () => {
    await assert.rejects(
      () => new SqlServerAdapter("live").connect({ url: "sqlserver://127.0.0.1:1433" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
  });
});
