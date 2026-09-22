import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { DockerAdapter, createMemoryDocker } from "../src/adapters/docker/index.js";
import { createAdapter, registerBuiltinAdapters } from "../src/adapters/index.js";
import { AdapterError } from "../src/runtime/errors.js";

registerBuiltinAdapters();

describe("Phase P1 docker/podman read-only + logs", () => {
  it("simulator lists containers and logs; run stays E_UNSUPPORTED", async () => {
    const a = new DockerAdapter("docker:t");
    await a.connect({ simulator: true });
    const listed = (await a.invoke("list_containers", {})) as { containers: Array<{ Id: string }> };
    assert.ok(listed.containers.length >= 1);
    const logs = (await a.invoke("logs", { id: "abc123", tail: 10 })) as { lines: string[] };
    assert.ok(logs.lines.length >= 1);
    await assert.rejects(
      () => a.invoke("run", { image: "nginx" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
    );
    await a.disconnect();
  });

  it("podman factory uses docker-compat tools", async () => {
    const a = createAdapter("podman", "podman:t");
    assert.equal(a.protocol, "podman");
    await a.connect({ simulator: true });
    const listed = (await a.invoke("list_containers", {})) as { containers: unknown[] };
    assert.ok(listed.containers.length >= 1);
    await a.disconnect();
  });

  it("HTTP engine loopback logs", async () => {
    const mem = createMemoryDocker([{ Id: "c1", Names: ["/api"], Image: "e2mcp", State: "running" }]);
    const server = createServer((req, res) => {
      void (async () => {
        if (req.url?.startsWith("/containers/json")) {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(await mem.listContainers()));
          return;
        }
        if (req.url?.startsWith("/images/json")) {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(await mem.listImages()));
          return;
        }
        if (req.url?.includes("/logs")) {
          const out = await mem.logs("c1", 10);
          res.end(out.lines.join("\n"));
          return;
        }
        res.statusCode = 404;
        res.end("{}");
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const a = new DockerAdapter("docker:http");
    try {
      await a.connect({ url: `http://127.0.0.1:${port}` });
      const listed = (await a.invoke("list_containers", {})) as { containers: Array<{ Id: string }> };
      assert.equal(listed.containers[0]?.Id, "c1");
      const logs = (await a.invoke("logs", { id: "c1" })) as { lines: string[] };
      assert.ok(logs.lines.length >= 1);
    } finally {
      await a.disconnect();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
