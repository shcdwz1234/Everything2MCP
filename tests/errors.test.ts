import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AdapterError, ERROR_CODES, ERROR_CODE_HELP, errorPayload } from "../src/runtime/errors.js";

describe("AdapterError", () => {
  it("serializes a stable MCP error payload", () => {
    const err = new AdapterError("E_INVALID_CONFIG", "modbus adapter requires config.host", {
      protocol: "modbus",
      details: { keys: [] },
    });
    const payload = err.toJSON();
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "E_INVALID_CONFIG");
    assert.equal(payload.protocol, "modbus");
    assert.equal(payload.error, "modbus adapter requires config.host");
  });

  it("classifies plain Errors for MCP tool results", () => {
    const unknown = errorPayload(new Error("Unknown tool: foo.bar.baz"));
    assert.equal(unknown.code, "E_UNKNOWN_TOOL");
    const timeout = errorPayload(new Error("Timed out waiting for MQTT"));
    assert.equal(timeout.code, "E_TIMEOUT");
    const proto = errorPayload(new Error("Unknown protocol \"x\". Known adapters: mqtt"));
    assert.equal(proto.code, "E_UNKNOWN_PROTOCOL");
    const listed = errorPayload(new Error("Target is blacklisted (mqtt 10.0.0.8:1883)"));
    assert.equal(listed.code, "E_BLACKLISTED");
  });

  it("ERROR_CODE_HELP covers every ERROR_CODES entry", () => {
    assert.equal(ERROR_CODES.length, Object.keys(ERROR_CODE_HELP).length);
    for (const code of ERROR_CODES) {
      assert.equal(typeof ERROR_CODE_HELP[code], "string");
    }
  });
});
