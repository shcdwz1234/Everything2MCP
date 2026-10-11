import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AwsIamAdapter } from "../src/adapters/aws-iam/index.js";
import { BrowserAdapter } from "../src/adapters/browser/index.js";
import { DockerAdapter } from "../src/adapters/docker/index.js";
import { JiraAdapter } from "../src/adapters/jira/index.js";
import { KubernetesAdapter } from "../src/adapters/kubernetes/index.js";
import { NfsAdapter } from "../src/adapters/nfs/index.js";
import { createAdapter, registerBuiltinAdapters } from "../src/adapters/index.js";
import { AdapterError } from "../src/runtime/errors.js";
import {
  filterLocalPlatformSuggestions,
  isLocalPlatformProtocol,
  localCandidateId,
  localCapabilityUrl,
} from "../src/discovery/local-capabilities.js";

registerBuiltinAdapters();

describe("Thin adapter E_UNSUPPORTED honesty + platform local caps", () => {
  it("docker run / browser navigate / k8s exec stay E_UNSUPPORTED", async () => {
    const docker = new DockerAdapter("docker:thin");
    await docker.connect({ simulator: true });
    await assert.rejects(
      () => docker.invoke("run", { image: "nginx" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
    await docker.disconnect();

    const browser = new BrowserAdapter("browser:thin");
    await browser.connect({});
    await assert.rejects(
      () => browser.invoke("navigate", { url: "https://example.test" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
    await browser.disconnect();

    const k8s = new KubernetesAdapter("k8s:thin");
    await k8s.connect({ simulator: true });
    await assert.rejects(
      () => k8s.invoke("exec", { name: "web", command: "id" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
    await assert.rejects(
      () => k8s.invoke("apply", { manifest: { kind: "Pod" } }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
    await k8s.disconnect();
  });

  it("aws_iam live connect refuses; nfs simulator list works (live SHOWMOUNT is E_UNSUPPORTED in nfs-adapter tests)", async () => {
    const iam = new AwsIamAdapter("iam:thin");
    await assert.rejects(
      () => iam.connect({ live: true }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );

    const nfs = new NfsAdapter("nfs:thin");
    await nfs.connect({ simulator: true });
    const listed = (await nfs.invoke("list_exports", {})) as { exports: unknown[] };
    assert.ok(listed.exports.length >= 1);
    await nfs.disconnect();
  });

  it("jira is read-only: listed tools work; inventing a write tool is E_UNKNOWN_TOOL not silent OK", async () => {
    const jira = new JiraAdapter("jira:thin");
    await jira.connect({ simulator: true });
    const tools = (await jira.listTools()).map((t) => t.name);
    assert.ok(tools.includes("search"));
    assert.ok(tools.includes("get_issue"));
    assert.ok(!tools.some((n) => /create|transition|update|comment/i.test(n)));
    const found = (await jira.invoke("search", { jql: "E2M" })) as { issues: unknown[] };
    assert.ok(found.issues.length >= 1);
    await assert.rejects(
      () => jira.invoke("create_issue", { summary: "x" }),
      (err: unknown) => err instanceof AdapterError && (err.code === "E_UNKNOWN_TOOL" || err.code === "E_UNSUPPORTED"),
    );
    await jira.disconnect();
  });

  it("platform local-capability helpers stay hermetic and stable", () => {
    assert.equal(isLocalPlatformProtocol("docker"), true);
    assert.equal(isLocalPlatformProtocol("os_info"), true);
    assert.equal(isLocalPlatformProtocol("redis"), false);
    assert.equal(localCandidateId("Docker"), "docker|local");
    assert.equal(localCapabilityUrl("platform_fs"), "local://platform_fs");
    const filtered = filterLocalPlatformSuggestions([
      { protocol: "docker", name: "docker", reason: "Docker socket present", confidence: 0.9, config: {}, source: "environment" },
      { protocol: "redis", name: "redis", reason: "Listening TCP :6379", confidence: 0.8, config: {}, source: "environment" },
      { protocol: "os_info", name: "os", reason: "Listening TCP :1", confidence: 0.5, config: {}, source: "environment" },
      { protocol: "os_info", name: "os2", reason: "local host inventory", confidence: 0.9, config: {}, source: "environment" },
    ]);
    assert.deepEqual(
      filtered.map((s) => s.protocol),
      ["docker", "os_info"],
    );
  });

  it("podman alias factory is Thin-honest like docker", async () => {
    const a = createAdapter("podman", "podman:thin");
    await a.connect({ simulator: true });
    await assert.rejects(
      () => a.invoke("run", { image: "busybox" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
    await a.disconnect();
  });
});
