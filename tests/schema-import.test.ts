import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { registerBuiltinAdapters } from "../src/adapters/index.js";
import { ToolRegistry } from "../src/catalog/registry.js";
import { JsonStore } from "../src/catalog/store.js";
import { importSchema, detectKind, IMPORT_FIRST_KINDS, baseUrlFromOpenApi } from "../src/discovery/import.js";
import { planBridge } from "../src/discovery/plan.js";
import { AdapterError } from "../src/runtime/errors.js";

const specPath = fileURLToPath(new URL("../examples/petstore.openapi.json", import.meta.url));
const wsdlPath = fileURLToPath(new URL("../examples/calculator.wsdl", import.meta.url));
const protoPath = fileURLToPath(new URL("../examples/greeter.proto", import.meta.url));
const asyncPath = fileURLToPath(new URL("../examples/streetlights.asyncapi.json", import.meta.url));

describe("schema_import + plan", () => {
  let dataDir: string;
  let registry: ToolRegistry;

  before(async () => {
    registerBuiltinAdapters();
    dataDir = await mkdtemp(join(tmpdir(), "e2mcp-imp-"));
    registry = new ToolRegistry(new JsonStore(dataDir));
  });

  after(async () => {
    await registry.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("detects kinds", () => {
    assert.equal(detectKind('{"openapi":"3.0.0"}'), "openapi");
    assert.equal(detectKind("<definitions></definitions>"), "wsdl");
    assert.equal(detectKind('syntax = "proto3"; service X {}'), "proto");
    assert.equal(detectKind("type Query { hello: String }"), "graphql");
    assert.equal(detectKind('{"asyncapi":"2.6.0"}'), "asyncapi");
    assert.equal(detectKind('{"jsonapi":{"version":"1.0"},"data":[]}'), "jsonapi");
    assert.equal(
      detectKind('<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0"></edmx:Edmx>'),
      "odata",
    );
    assert.equal(detectKind('{"trpc":{"version":"11"},"procedures":{"hello":{"type":"query"}}}'), "trpc");
    assert.equal(
      detectKind('syntax = "proto3";\noption (connectrpc.v1.service) = {};\nservice Greeter {}'),
      "connectrpc",
    );
    assert.equal(detectKind('{"openapi":"3.1.0","info":{"title":"x"}}'), "openapi");
    assert.deepEqual([...IMPORT_FIRST_KINDS].sort(), ["connectrpc", "jsonapi", "odata", "trpc"]);
  });

  it("rejects empty, unparseable, and unknown schema documents", async () => {
    const empty = join(dataDir, "empty.json");
    await writeFile(empty, "   \n");
    await assert.rejects(
      () => importSchema(empty),
      (err: unknown) => err instanceof AdapterError && err.code === "E_INVALID_CONFIG",
    );
    const junk = join(dataDir, "junk.json");
    await writeFile(junk, "{ not json");
    await assert.rejects(
      () => importSchema(junk, "openapi"),
      (err: unknown) => err instanceof AdapterError && /parse/i.test((err as Error).message),
    );
    const unknown = join(dataDir, "unknown.json");
    await writeFile(unknown, '{"hello":true}');
    await assert.rejects(
      () => importSchema(unknown),
      (err: unknown) => err instanceof AdapterError && /detect schema kind/i.test((err as Error).message),
    );
  });

  it("imports OpenAPI and AsyncAPI files", async () => {
    const oas = await importSchema(specPath);
    assert.equal(oas.protocol, "openapi");
    assert.equal(oas.registerable, true);
    assert.equal(oas.config.baseUrl, "http://127.0.0.1:9");
    const asyncapi = await importSchema(asyncPath);
    assert.equal(asyncapi.protocol, "asyncapi");
    const wsdl = await importSchema(wsdlPath);
    assert.equal(wsdl.protocol, "soap");
    const proto = await importSchema(protoPath);
    assert.equal(proto.protocol, "grpc");
    assert.equal(proto.registerable, false);
  });

  it("reverses OpenAPI servers[] including variable defaults", () => {
    const base = baseUrlFromOpenApi(
      {
        servers: [
          {
            url: "http://{host}:{port}/v1",
            variables: { host: { default: "api.local" }, port: { default: "8443" } },
          },
        ],
      },
      "./spec.json",
    );
    assert.equal(base, "http://api.local:8443/v1");
    assert.equal(baseUrlFromOpenApi({ servers: [] }, "./spec.json"), undefined);
  });

  it("treats JSON:API / OData / tRPC / Connect-RPC as import-first (not registerable)", async () => {
    const jsonapi = join(dataDir, "doc.jsonapi.json");
    await writeFile(jsonapi, JSON.stringify({ jsonapi: { version: "1.0" }, data: [] }));
    const ja = await importSchema(jsonapi);
    assert.equal(ja.kind, "jsonapi");
    assert.equal(ja.registerable, false);
    assert.match(ja.note ?? "", /OpenAPI/);

    const odata = join(dataDir, "metadata.xml");
    await writeFile(
      odata,
      '<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0"><edmx:DataServices/></edmx:Edmx>',
    );
    const od = await importSchema(odata);
    assert.equal(od.kind, "odata");
    assert.equal(od.registerable, false);

    const trpc = join(dataDir, "router.trpc.json");
    await writeFile(trpc, JSON.stringify({ trpc: { version: "11" }, procedures: { hello: { type: "query" } } }));
    const tr = await importSchema(trpc);
    assert.equal(tr.kind, "trpc");
    assert.equal(tr.registerable, false);

    const connect = join(dataDir, "greet.connect.proto");
    await writeFile(
      connect,
      'syntax = "proto3";\npackage greet.v1;\noption (connectrpc.v1.service) = {};\nservice GreetService {}\n',
    );
    const cr = await importSchema(connect);
    assert.equal(cr.kind, "connectrpc");
    assert.equal(cr.protocol, "grpc");
    assert.equal(cr.registerable, false);
    assert.match(cr.note ?? "", /OpenAPI|target/);
  });

  it("registers an imported OpenAPI spec on the catalog", async () => {
    const imported = await importSchema(specPath);
    const inst = await registry.add(imported.protocol, "widgets", { ...imported.config, baseUrl: "http://127.0.0.1:9" });
    assert.ok(inst.tools.some((t) => t.name.endsWith("listWidgets")));
    await registry.remove(inst.record.id);
  });

  it("plans a bridge from a natural-language goal", () => {
    const plan = planBridge("Connect the MQTT broker on host 10.1.2.3 and also the GraphQL API");
    const protocols = plan.recommendations.map((r) => r.protocol);
    assert.ok(protocols.includes("mqtt"));
    assert.ok(protocols.includes("graphql"));
    assert.equal(plan.host, "10.1.2.3");
    assert.ok(plan.steps.some((s) => s.tool === "discovery_scan_host"));
  });

  it("plans SQS as a cloud-queue and notes import-first RPC in odata/trpc goals", () => {
    const sqs = planBridge("Wire the amazon SQS queue on host 10.9.8.7");
    assert.ok(sqs.recommendations.some((r) => r.protocol === "sqs"));
    const rec = sqs.recommendations.find((r) => r.protocol === "sqs");
    assert.equal((rec?.exampleConfig as { allowWrite?: boolean }).allowWrite, false);
    const pulsar = planBridge("Wire Apache Pulsar on host 10.9.8.7");
    assert.ok(pulsar.recommendations.some((r) => r.protocol === "pulsar"));
    const prec = pulsar.recommendations.find((r) => r.protocol === "pulsar");
    assert.equal((prec?.exampleConfig as { allowWrite?: boolean }).allowWrite, false);
    const gcs = planBridge("Wire GCS fake-gcs on host 10.9.8.7");
    assert.ok(gcs.recommendations.some((r) => r.protocol === "gcs"));
    const oss = planBridge("Connect the aliyun OSS bucket on host 10.9.8.7");
    assert.ok(oss.recommendations.some((r) => r.protocol === "oss"));
    const influx = planBridge("Query InfluxDB on host 10.9.8.7");
    assert.ok(influx.recommendations.some((r) => r.protocol === "influx"));
    assert.equal((influx.recommendations.find((r) => r.protocol === "influx")?.exampleConfig as { allowWrite?: boolean }).allowWrite, false);
    const snmp = planBridge("Read SNMP sysDescr on host 10.9.8.7");
    assert.ok(snmp.recommendations.some((r) => r.protocol === "snmp"));
    assert.equal((snmp.recommendations.find((r) => r.protocol === "snmp")?.exampleConfig as { allowWrite?: boolean }).allowWrite, false);
    const ftp = planBridge("List files on the FTP server host 10.9.8.7");
    assert.ok(ftp.recommendations.some((r) => r.protocol === "ftp"));
    const dav = planBridge("PROPFIND the WebDAV share on host 10.9.8.7");
    assert.ok(dav.recommendations.some((r) => r.protocol === "webdav"));
    const etcd = planBridge("Read etcd keys on host 10.9.8.7");
    assert.ok(etcd.recommendations.some((r) => r.protocol === "etcd"));
    const imap = planBridge("Read IMAP INBOX on host 10.9.8.7");
    assert.ok(imap.recommendations.some((r) => r.protocol === "imap"));
    assert.equal((imap.recommendations.find((r) => r.protocol === "imap")?.exampleConfig as { allowWrite?: boolean }).allowWrite, false);
    const pop3 = planBridge("Fetch POP3 mail on host 10.9.8.7");
    assert.ok(pop3.recommendations.some((r) => r.protocol === "pop3"));
    const consul = planBridge("Read Consul KV on host 10.9.8.7");
    assert.ok(consul.recommendations.some((r) => r.protocol === "consul"));
    const azure = planBridge("List Azure Blob container on host 10.9.8.7");
    assert.ok(azure.recommendations.some((r) => r.protocol === "azureblob"));
    assert.equal((azure.recommendations.find((r) => r.protocol === "azureblob")?.exampleConfig as { allowWrite?: boolean }).allowWrite, false);
    const sftp = planBridge("Read files over SFTP on host 10.9.8.7");
    assert.ok(sftp.recommendations.some((r) => r.protocol === "sftp"));
    assert.equal((sftp.recommendations.find((r) => r.protocol === "sftp")?.exampleConfig as { allowWrite?: boolean }).allowWrite, false);
    const memcached = planBridge("Get a memcached key on host 10.9.8.7");
    assert.ok(memcached.recommendations.some((r) => r.protocol === "memcached"));
    const tftp = planBridge("TFTP get readme on host 10.9.8.7");
    assert.ok(tftp.recommendations.some((r) => r.protocol === "tftp"));
    const caldav = planBridge("CalDAV calendar-query on host 10.9.8.7");
    assert.ok(caldav.recommendations.some((r) => r.protocol === "caldav"));
    assert.equal((caldav.recommendations.find((r) => r.protocol === "caldav")?.exampleConfig as { allowWrite?: boolean }).allowWrite, false);
    const carddav = planBridge("CardDAV addressbook on host 10.9.8.7");
    assert.ok(carddav.recommendations.some((r) => r.protocol === "carddav"));
    const beanstalkd = planBridge("Put a beanstalkd job on host 10.9.8.7");
    assert.ok(beanstalkd.recommendations.some((r) => r.protocol === "beanstalkd"));
    const zk = planBridge("Read ZooKeeper znode on host 10.9.8.7");
    assert.ok(zk.recommendations.some((r) => r.protocol === "zookeeper"));
    const nats = planBridge("NATS JetStream on host 10.9.8.7");
    assert.ok(nats.recommendations.some((r) => r.protocol === "nats"));
    assert.equal(
      (nats.recommendations.find((r) => r.protocol === "nats")?.exampleConfig as { allowWrite?: boolean }).allowWrite,
      false,
    );
    const dns = planBridge("DNS name server on host 10.9.8.7");
    assert.ok(dns.recommendations.some((r) => r.protocol === "dns"));
    const cassandra = planBridge("Cassandra CQL on host 10.9.8.7");
    assert.ok(cassandra.recommendations.some((r) => r.protocol === "cassandra"));
    assert.equal(
      (cassandra.recommendations.find((r) => r.protocol === "cassandra")?.exampleConfig as { allowWrite?: boolean })
        .allowWrite,
      false,
    );
    const couch = planBridge("CouchDB on host 10.9.8.7");
    assert.ok(couch.recommendations.some((r) => r.protocol === "couchdb"));
    const whois = planBridge("WHOIS lookup on host 10.9.8.7");
    assert.ok(whois.recommendations.some((r) => r.protocol === "whois"));
    const solr = planBridge("Solr select on host 10.9.8.7");
    assert.ok(solr.recommendations.some((r) => r.protocol === "solr"));
    const rmq = planBridge("RabbitMQ management HTTP on host 10.9.8.7");
    assert.ok(rmq.recommendations.some((r) => r.protocol === "rabbitmq"));
    const k8s = planBridge("Kubernetes k8s API on host 10.9.8.7");
    assert.ok(k8s.recommendations.some((r) => r.protocol === "kubernetes"));
    const prom = planBridge("Query Prometheus PromQL remote_write on host 10.9.8.7");
    assert.ok(prom.recommendations.some((r) => r.protocol === "prometheus"));
    assert.equal(
      (prom.recommendations.find((r) => r.protocol === "prometheus")?.exampleConfig as { allowWrite?: boolean })
        .allowWrite,
      false,
    );
  });
});
