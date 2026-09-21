import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { AdapterError } from "../src/runtime/errors.js";
import { GraphqlAdapter, listenGraphqlWs } from "../src/adapters/graphql/index.js";

describe("GraphqlAdapter", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
          query?: string;
        };
        const q = body.query ?? "";
        res.setHeader("content-type", "application/json");
        if (q.includes("__schema")) {
          res.end(
            JSON.stringify({
              data: {
                __schema: {
                  queryType: { fields: [{ name: "hello", description: "greeting" }] },
                  mutationType: { fields: [{ name: "setHello" }] },
                },
              },
            }),
          );
          return;
        }
        if (q.includes("setHello")) {
          res.end(JSON.stringify({ data: { setHello: { __typename: "Mutation" } } }));
          return;
        }
        res.end(JSON.stringify({ data: { hello: "world" } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    url = `http://127.0.0.1:${port}/graphql`;
    close = () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  after(async () => {
    await close();
  });

  it("rejects missing url", async () => {
    await assert.rejects(() => new GraphqlAdapter("g").connect({}), /config\.url/);
  });

  it("queries, mutates, and exposes introspected fields", async () => {
    const adapter = new GraphqlAdapter("gql");
    await adapter.connect({ url, introspect: true, allowWrite: true });
    const tools = (await adapter.listTools()).map((t) => t.name);
    assert.ok(tools.includes("query"));
    assert.ok(tools.includes("mutate"));
    assert.ok(tools.includes("Query_hello"));
    assert.ok(tools.includes("Mutation_setHello"));
    const q = (await adapter.invoke("query", { query: "{ hello }" })) as { data: { hello: string } };
    assert.equal(q.data.hello, "world");
    const m = (await adapter.invoke("mutate", { mutation: "mutation { setHello { __typename } }" })) as {
      data: { setHello: { __typename: string } };
    };
    assert.equal(m.data.setHello.__typename, "Mutation");
    await adapter.disconnect();
  });

  it("rejects tools before connect, unknown tools, and missing mutation", async () => {
    const adapter = new GraphqlAdapter("gql");
    await assert.rejects(() => adapter.listTools(), /not connected/);
    await adapter.connect({ url, introspect: false, allowWrite: true });
    try {
      await assert.rejects(() => adapter.invoke("nope", {}), /Unknown GraphQL tool/);
      await assert.rejects(() => adapter.invoke("mutate", {}), /mutation/);
    } finally {
      await adapter.disconnect();
    }
  });

  it("defaults allowWrite=false and blocks mutate; query still works", async () => {
    const adapter = new GraphqlAdapter("ro");
    await adapter.connect({ url, introspect: true });
    try {
      const q = (await adapter.invoke("query", { query: "{ hello }" })) as { data: { hello: string } };
      assert.equal(q.data.hello, "world");
      await assert.rejects(
        () => adapter.invoke("mutate", { mutation: "mutation { setHello { __typename } }" }),
        /allowWrite/,
      );
      await assert.rejects(() => adapter.invoke("Mutation_setHello", {}), /allowWrite/);
      await assert.rejects(
        () => adapter.invoke("query", { query: "mutation { setHello { __typename } }" }),
        /allowWrite/,
      );
      await assert.rejects(
        () => adapter.invoke("query", { query: "subscription { hello }" }),
        /allowWrite/,
      );
      const smuggle = (await adapter.invoke("query", {
        query: `query { hello } # mutation
`,
      })) as { data: { hello: string } };
      assert.equal(smuggle.data.hello, "world");
      const quoted = (await adapter.invoke("query", { query: `{ hello }` })) as { data: { hello: string } };
      assert.equal(quoted.data.hello, "world");
    } finally {
      await adapter.disconnect();
    }
  });

  it("builds Query_/Mutation_ tools from inline SDL without HTTP", async () => {
    const adapter = new GraphqlAdapter("sdl");
    await adapter.connect({
      url: "http://127.0.0.1:9/graphql",
      sdl: "type Query { ping: String } type Mutation { setPing: Boolean }",
    });
    try {
      const names = (await adapter.listTools()).map((t) => t.name);
      assert.ok(names.includes("Query_ping"));
      assert.ok(names.includes("Mutation_setPing"));
    } finally {
      await adapter.disconnect();
    }
  });

  it("simulator subscribe_once waits for publish_event; HTTP path stays E_UNSUPPORTED", async () => {
    const mem = new GraphqlAdapter("sub");
    await mem.connect({ simulator: true, allowWrite: true });
    try {
      const names = (await mem.listTools()).map((t) => t.name);
      assert.ok(names.includes("subscribe_once"));
      const pending = mem.invoke("subscribe_once", { query: "subscription { tick }", timeoutMs: 800 });
      await new Promise((r) => setTimeout(r, 20));
      await mem.invoke("publish_event", { field: "tick", data: 7 });
      const ev = (await pending) as { data: { tick: number } };
      assert.equal(ev.data.tick, 7);
    } finally {
      await mem.disconnect();
    }
    const httpOnly = new GraphqlAdapter("http");
    await httpOnly.connect({ url, introspect: false });
    try {
      await assert.rejects(
        () => httpOnly.invoke("subscribe_once", { query: "subscription { hello }" }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
      );
    } finally {
      await httpOnly.disconnect();
    }
  });

  it("graphql-ws loopback subscribe then next", async () => {
    const loop = await listenGraphqlWs();
    const adapter = new GraphqlAdapter("ws");
    try {
      await adapter.connect({
        url: `http://127.0.0.1:${loop.port}/graphql`,
        wsUrl: `ws://127.0.0.1:${loop.port}/graphql`,
        introspect: false,
      });
      const pending = adapter.invoke("subscribe_once", { query: "subscription { tick }", timeoutMs: 1500 });
      await new Promise((r) => setTimeout(r, 80));
      loop.publish("tick", 42);
      const ev = (await pending) as { data: { tick: number } };
      assert.equal(ev.data.tick, 42);
    } finally {
      await adapter.disconnect();
      await loop.close();
    }
  });
});
