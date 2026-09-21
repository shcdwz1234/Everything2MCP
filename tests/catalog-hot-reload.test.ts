import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { registerBuiltinAdapters } from "../src/adapters/index.js";
import { AdapterError } from "../src/runtime/errors.js";
import { ToolRegistry } from "../src/catalog/registry.js";
import { JsonStore } from "../src/catalog/store.js";

describe("catalog hot-reload", () => {
  let dataDir: string;
  let registry: ToolRegistry;
  let store: JsonStore;
  let changeCount = 0;

  before(async () => {
    registerBuiltinAdapters();
    dataDir = await mkdtemp(join(tmpdir(), "e2mcp-hot-"));
    store = new JsonStore(dataDir);
    registry = new ToolRegistry(store);
    registry.onChange(() => {
      changeCount += 1;
    });
  });

  after(async () => {
    await registry.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("add/update/remove remount tools without process restart and emit onChange", async () => {
    changeCount = 0;
    const added = await registry.add("sqlite", "mem", { filename: ":memory:", allowWrite: true });
    assert.equal(added.record.id, "sqlite:mem");
    assert.ok(changeCount >= 1);
    const names = registry.list().tools.map((t) => t.name);
    assert.ok(names.includes("sqlite.mem.query"));
    assert.ok(names.includes("sqlite.mem.execute"));

    await registry.invoke("sqlite.mem.execute", { sql: "CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT)" });
    await registry.invoke("sqlite.mem.execute", { sql: "INSERT INTO widgets (name) VALUES ('hot')" });

    const beforeUpdate = changeCount;
    await registry.update("sqlite:mem", { allowWrite: false });
    assert.ok(changeCount > beforeUpdate);
    await assert.rejects(
      () => registry.invoke("sqlite.mem.execute", { sql: "INSERT INTO widgets (name) VALUES ('blocked')" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
    const listed = registry.list();
    assert.equal(listed.adapters.length, 1);
    assert.equal(listed.adapters[0]?.status, "live");

    const clone = new ToolRegistry(store);
    await clone.restore();
    assert.equal(clone.list().adapters[0]?.status, "live");
    assert.ok(clone.list().tools.some((t) => t.name === "sqlite.mem.query"));
    await clone.shutdown();

    const beforeRemove = changeCount;
    assert.equal(await registry.remove("sqlite:mem"), true);
    assert.ok(changeCount > beforeRemove);
    assert.equal(registry.list().adapters.length, 0);
    assert.equal(registry.adapterTools().length, 0);
  });

  it("restore_failed stays visible when a persisted adapter cannot remount", async () => {
    const dir = await mkdtemp(join(tmpdir(), "e2mcp-fail-"));
    const failStore = new JsonStore(dir);
    await failStore.save([
      {
        id: "prometheus:broken",
        name: "broken",
        protocol: "prometheus",
        config: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    const clone = new ToolRegistry(failStore);
    await clone.restore();
    const snap = clone.list().adapters.find((a) => a.id === "prometheus:broken");
    assert.equal(snap?.status, "restore_failed");
    assert.ok(snap?.error);
    await clone.shutdown();
    await rm(dir, { recursive: true, force: true });
  });
});
