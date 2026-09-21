import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, it } from "node:test";
import { AdapterError } from "../src/runtime/errors.js";
import {
  InfluxAdapter,
  createMemoryInflux,
  formatLineProtocol,
  parseLineProtocol,
} from "../src/adapters/influx/index.js";

describe("InfluxAdapter", () => {
  it("rejects missing bucket", async () => {
    await assert.rejects(() => new InfluxAdapter("x").connect({}), /bucket/);
  });

  it("parses line protocol", () => {
    const p = parseLineProtocol('cpu,host=a usage=0.5,n=2i 123');
    assert.equal(p?.measurement, "cpu");
    assert.equal(p?.tags.host, "a");
    assert.equal(p?.fields.usage, 0.5);
    assert.equal(p?.fields.n, 2);
    assert.equal(p?.timestamp, "123");
    assert.match(formatLineProtocol({ measurement: "cpu", tags: { host: "a" }, fields: { usage: 0.5 } }), /cpu,host=a/);
  });

  it("write_points and Flux query on memory when allowWrite=true", async () => {
    const adapter = new InfluxAdapter("metrics");
    await adapter.connect({ bucket: "metrics", org: "lab", allowWrite: true });
    try {
      const names = (await adapter.listTools()).map((t) => t.name).sort();
      assert.deepEqual(names, ["delete_points", "query", "write_points"]);
      const w1 = (await adapter.invoke("write_points", { lines: "cpu,host=a usage=0.5 1" })) as { written: number };
      assert.equal(w1.written, 1);
      await adapter.invoke("write_points", {
        points: [{ measurement: "cpu", tags: { host: "b" }, fields: { usage: 0.9 }, timestamp: "2" }],
      });
      const all = (await adapter.invoke("query", {
        flux: 'from(bucket: "metrics") |> range(start: -1h)',
      })) as { tables: Array<{ records: Array<{ _measurement: string; host?: string }> }> };
      assert.equal(all.tables[0]?.records.length, 2);
      const filtered = (await adapter.invoke("query", {
        flux: 'from(bucket: "metrics") |> filter(fn: (r) => r._measurement == "cpu")',
      })) as { dialect: string };
      assert.equal(filtered.dialect, "flux-json-compat");
    } finally {
      await adapter.disconnect();
    }
  });

  it("defaults allowWrite=false and still allows query", async () => {
    const mem = createMemoryInflux("metrics");
    await mem.write("cpu usage=1", "metrics");
    const adapter = new InfluxAdapter("ro", async () => mem);
    await adapter.connect({ bucket: "metrics" });
    try {
      const q = (await adapter.invoke("query", { query: 'from(bucket: "metrics")' })) as {
        tables: Array<{ records: unknown[] }>;
      };
      assert.equal(q.tables[0]?.records.length, 1);
      await assert.rejects(
        () => adapter.invoke("write_points", { lines: "cpu usage=2" }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
      );
      await assert.rejects(
        () => adapter.invoke("delete_points", { start: "0", stop: "9", predicate: '_measurement="cpu"' }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
      );
      await assert.rejects(() => adapter.invoke("query", {}), /flux/);
      const health = await adapter.health();
      assert.match(health.detail ?? "", /allowWrite=false/);
      assert.match(health.detail ?? "", /no InfluxQL/);
    } finally {
      await adapter.disconnect();
    }
  });

  it("POSTs line protocol and Flux to a local Influx-shaped fake", async () => {
    const writes: string[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "POST" && url.pathname === "/api/v2/write") {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c as Buffer));
        req.on("end", () => {
          writes.push(Buffer.concat(chunks).toString("utf8"));
          res.writeHead(204);
          res.end();
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/v2/delete") {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c as Buffer));
        req.on("end", () => {
          writes.push(`DELETE ${url.search} ${Buffer.concat(chunks).toString("utf8")}`);
          res.writeHead(204);
          res.end();
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/v2/query") {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c as Buffer));
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              dialect: "flux-json-compat",
              flux: Buffer.concat(chunks).toString("utf8"),
              tables: [{ records: [{ _measurement: "cpu", _field: "usage", _value: 1 }] }],
            }),
          );
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
    const adapter = new InfluxAdapter("http");
    try {
      await adapter.connect({
        bucket: "metrics",
        org: "lab",
        url: `http://127.0.0.1:${port}`,
        allowWrite: true,
        simulator: false,
        token: "s.local",
      });
      await adapter.invoke("write_points", { lines: "cpu usage=1" });
      assert.match(writes[0] ?? "", /cpu usage=1/);
      await adapter.invoke("delete_points", {
        start: "1970-01-01T00:00:00Z",
        stop: "1970-01-02T00:00:00Z",
        predicate: '_measurement="cpu"',
      });
      assert.match(writes[1] ?? "", /DELETE /);
      assert.match(writes[1] ?? "", /_measurement=/);
      assert.match(writes[1] ?? "", /cpu/);
      const q = (await adapter.invoke("query", { flux: 'from(bucket: "metrics")' })) as {
        tables: Array<{ records: unknown[] }>;
      };
      assert.equal(q.tables[0]?.records.length, 1);
    } finally {
      await adapter.disconnect();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it("delete_points filters memory by predicate and [start, stop)", async () => {
    const adapter = new InfluxAdapter("del");
    await adapter.connect({ bucket: "metrics", allowWrite: true });
    try {
      await adapter.invoke("write_points", {
        lines: "cpu,host=a usage=1 1\ncpu,host=b usage=2 2\nmem,host=a used=3 3",
      });
      const del = (await adapter.invoke("delete_points", {
        start: "1",
        stop: "3",
        predicate: '_measurement="cpu"',
      })) as { deleted: number };
      assert.equal(del.deleted, 2);
      const left = (await adapter.invoke("query", { flux: 'from(bucket: "metrics")' })) as {
        tables: Array<{ records: Array<{ _measurement: string }> }>;
      };
      assert.equal(left.tables[0]?.records.length, 1);
      assert.equal(left.tables[0]?.records[0]?._measurement, "mem");
    } finally {
      await adapter.disconnect();
    }
  });
});
