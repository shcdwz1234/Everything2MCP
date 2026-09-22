import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AwsIamAdapter } from "../src/adapters/aws-iam/index.js";
import { AdapterError } from "../src/runtime/errors.js";

describe("aws_iam read-only slice", () => {
  it("simulator caller_identity; live IMDS/STS E_UNSUPPORTED", async () => {
    const a = new AwsIamAdapter("iam:t");
    await a.connect({ simulator: true });
    const id = (await a.invoke("caller_identity", {})) as { source: string; arn: string };
    assert.equal(id.source, "simulator");
    assert.match(id.arn, /iam/);
    const roles = (await a.invoke("list_roles", {})) as { roles: string[] };
    assert.ok(roles.roles.length >= 1);
    await a.disconnect();

    const live = new AwsIamAdapter("iam:live");
    await assert.rejects(
      () => live.connect({ live: true }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
  });
});
