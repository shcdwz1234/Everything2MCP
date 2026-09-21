import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { credentialsFromConfig, GrpcAdapter } from "../src/adapters/grpc/index.js";
import { AdapterError } from "../src/runtime/errors.js";
import { REFLECTION_VARIANTS, reflectionProto } from "../src/adapters/grpc/reflection.js";

const protoPath = fileURLToPath(new URL("../examples/greeter.proto", import.meta.url));

describe("GrpcAdapter", () => {
  let server: grpc.Server;
  let port: number;

  before(async () => {
    const def = protoLoader.loadSync(protoPath, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const pkg = grpc.loadPackageDefinition(def) as {
      helloworld: { Greeter: grpc.ServiceClientConstructor };
    };
    server = new grpc.Server();
    server.addService(pkg.helloworld.Greeter.service, {
      getStatus: (
        call: grpc.ServerUnaryCall<{ name?: string }, { message: string }>,
        callback: grpc.sendUnaryData<{ message: string }>,
      ) => {
        callback(null, { message: `ok ${call.request.name ?? ""}` });
      },
      sayHello: (
        call: grpc.ServerUnaryCall<{ name?: string }, { message: string }>,
        callback: grpc.sendUnaryData<{ message: string }>,
      ) => {
        callback(null, { message: `hello ${call.request.name ?? ""}` });
      },
      streamHello: (call: grpc.ServerWritableStream<{ name?: string }, { message: string }>) => {
        const name = call.request.name ?? "";
        call.write({ message: `hello ${name} 1` });
        call.write({ message: `hello ${name} 2` });
        call.write({ message: `hello ${name} 3` });
        call.end();
      },
      collectHellos: (
        call: grpc.ServerReadableStream<{ name?: string }, { message: string }>,
        callback: grpc.sendUnaryData<{ message: string }>,
      ) => {
        const names: string[] = [];
        call.on("data", (req: { name?: string }) => {
          names.push(req.name ?? "");
        });
        call.on("end", () => {
          callback(null, { message: `hello ${names.join("+")}` });
        });
        call.on("error", (err: Error) => callback(err, null));
      },
      chat: (call: grpc.ServerDuplexStream<{ name?: string }, { message: string }>) => {
        call.on("data", (req: { name?: string }) => {
          call.write({ message: `ack ${req.name ?? ""}` });
        });
        call.on("end", () => call.end());
      },
    });
    port = await new Promise<number>((resolve, reject) => {
      server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (err, bound) => {
        if (err) reject(err);
        else resolve(bound);
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.tryShutdown(() => resolve()));
  });

  it("rejects missing proto and target", async () => {
    const adapter = new GrpcAdapter("bad");
    await assert.rejects(() => adapter.connect({ target: "127.0.0.1:1" }), /proto/);
    await assert.rejects(
      () => adapter.connect({ proto: protoPath }),
      /target/,
    );
  });

  it("lists unary plus server-, client-, and bidi-streaming RPCs", async () => {
    const adapter = new GrpcAdapter("greeter");
    await adapter.connect({ proto: protoPath, target: `127.0.0.1:${port}` });
    const tools = await adapter.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("Greeter_SayHello"), `got ${names.join(",")}`);
    assert.ok(names.some((n) => /StreamHello/i.test(n)), `got ${names.join(",")}`);
    assert.ok(names.some((n) => /CollectHellos/i.test(n)), `got ${names.join(",")}`);
    assert.ok(names.some((n) => /Chat/i.test(n)), `got ${names.join(",")}`);
    const chat = tools.find((t) => /Chat/i.test(t.name));
    assert.match(chat?.description ?? "", /One-shot bidi|cancel/);
    const health = await adapter.health();
    assert.equal(health.ok, true);
    assert.match(health.detail ?? "", /serverStream=1/);
    assert.match(health.detail ?? "", /clientStream=1/);
    assert.match(health.detail ?? "", /bidiStream=1/);
    await adapter.disconnect();
  });

  it("invokes a unary RPC against an in-process server", async () => {
    const adapter = new GrpcAdapter("live");
    await adapter.connect({ proto: protoPath, target: `127.0.0.1:${port}`, allowWrite: true });
    const reply = (await adapter.invoke("Greeter_SayHello", { body: { name: "Ada" } })) as {
      message: string;
    };
    assert.equal(reply.message, "hello Ada");
    const reply2 = (await adapter.invoke("Greeter_SayHello", { name: "Bob" })) as { message: string };
    assert.equal(reply2.message, "hello Bob");
    await adapter.disconnect();
  });

  it("loads inline proto text", async () => {
    const adapter = new GrpcAdapter("inline");
    const proto = `
      syntax = "proto3";
      package demo;
      service Ping { rpc Echo (Msg) returns (Msg); }
      message Msg { string text = 1; }
    `;
    await adapter.connect({ protoInline: proto, target: "127.0.0.1:9" });
    const tools = await adapter.listTools();
    assert.equal(tools[0]?.name, "Ping_Echo");
    await adapter.disconnect();
  });

  it("discovers unary methods via reflection:true without a proto file", async () => {
    const def = protoLoader.loadSync(protoPath, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const adapter = new GrpcAdapter("refl", async () => def);
    await adapter.connect({ target: `127.0.0.1:${port}`, reflection: true, allowWrite: true });
    const tools = await adapter.listTools();
    assert.ok(tools.some((t) => t.name === "Greeter_SayHello"));
    const reply = (await adapter.invoke("Greeter_SayHello", { name: "Refl" })) as { message: string };
    assert.equal(reply.message, "hello Refl");
    const health = await adapter.health();
    assert.match(health.detail ?? "", /reflection/);
    await adapter.disconnect();
  });

  it("defaults allowWrite=false and blocks RPC invoke; listTools still works", async () => {
    const adapter = new GrpcAdapter("ro");
    await adapter.connect({ proto: protoPath, target: `127.0.0.1:${port}` });
    try {
      const names = (await adapter.listTools()).map((t) => t.name);
      assert.ok(names.includes("Greeter_SayHello"));
      await assert.rejects(() => adapter.invoke("Greeter_SayHello", { name: "Ada" }), /allowWrite/);
      const status = (await adapter.invoke("Greeter_GetStatus", { name: "Ada" })) as { message: string };
      assert.equal(status.message, "ok Ada");
    } finally {
      await adapter.disconnect();
    }
  });

  it("collects server-stream replies and sends a client-stream", async () => {
    const adapter = new GrpcAdapter("streams");
    await adapter.connect({ proto: protoPath, target: `127.0.0.1:${port}`, allowWrite: true });
    try {
      const streamed = (await adapter.invoke("Greeter_StreamHello", {
        body: { name: "Ada" },
        maxMessages: 2,
        timeoutMs: 2000,
      })) as { messages: Array<{ message: string }>; count: number; truncated: boolean };
      assert.equal(streamed.count, 2);
      assert.equal(streamed.truncated, true);
      assert.equal(streamed.messages[0]?.message, "hello Ada 1");
      assert.equal(streamed.messages[1]?.message, "hello Ada 2");

      const collected = (await adapter.invoke("Greeter_CollectHellos", {
        messages: [{ name: "Ada" }, { name: "Bob" }],
        timeoutMs: 2000,
      })) as { message: string };
      assert.equal(collected.message, "hello Ada+Bob");

      await assert.rejects(
        () => adapter.invoke("Greeter_CollectHellos", { messages: [] }),
        /messages/,
      );
    } finally {
      await adapter.disconnect();
    }
  });

  it("runs one-shot bidi Chat: write messages[], collect window, then cancel", async () => {
    const adapter = new GrpcAdapter("bidi");
    await adapter.connect({ proto: protoPath, target: `127.0.0.1:${port}`, allowWrite: true });
    try {
      const full = (await adapter.invoke("Greeter_Chat", {
        messages: [{ name: "Ada" }, { name: "Bob" }],
        timeoutMs: 2000,
      })) as {
        messages: Array<{ message: string }>;
        count: number;
        truncated: boolean;
        cancelled: boolean;
        window: { maxMessages: number };
      };
      assert.equal(full.count, 2);
      assert.equal(full.truncated, false);
      assert.equal(full.window.maxMessages, 8);
      assert.equal(full.messages[0]?.message, "ack Ada");
      assert.equal(full.messages[1]?.message, "ack Bob");

      const capped = (await adapter.invoke("Greeter_Chat", {
        messages: [{ name: "A" }, { name: "B" }, { name: "C" }],
        maxMessages: 1,
        timeoutMs: 2000,
      })) as { count: number; truncated: boolean; cancelled: boolean; messages: Array<{ message: string }> };
      assert.equal(capped.count, 1);
      assert.equal(capped.truncated, true);
      assert.equal(capped.cancelled, true);
      assert.equal(capped.messages[0]?.message, "ack A");

      await assert.rejects(() => adapter.invoke("Greeter_Chat", { messages: [] }), /messages/);
    } finally {
      await adapter.disconnect();
    }
  });

  it("session bidi: open/send/recv/close with backpressure, timeout, and cancel", async () => {
    const adapter = new GrpcAdapter("session");
    await adapter.connect({ proto: protoPath, target: `127.0.0.1:${port}`, allowWrite: true });
    try {
      const names = (await adapter.listTools()).map((t) => t.name);
      assert.ok(names.includes("bidi_open"));
      assert.ok(names.includes("bidi_send"));
      assert.ok(names.includes("bidi_recv"));
      assert.ok(names.includes("bidi_close"));

      const opened = (await adapter.invoke("bidi_open", {
        method: "Greeter_Chat",
        maxMessages: 1,
        timeoutMs: 15_000,
      })) as { streamId: string; maxMessages: number };
      assert.ok(opened.streamId);
      assert.equal(opened.maxMessages, 1);

      await adapter.invoke("bidi_send", { streamId: opened.streamId, message: { name: "Ada" } });
      const first = (await adapter.invoke("bidi_recv", {
        streamId: opened.streamId,
        timeoutMs: 2000,
      })) as { messages: Array<{ message: string }>; count: number; paused: boolean };
      assert.equal(first.count, 1);
      assert.equal(first.messages[0]?.message, "ack Ada");

      await adapter.invoke("bidi_send", { streamId: opened.streamId, name: "Bob" });
      const second = (await adapter.invoke("bidi_recv", {
        streamId: opened.streamId,
        timeoutMs: 2000,
      })) as { messages: Array<{ message: string }> };
      assert.equal(second.messages[0]?.message, "ack Bob");

      const st = (await adapter.invoke("bidi_status", { streamId: opened.streamId })) as {
        received: number;
        method: string;
      };
      assert.equal(st.method, "Greeter_Chat");
      assert.ok(st.received >= 2);

      const closed = (await adapter.invoke("bidi_close", { streamId: opened.streamId })) as {
        cancelled: boolean;
        closed: boolean;
      };
      assert.equal(closed.cancelled, true);
      await assert.rejects(
        () => adapter.invoke("bidi_send", { streamId: opened.streamId, message: { name: "Z" } }),
        /unknown or closed/i,
      );

      const idle = (await adapter.invoke("bidi_open", { method: "Greeter_Chat" })) as { streamId: string };
      await assert.rejects(
        () => adapter.invoke("bidi_recv", { streamId: idle.streamId, timeoutMs: 80 }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_TIMEOUT",
      );
      await adapter.invoke("bidi_close", { streamId: idle.streamId });

      await assert.rejects(
        () => adapter.invoke("bidi_open", { method: "Greeter_SayHello" }),
        /not a bidi-stream/,
      );
    } finally {
      await adapter.disconnect();
    }
  });

  it("session bidi open/send stay write-gated; recv/close are not", async () => {
    const adapter = new GrpcAdapter("session-ro");
    await adapter.connect({ proto: protoPath, target: `127.0.0.1:${port}` });
    try {
      await assert.rejects(
        () => adapter.invoke("bidi_open", { method: "Greeter_Chat" }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
      );
      await assert.rejects(
        () => adapter.invoke("bidi_recv", { streamId: "missing", timeoutMs: 50 }),
        /Unknown or closed/,
      );
    } finally {
      await adapter.disconnect();
    }
  });

  it("loads custom PEM paths and rejects unreadable cert files", () => {
    const insecure = credentialsFromConfig({ tls: false });
    assert.ok(insecure);
    assert.throws(
      () => credentialsFromConfig({ tls: true, ca: "/no/such/ca.pem" }),
      (err: unknown) => err instanceof AdapterError && err.code === "E_INVALID_CONFIG",
    );
    assert.throws(
      () =>
        credentialsFromConfig({
          cert: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
        }),
      /both cert and key/,
    );
    const tlsOnly = credentialsFromConfig({ tls: true });
    assert.ok(tlsOnly);
  });

  it("tlsWatch remounts ChannelCredentials in-process without mcp_update", async () => {
    const dir = await mkdtemp(join(tmpdir(), "e2mcp-grpc-tls-"));
    const keyPath = join(dir, "key.pem");
    const certPath = join(dir, "cert.pem");
    try {
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-keyout",
          keyPath,
          "-out",
          certPath,
          "-days",
          "1",
          "-nodes",
          "-subj",
          "/CN=127.0.0.1",
          "-addext",
          "subjectAltName=IP:127.0.0.1",
        ],
        { stdio: "pipe" },
      );
    } catch {
      await rm(dir, { recursive: true, force: true });
      if (!existsSync("/usr/bin/openssl") && !existsSync("/bin/openssl")) return;
      throw new Error("openssl failed to mint a hermetic gRPC TLS cert");
    }
    const key = await readFile(keyPath);
    const cert = await readFile(certPath);
    const def = protoLoader.loadSync(protoPath, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const pkg = grpc.loadPackageDefinition(def) as {
      helloworld: { Greeter: grpc.ServiceClientConstructor };
    };
    const tlsServer = new grpc.Server();
    tlsServer.addService(pkg.helloworld.Greeter.service, {
      getStatus: (
        call: grpc.ServerUnaryCall<{ name?: string }, { message: string }>,
        callback: grpc.sendUnaryData<{ message: string }>,
      ) => callback(null, { message: `ok ${call.request.name ?? ""}` }),
      sayHello: (
        call: grpc.ServerUnaryCall<{ name?: string }, { message: string }>,
        callback: grpc.sendUnaryData<{ message: string }>,
      ) => callback(null, { message: `hello ${call.request.name ?? ""}` }),
      streamHello: (call: grpc.ServerWritableStream<{ name?: string }, { message: string }>) => call.end(),
      collectHellos: (
        call: grpc.ServerReadableStream<{ name?: string }, { message: string }>,
        callback: grpc.sendUnaryData<{ message: string }>,
      ) => {
        call.on("end", () => callback(null, { message: "ok" }));
        call.on("error", (err: Error) => callback(err, null));
      },
      chat: (call: grpc.ServerDuplexStream<{ name?: string }, { message: string }>) => {
        call.on("end", () => call.end());
      },
    });
    const tlsPort = await new Promise<number>((resolve, reject) => {
      tlsServer.bindAsync(
        "127.0.0.1:0",
        grpc.ServerCredentials.createSsl(null, [{ private_key: key, cert_chain: cert }], false),
        (err, bound) => (err ? reject(err) : resolve(bound)),
      );
    });
    const adapter = new GrpcAdapter("tls-watch");
    try {
      await adapter.connect({
        proto: protoPath,
        target: `127.0.0.1:${tlsPort}`,
        tls: true,
        ca: certPath,
        tlsWatch: true,
        allowWrite: true,
      });
      const first = (await adapter.invoke("Greeter_SayHello", { name: "Ada" })) as { message: string };
      assert.equal(first.message, "hello Ada");
      await writeFile(certPath, cert);
      await new Promise((r) => setTimeout(r, 150));
      const health = await adapter.health();
      assert.match(health.detail ?? "", /remounts=[1-9]/);
      const second = (await adapter.invoke("Greeter_SayHello", { name: "Bob" })) as { message: string };
      assert.equal(second.message, "hello Bob");
    } finally {
      await adapter.disconnect();
      await new Promise<void>((resolve) => tlsServer.tryShutdown(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("gRPC reflection v1", () => {
  it("ships v1 then v1alpha protos with identical ServerReflectionInfo", () => {
    assert.deepEqual([...REFLECTION_VARIANTS], ["v1", "v1alpha"]);
    const v1 = reflectionProto("v1");
    const alpha = reflectionProto("v1alpha");
    assert.match(v1, /package grpc\.reflection\.v1;/);
    assert.match(alpha, /package grpc\.reflection\.v1alpha;/);
    assert.match(v1, /rpc ServerReflectionInfo/);
    assert.match(alpha, /rpc ServerReflectionInfo/);
  });
});
