import assert from "node:assert/strict";
import { AdapterError } from "../src/runtime/errors.js";
import type { ProtocolAdapter } from "../src/adapters/spi.js";

export async function assertNotConnected(adapter: ProtocolAdapter): Promise<void> {
  await assert.rejects(
    () => adapter.listTools(),
    (err: unknown) => err instanceof AdapterError && err.code === "E_NOT_CONNECTED",
  );
}

export async function assertWriteBlocked(adapter: ProtocolAdapter, extra: Record<string, unknown> = {}): Promise<void> {
  await adapter.connect({ simulator: true, ...extra });
  try {
    await assert.rejects(
      () => adapter.invoke("execute", { sql: "CREATE TABLE t (id INTEGER)" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
    const read = (await adapter.invoke("query", { sql: "SELECT 1 AS n" })) as { dialect?: string; rowCount?: number };
    assert.ok((read.rowCount ?? 0) >= 1 || read.dialect);
  } finally {
    await adapter.disconnect();
  }
}

export async function assertRelationalRoundTrip(
  adapter: ProtocolAdapter,
  dialect: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await adapter.connect({ simulator: true, allowWrite: true, ...extra });
  try {
    const names = (await adapter.listTools()).map((t) => t.name).sort();
    assert.ok(names.includes("query"));
    assert.ok(names.includes("execute"));
    assert.ok(names.includes("list_tables"));
    assert.ok(names.includes("describe"));
    await adapter.invoke("execute", { sql: "CREATE TABLE widgets (id INTEGER, name TEXT)" });
    await adapter.invoke("execute", { sql: "INSERT INTO widgets (id, name) VALUES (1, 'gizmo')" });
    const rows = (await adapter.invoke("query", { sql: "SELECT * FROM widgets" })) as {
      dialect: string;
      rows: Array<{ name: string }>;
      rowCount: number;
    };
    assert.equal(rows.dialect, dialect);
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0]?.name, "gizmo");
    const tables = (await adapter.invoke("list_tables", {})) as { tables: string[]; dialect: string };
    assert.equal(tables.dialect, dialect);
    assert.ok(tables.tables.includes("widgets"));
    const desc = (await adapter.invoke("describe", { table: "widgets" })) as { columns: Array<{ name: string }> };
    assert.ok(desc.columns.some((c) => c.name === "name"));
    await assert.rejects(() => adapter.invoke("__nope__", {}), (err: unknown) => err instanceof Error);
    const health = await adapter.health?.();
    assert.equal(health?.ok, true);
  } finally {
    await adapter.disconnect();
  }
}
