import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AdapterError } from "../src/runtime/errors.js";
import {
  PrometheusAdapter,
  decodeWriteRequest,
  encodeWriteRequest,
  listenPromRemoteWrite,
  snappyCompress,
  snappyDecompress,
  type PrometheusHandle,
} from "../src/adapters/prometheus/index.js";

describe("PrometheusAdapter (P2)", () => {
  it("rejects missing url", async () => {
    await assert.rejects(() => new PrometheusAdapter("p").connect({}), /url/);
  });

  it("instant and range query through an injected handle", async () => {
    const handle: PrometheusHandle = {
      async query(expr, time) {
        return {
          status: "success",
          data: { resultType: "vector", result: [{ metric: { __name__: expr }, value: [time ?? "now", "1"] }] },
        };
      },
      async queryRange(expr, start, end, step) {
        return {
          status: "success",
          data: { resultType: "matrix", result: [{ metric: { __name__: expr }, values: [[start, "1"], [end, "2"]] }] },
          step,
        };
      },
      async close() {
        /* noop */
      },
    };
    const adapter = new PrometheusAdapter("local", async () => handle);
    await adapter.connect({ url: "http://127.0.0.1:9090" });
    try {
      const names = (await adapter.listTools()).map((t) => t.name).sort();
      assert.deepEqual(names, ["query", "query_range", "remote_write"]);
      const instant = (await adapter.invoke("query", { query: "up" })) as { status: string };
      assert.equal(instant.status, "success");
      const range = (await adapter.invoke("query_range", {
        query: "up",
        start: "0",
        end: "60",
        step: "15s",
      })) as { data: { resultType: string } };
      assert.equal(range.data.resultType, "matrix");
    } finally {
      await adapter.disconnect();
    }
  });

  it("parses instant and range JSON via mock HTTP", async () => {
    const seen: string[] = [];
    const fetchFn = async (url: string) => {
      seen.push(url);
      if (url.includes("query_range")) {
        return new Response(
          JSON.stringify({
            status: "success",
            data: { resultType: "matrix", result: [{ metric: { job: "api" }, values: [[1, "1"], [2, "2"]] }] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ status: "success", data: { resultType: "vector", result: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const adapter = new PrometheusAdapter("http", undefined, fetchFn);
    await adapter.connect({ url: "http://127.0.0.1:9090", timeoutMs: 500 });
    try {
      await adapter.invoke("query", { query: "up", time: "123" });
      assert.ok(seen[0]?.includes("/api/v1/query"));
      assert.ok(seen[0]?.includes("query=up"));
      const range = (await adapter.invoke("query_range", { query: "up", start: "0", end: "60" })) as {
        data: { resultType: string };
      };
      assert.equal(range.data.resultType, "matrix");
      assert.ok(seen[1]?.includes("/api/v1/query_range"));
      const health = await adapter.health();
      assert.match(health.detail ?? "", /timeoutMs=500/);
    } finally {
      await adapter.disconnect();
    }
  });

  it("maps PromQL status=error and HTTP 500 to E_PROTOCOL", async () => {
    let mode: "promql" | "http" = "promql";
    const fetchFn = async () => {
      if (mode === "http") {
        return new Response("nope", { status: 500, headers: { "content-type": "text/plain" } });
      }
      return new Response(JSON.stringify({ status: "error", errorType: "bad_data", error: "parse error" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const adapter = new PrometheusAdapter("err", undefined, fetchFn);
    await adapter.connect({ url: "http://127.0.0.1:9090" });
    try {
      await assert.rejects(
        () => adapter.invoke("query", { query: "up{" }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_PROTOCOL" && /parse error/.test(err.message),
      );
      mode = "http";
      await assert.rejects(
        () => adapter.invoke("query_range", { query: "up", start: "0", end: "1" }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_PROTOCOL" && /HTTP 500/.test(err.message),
      );
    } finally {
      await adapter.disconnect();
    }
  });

  it("maps aborted fetch to E_TIMEOUT", async () => {
    const fetchFn = async () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    };
    const adapter = new PrometheusAdapter("to", undefined, fetchFn);
    await adapter.connect({ url: "http://127.0.0.1:9090", timeoutMs: 50 });
    try {
      await assert.rejects(
        () => adapter.invoke("query", { query: "up" }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_TIMEOUT",
      );
    } finally {
      await adapter.disconnect();
    }
  });

  it("round-trips protobuf+snappy WriteRequest", () => {
    const series = [
      {
        labels: { __name__: "up", job: "api" },
        samples: [{ value: 1, timestamp: 1_725_000_000_123 }],
      },
    ];
    const decoded = decodeWriteRequest(snappyDecompress(snappyCompress(encodeWriteRequest(series))));
    assert.equal(decoded[0]?.labels.__name__, "up");
    assert.equal(decoded[0]?.labels.job, "api");
    assert.equal(decoded[0]?.samples[0]?.value, 1);
    assert.equal(decoded[0]?.samples[0]?.timestamp, 1_725_000_000_123);
  });

  it("memory remote_write is gated and queryable by name", async () => {
    const adapter = new PrometheusAdapter("mem");
    await adapter.connect({ simulator: true });
    try {
      await assert.rejects(
        () =>
          adapter.invoke("remote_write", {
            timeseries: [{ labels: { __name__: "up" }, samples: [{ value: 1, timestamp: 10 }] }],
          }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
      );
    } finally {
      await adapter.disconnect();
    }
    const w = new PrometheusAdapter("memw");
    await w.connect({ simulator: true, allowWrite: true });
    try {
      const wrote = (await w.invoke("remote_write", {
        timeseries: [{ labels: { __name__: "http_requests", job: "api" }, samples: [{ value: 7, timestamp: 20 }] }],
      })) as { written: number };
      assert.equal(wrote.written, 1);
      const q = (await w.invoke("query", { query: "http_requests" })) as {
        data: { result: Array<{ metric: Record<string, string>; value: [number, string] }> };
        note: string;
      };
      assert.equal(q.data.result[0]?.metric.__name__, "http_requests");
      assert.equal(q.data.result[0]?.value[1], "7");
      assert.match(q.note, /name-only/);
    } finally {
      await w.disconnect();
    }
  });

  it("HTTP remote_write protobuf+snappy then query on loopback", async () => {
    const loop = await listenPromRemoteWrite();
    const adapter = new PrometheusAdapter("rw");
    try {
      await adapter.connect({ url: `http://127.0.0.1:${loop.port}`, allowWrite: true, timeoutMs: 1500 });
      await adapter.invoke("remote_write", {
        timeseries: [{ labels: { __name__: "up", instance: "loop" }, samples: [{ value: 1, timestamp: 99 }] }],
      });
      const q = (await adapter.invoke("query", { query: 'up{__name__="up"}' })) as {
        data: { result: Array<{ metric: Record<string, string> }> };
      };
      assert.equal(q.data.result[0]?.metric.instance, "loop");
    } finally {
      await adapter.disconnect();
      await loop.close();
    }
  });
});
