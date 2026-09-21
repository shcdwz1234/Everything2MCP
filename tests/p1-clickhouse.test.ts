import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, it } from "node:test";
import { AdapterError } from "../src/runtime/errors.js";
import { ClickhouseAdapter } from "../src/adapters/clickhouse/index.js";
import { assertNotConnected, assertRelationalRoundTrip, assertWriteBlocked } from "./p1-helpers.js";

describe("P1 clickhouse", () => {
  it("refuses tools before connect", async () => {
    await assertNotConnected(new ClickhouseAdapter("x"));
  });

  it("simulator round-trip with dialect=clickhouse", async () => {
    await assertRelationalRoundTrip(new ClickhouseAdapter("ch"), "clickhouse");
  });

  it("allowWrite=false blocks execute", async () => {
    await assertWriteBlocked(new ClickhouseAdapter("ro"));
  });

  it("HTTP POST query on loopback; INSERT gated by allowWrite", async () => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const sql = Buffer.concat(chunks).toString("utf8");
        res.setHeader("content-type", "application/json");
        if (/^select/i.test(sql)) {
          res.end(`${JSON.stringify({ n: 1 })}\n`);
          return;
        }
        if (/show tables/i.test(sql)) {
          res.end(`${JSON.stringify({ name: "widgets" })}\n`);
          return;
        }
        if (/describe/i.test(sql)) {
          res.end(`${JSON.stringify({ name: "n", type: "UInt8" })}\n`);
          return;
        }
        res.end("");
      });
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
    const adapter = new ClickhouseAdapter("ch.http");
    try {
      await adapter.connect({ url: `http://127.0.0.1:${port}` });
      const rows = (await adapter.invoke("query", { sql: "SELECT 1 AS n" })) as { rows: Array<{ n: number }>; rowCount: number };
      assert.equal(rows.rowCount, 1);
      assert.equal(rows.rows[0]?.n, 1);
      const tables = (await adapter.invoke("list_tables", {})) as { tables: string[] };
      assert.ok(tables.tables.includes("widgets"));
      await assert.rejects(
        () => adapter.invoke("execute", { sql: "INSERT INTO widgets VALUES (1)" }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
      );
    } finally {
      await adapter.disconnect();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
