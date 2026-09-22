import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createAdapter, registerBuiltinAdapters } from "../src/adapters/index.js";
import { AdapterError } from "../src/runtime/errors.js";

registerBuiltinAdapters();

describe("Phase V3 platform adapters", () => {
  const cleanups: Array<() => Promise<void>> = [];
  after(async () => {
    for (const fn of [...cleanups].reverse()) await fn().catch(() => undefined);
  });

  it("os_info uname is read-only", async () => {
    const a = createAdapter("os_info", "os_info:t");
    await a.connect({});
    const info = (await a.invoke("uname", {})) as { platform: string; node: string };
    assert.ok(info.platform);
    assert.ok(info.node);
    await a.disconnect();
  });

  it("platform_fs lists/reads gated roots and rejects escape", async () => {
    const dir = await mkdtemp(join(tmpdir(), "e2mcp-fs-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, "hello.txt"), "hi");
    const a = createAdapter("platform_fs", "platform_fs:t");
    await a.connect({ roots: [dir] });
    const listed = (await a.invoke("list", { path: dir })) as { entries: Array<{ name: string }> };
    assert.ok(listed.entries.some((e) => e.name === "hello.txt"));
    const read = (await a.invoke("read", { path: join(dir, "hello.txt") })) as { text: string };
    assert.equal(read.text, "hi");
    await assert.rejects(
      () => a.invoke("read", { path: "/etc/passwd" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
    await assert.rejects(() => a.connect({ allowWrite: true, roots: [dir] }), (err: unknown) => {
      return err instanceof AdapterError && err.code === "E_UNSUPPORTED";
    });
    await a.disconnect();
  });

  it("process_list uses injected driver; shell_exec is gated stub", async () => {
    const a = createAdapter("platform_process", "platform_process:t");
    await a.connect({
      listFn: () => [{ pid: 42, name: "fixture" }],
      allowShell: false,
    });
    const listed = (await a.invoke("process_list", {})) as { processes: Array<{ pid: number }> };
    assert.equal(listed.processes[0]?.pid, 42);
    await assert.rejects(
      () => a.invoke("shell_exec", { command: "true" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
    await a.disconnect();
    await a.connect({ listFn: () => [], allowShell: true });
    await assert.rejects(
      () => a.invoke("shell_exec", { command: "true" }),
      (err: unknown) => err instanceof AdapterError && /stub/i.test((err as Error).message),
    );
    await a.disconnect();
  });

  it("service_list uses injected driver; missing OS tool is E_UNSUPPORTED not fake", async () => {
    const a = createAdapter("platform_service", "platform_service:t");
    await a.connect({ listFn: () => [{ id: "ssh", state: "active" }] });
    const listed = (await a.invoke("service_list", {})) as { services: Array<{ id: string }> };
    assert.equal(listed.services[0]?.id, "ssh");
    await a.disconnect();
    await a.connect({ platform: "other" });
    await assert.rejects(
      () => a.invoke("service_list", {}),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
    await a.disconnect();
  });
});
