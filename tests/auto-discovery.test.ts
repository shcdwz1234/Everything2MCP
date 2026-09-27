import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { AutoDiscovery, defaultDiscoveryMode, normalizeSettings } from "../src/control/auto-discovery.js";
import { createEverything2McpServer } from "../src/control/server.js";
import { handleConsoleRest } from "../src/control/rest.js";
import { expandCidr, isNeverScan, isPrivateIp, parseCidr, parseScopeEntry, subnetsFromInterfaces } from "../src/discovery/netscope.js";
import { looksLikeNetworkRange } from "../src/discovery/probe.js";
import { mdnsMulticastBrowse } from "../src/discovery/dnssd.js";
import type { ScanOptions } from "../src/discovery/scan.js";
import type { DiscoveryCandidate } from "../src/runtime/types.js";
import { startHttp } from "../src/transport/http.js";

async function tmp(): Promise<{ dataDir: string; cleanup: () => Promise<void> }> {
  const dataDir = await mkdtemp(join(tmpdir(), "e2m-s4-"));
  return { dataDir, cleanup: () => rm(dataDir, { recursive: true, force: true }) };
}

const IFACES = {
  lo: [{ family: "IPv4", address: "127.0.0.1", netmask: "255.0.0.0", internal: true }],
  eth0: [{ family: "IPv4", address: "192.168.7.20", netmask: "255.255.0.0", internal: false }],
  pub: [{ family: "IPv4", address: "8.8.4.4", netmask: "255.255.255.0", internal: false }],
  ll: [{ family: "IPv4", address: "169.254.3.4", netmask: "255.255.0.0", internal: false }],
};

function fakeScan(table: Record<string, DiscoveryCandidate[]>, seen: string[]) {
  return async (opts: ScanOptions) => {
    seen.push(opts.host);
    return table[opts.host] ?? [];
  };
}

describe("S4 netscope rules", () => {
  it("private / never-scan classification", () => {
    for (const ip of ["10.1.2.3", "172.20.0.1", "192.168.1.1", "100.64.0.9", "127.0.0.1"]) assert.equal(isPrivateIp(ip), true, ip);
    for (const ip of ["8.8.8.8", "172.32.0.1", "100.128.0.1"]) assert.equal(isPrivateIp(ip), false, ip);
    assert.equal(isNeverScan("169.254.169.254"), true);
    assert.equal(isNeverScan("169.254.10.10"), true);
    // Alibaba metadata sits inside CGNAT 100.64/10 (treated as private) — still never scanned
    assert.equal(isPrivateIp("100.100.100.200"), true);
    assert.equal(isNeverScan("100.100.100.200"), true);
    assert.equal(isNeverScan("192.168.1.1"), false);
  });

  it("interfaces: private only, clamped to /24, link-local + public + internal skipped", () => {
    const subnets = subnetsFromInterfaces(IFACES);
    assert.deepEqual(subnets.map((s) => `${s.cidr.network}/${s.cidr.prefix}`), ["192.168.7.0/24"]);
    const c = parseCidr("192.168.7.0/24")!;
    const { hosts } = expandCidr(c, 1000);
    assert.equal(hosts.length, 254);
    assert.equal(hosts[0], "192.168.7.1");
    assert.equal(expandCidr(c, 10).truncated, true);
  });

  it("manual scopes: private CIDR ok, public needs opt-in, /15 and link-local refused", () => {
    assert.equal(parseScopeEntry("10.0.5.0/24", false).kind, "cidr");
    assert.equal(parseScopeEntry("10.0.5.7", false).kind, "ip");
    assert.equal(parseScopeEntry("nas.lan", false).kind, "domain");
    assert.throws(() => parseScopeEntry("8.8.8.0/24", false), /allowPublic/);
    assert.equal(parseScopeEntry("8.8.8.0/24", true).kind, "cidr");
    assert.throws(() => parseScopeEntry("10.0.0.0/15", true), /larger than/);
    assert.throws(() => parseScopeEntry("169.254.0.0/24", true), /link-local/);
    assert.throws(() => parseScopeEntry("169.254.169.254", true), /metadata/);
    assert.throws(() => parseScopeEntry("metadata.google.internal", true), /metadata/);
  });

  it("single-host tool API unchanged: ranges still refused, legacy multicast helper still throws", () => {
    assert.equal(looksLikeNetworkRange("10.0.0.0/24"), true);
    assert.throws(() => mdnsMulticastBrowse(), /disabled/);
  });

  it("mode defaults: auto normally, off under test runner, env override, disabled → off", () => {
    assert.equal(defaultDiscoveryMode({}), "auto");
    assert.equal(defaultDiscoveryMode({ NODE_TEST_CONTEXT: "child" }), "off");
    assert.equal(defaultDiscoveryMode({ NODE_TEST_CONTEXT: "child", EVERYTHING2MCP_DISCOVERY_MODE: "manual" }), "manual");
    assert.equal(defaultDiscoveryMode({ EVERYTHING2MCP_DISCOVERY_MODE: "auto" }, false), "off");
    const n = normalizeSettings({ intervalMinutes: 1, hostCap: 99999, concurrency: 0 });
    assert.equal(n.intervalMinutes, 5);
    assert.equal(n.hostCap, 1024);
    assert.equal(n.concurrency, 1);
  });
});

describe("S4 AutoDiscovery engine", { timeout: 30_000 }, () => {
  const cleanups: Array<() => Promise<void>> = [];
  after(async () => {
    for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
  });

  async function setup(table: Record<string, DiscoveryCandidate[]>, extra: Partial<ConstructorParameters<typeof AutoDiscovery>[0]> = {}) {
    const t = await tmp();
    const app = await createEverything2McpServer({ dataDir: t.dataDir });
    cleanups.push(async () => {
      await app.close();
      await t.cleanup();
    });
    const seen: string[] = [];
    const ctx = { registry: app.registry, config: app.config, blacklist: app.blacklist, security: app.security, auditLog: app.auditLog };
    const d = new AutoDiscovery({
      ctx,
      dataDir: t.dataDir,
      env: {},
      mode: "manual",
      scanHost: fakeScan(table, seen),
      networkInterfaces: () => IFACES,
      mdnsBrowse: async () => [{ host: "192.168.9.9", via: "mdns" }, { host: "8.8.8.8", via: "mdns" }, { host: "169.254.169.254", via: "mdns" }],
      ssdpBrowse: async () => [],
      resolve: async (h) => (h === "nas.lan" ? ["192.168.50.5"] : h === "evil.example" ? ["169.254.169.254"] : ["93.184.216.34"]),
      ...extra,
    });
    await d.load();
    return { d, app, seen, dataDir: t.dataDir, ctx };
  }

  it("plans localhost + interface /24 + multicast responders + manual scopes, capped, excluded", async () => {
    const { d } = await setup({});
    await d.updateSettings({ scopes: ["10.9.0.0/30", "nas.lan", "evil.example"], exclude: ["192.168.7.0/28"], hostCap: 40 });
    const plan = await d.planHosts();
    const hosts = plan.hosts.map((h) => h.host);
    assert.equal(hosts[0], "127.0.0.1");
    assert.ok(hosts.includes("nas.lan"));
    assert.ok(hosts.includes("192.168.9.9"), "private mDNS responder");
    assert.equal(hosts.includes("8.8.8.8"), false, "public responder dropped");
    assert.equal(hosts.includes("169.254.169.254"), false, "metadata never");
    assert.ok(hosts.includes("10.9.0.1") && hosts.includes("10.9.0.2"));
    assert.equal(hosts.some((h) => /^192\.168\.7\.(\d|1[0-5])$/.test(h)), false, "exclusion honoured");
    assert.equal(hosts.includes("192.168.7.20"), false, "own address skipped");
    assert.equal(hosts.length, 40);
    assert.equal(plan.truncated, true);
    assert.ok(plan.errors.some((e) => e.includes("evil.example")));
  });

  it("run → candidates (allowWrite=false, needsConfig for postgres), blacklist filter, offline tracking, audit, persistence", async () => {
    const table: Record<string, DiscoveryCandidate[]> = {
      "127.0.0.1": [
        { protocol: "redis", url: "redis://127.0.0.1:6379", hint: "redis", status: 1, confidence: 0.9, config: { url: "redis://127.0.0.1:6379" } },
        { protocol: "postgres", url: "postgres://127.0.0.1:5432", hint: "pg", status: 1, confidence: 0.8, config: { url: "postgres://127.0.0.1:5432/postgres", allowWrite: false } },
      ],
      "192.168.7.5": [{ protocol: "mqtt", url: "mqtt://192.168.7.5:1883", hint: "mqtt", status: 1, config: { url: "mqtt://192.168.7.5:1883" } }],
    };
    const { d, app, seen, dataDir } = await setup(table);
    await d.updateSettings({ multicast: false });
    await app.blacklist.add({ protocol: "mqtt", host: "192.168.7.5", port: 1883 });
    const run = await d.run("manual");
    assert.ok(seen.includes("127.0.0.1"));
    assert.equal(run.found, 3);
    assert.equal(run.newCount, 3);
    const all = await d.listCandidates();
    const redis = all.find((c) => c.protocol === "redis")!;
    const pg = all.find((c) => c.protocol === "postgres")!;
    const mqtt = all.find((c) => c.protocol === "mqtt")!;
    assert.equal(redis.config.allowWrite, false);
    assert.equal(redis.needsConfig, false);
    assert.equal(pg.needsConfig, true);
    assert.deepEqual(pg.credentials.map((c) => c.key), ["username", "password"]);
    assert.equal(mqtt.status, "blacklisted");
    assert.equal(d.counts().discovered, 2);
    assert.equal(d.counts().ready, 1);
    assert.equal(d.counts().needsConfig, 1);

    delete table["127.0.0.1"];
    const run2 = await d.run("manual");
    assert.equal(run2.offlineCount, 2);
    const after2 = await d.listCandidates();
    assert.equal(after2.find((c) => c.protocol === "redis")!.online, false);

    const persisted = JSON.parse(await readFile(join(dataDir, "discovery.json"), "utf8")) as { runs: unknown[]; candidates: unknown[]; settings: { multicast: boolean } };
    assert.equal(persisted.runs.length, 2);
    assert.equal(persisted.candidates.length, 3);
    assert.equal(persisted.settings.multicast, false);
    const audit = app.auditLog.snapshot(50).events.filter((e) => e.kind === "discovery");
    assert.ok(audit.some((e) => e.tool === "discovery.manual"));
    assert.ok(audit.some((e) => e.tool === "discovery.settings"));
  });

  it("enable merges only prompted credentials into the URL; allowWrite forced false; off mode refuses run", async () => {
    const table: Record<string, DiscoveryCandidate[]> = {
      "127.0.0.1": [{ protocol: "s3", url: "http://127.0.0.1:9000", hint: "minio", status: 1, config: { bucket: "b", endpoint: "memory://" } }],
    };
    const { d, app } = await setup(table);
    await d.updateSettings({ multicast: false, includeInterfaces: false });
    await d.run();
    const [cand] = await d.listCandidates();
    assert.ok(cand);
    assert.equal(cand.needsConfig, true);
    const res = (await d.enable(cand.id, { credentials: { accessKey: "AK", secretKey: "SK" }, config: { allowWrite: true } as never })) as {
      registered: { id: string };
    };
    const rec = app.registry.getRecord(res.registered.id)!;
    assert.equal(rec.config.accessKey, "AK");
    assert.equal(rec.config.allowWrite, false);
    assert.ok(d.registeredIds().has(res.registered.id), "来源 = 自动发现");
    const again = await d.listCandidates();
    assert.equal(again[0]!.status, "enabled");
    await assert.rejects(() => d.enable(cand.id, {}), /Already enabled/);
    await d.updateSettings({ mode: "off" });
    await assert.rejects(() => d.run(), /off/);
  });

  it("a failed 一键启用 is kept on the candidate (lastError) and cleared on success", async () => {
    const table: Record<string, DiscoveryCandidate[]> = {
      "127.0.0.1": [{ protocol: "qdrant", url: "http://127.0.0.1:6333", hint: "", status: 1, config: { url: "http://127.0.0.1:6333" } }],
    };
    const { d } = await setup(table);
    await d.updateSettings({ multicast: false, includeInterfaces: false });
    await d.run();
    const [cand] = await d.listCandidates();
    assert.ok(cand);
    await assert.rejects(() => d.enable(cand.id, {}));
    const [after] = await d.listCandidates();
    assert.ok(after!.lastError?.code, "error code recorded");
    assert.equal(d.counts().ready, 0, "a failed candidate is not counted as 可一键启用");
    assert.equal(d.counts().failed, 1);
    assert.equal(after!.status, "new");
    const ok = (await d.enable(cand.id, { config: { simulator: true } as never })) as { ok: boolean };
    assert.equal(ok.ok, true);
    const [done] = await d.listCandidates();
    assert.equal(done!.lastError, undefined);
  });

  it("autoEnable registers only ready, readonly, non-blacklisted candidates", async () => {
    const table: Record<string, DiscoveryCandidate[]> = {
      "127.0.0.1": [
        { protocol: "s3", url: "http://127.0.0.1:9000", hint: "minio", status: 1, config: { bucket: "b", endpoint: "memory://", accessKey: "a", secretKey: "s" } },
        { protocol: "postgres", url: "postgres://127.0.0.1:5432", hint: "pg", status: 1, config: { url: "postgres://127.0.0.1:5432/postgres" } },
      ],
    };
    const { d, app } = await setup(table);
    await d.updateSettings({ multicast: false, includeInterfaces: false, autoEnable: true });
    const run = await d.run();
    assert.equal(run.autoEnabled.length, 1);
    assert.ok(run.autoEnabled[0]!.startsWith("s3:"));
    assert.equal(app.registry.list().adapters.length, 1);
  });

  it("scheduler: auto mode schedules, stop() clears; server defaults to off under the test runner", async () => {
    const { d, app } = await setup({});
    assert.equal(app.discovery.getSettings().mode, "off");
    await d.updateSettings({ mode: "auto", intervalMinutes: 5 });
    await d.start();
    assert.ok(d.status().nextRunAt);
    d.stop();
    assert.equal(d.status().nextRunAt, undefined);
  });
});

describe("S4 REST discovery + overview + activity + enable toggle", { timeout: 30_000 }, () => {
  it("settings round-trip, validation, candidates, overview counts, toggle", async () => {
    const t = await tmp();
    const app = await startHttp({ dataDir: t.dataDir, transport: { kind: "http", port: 0, host: "127.0.0.1" } });
    try {
      const base = app.http.url;
      const j = async (path: string, init?: RequestInit) => {
        const r = await fetch(`${base}${path}`, init);
        return { status: r.status, body: (await r.json()) as Record<string, any> };
      };
      const put = (path: string, body: unknown, method = "PUT") =>
        j(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

      const s0 = await j("/api/discovery/settings");
      assert.equal(s0.status, 200);
      assert.equal(s0.body.settings.mode, "off");
      assert.ok(Array.isArray(s0.body.scope.privateRanges));

      const bad = await put("/api/discovery/settings", { scopes: ["8.8.8.0/24"] });
      assert.equal(bad.status, 403);
      const ok = await put("/api/discovery/settings", { mode: "manual", scopes: ["10.1.0.0/30"], multicast: false, includeInterfaces: false, includeLocalhost: false });
      assert.equal(ok.status, 200);
      assert.deepEqual(ok.body.settings.scopes, ["10.1.0.0/30"]);

      // swap in a fake scanner so the REST run does not touch the network
      (app.discovery as unknown as { deps: { scanHost: unknown } }).deps.scanHost = async (o: ScanOptions) =>
        o.host === "10.1.0.1" ? [{ protocol: "redis", url: "redis://10.1.0.1:6379", hint: "", status: 1, config: { url: "redis://10.1.0.1:6379" } }] : [];
      const run = await put("/api/discovery/run", {}, "POST");
      assert.equal(run.status, 200);
      assert.equal(run.body.run.found, 1);
      const cands = await j("/api/discovery/candidates");
      assert.equal(cands.body.candidates.length, 1);
      const runs = await j("/api/discovery/runs");
      assert.equal(runs.body.runs.length, 1);

      await put("/api/adapters", { protocol: "postgres", name: "mem", config: { simulator: true } }, "POST");
      await put("/api/blacklist", { kind: "tool", pattern: "postgres.*.execute" }, "POST");
      const listed = await j("/api/adapters");
      const mem = listed.body.adapters.find((x: { id: string }) => x.id === "postgres:mem");
      assert.equal(mem.source, "manual");
      assert.equal(mem.address, undefined, "file / memory specs have no network address");
      const ov = await j("/api/overview");
      assert.equal(ov.body.current.total, 1);
      assert.equal(ov.body.current.enabled, 1);
      assert.equal(ov.body.supported.discovered, 1);
      assert.ok(ov.body.supported.types > 50);
      assert.equal(ov.body.blacklist.total, 1);
      assert.equal(ov.body.blacklist.tool, 1);

      const off = await put(`/api/adapters/${encodeURIComponent("postgres:mem")}/enabled`, { enabled: false }, "POST");
      assert.equal(off.status, 200);
      assert.equal(off.body.adapter.status, "disabled");
      const tools = await j("/api/tools");
      assert.equal(tools.body.tools.some((x: { name: string }) => x.name.startsWith("postgres.mem.")), false);
      const ov2 = await j("/api/overview");
      assert.equal(ov2.body.current.enabled, 0);
      assert.equal(ov2.body.current.total, 1);
      assert.equal(ov2.body.current.disabled, 1);
      assert.equal(ov2.body.current.failing, 0);
      const on = await put(`/api/adapters/${encodeURIComponent("postgres:mem")}/enabled`, { enabled: true }, "POST");
      assert.equal(on.body.adapter.status, "live");

      const act = await j("/api/activity");
      assert.equal(act.status, 200);
      assert.ok(act.body.items.some((i: { type: string }) => i.type === "discovery_run"));
      assert.ok(act.body.items.some((i: { tool?: string }) => i.tool === "capability.disable"));
      // console-initiated changes are audited (ids only), and the startup/manual run is not listed twice
      assert.ok(act.body.items.some((i: { tool?: string }) => i.tool === "capability.add"));
      assert.ok(act.body.items.some((i: { tool?: string; detail?: string }) => i.tool === "blacklist.add" && i.detail === "tool|postgres.*.execute"));
      assert.equal(act.body.items.filter((i: { tool?: string }) => i.tool === "discovery.manual").length, 1);
    } finally {
      await app.close();
      await rm(t.dataDir, { recursive: true, force: true });
    }
  });

  it("disabled registration survives restart without mounting", async () => {
    const t = await tmp();
    const ctxApp = await createEverything2McpServer({ dataDir: t.dataDir });
    const r = (b: unknown, path: string, method = "POST") =>
      handleConsoleRest(ctxApp, { method, pathname: path, query: new URLSearchParams(), body: b });
    await r({ protocol: "postgres", name: "mem", config: { simulator: true } }, "/api/adapters");
    await r({ enabled: false }, "/api/adapters/postgres:mem/enabled");
    await ctxApp.close();
    const again = await createEverything2McpServer({ dataDir: t.dataDir });
    try {
      const a = again.registry.list().adapters.find((x) => x.id === "postgres:mem");
      assert.equal(a?.status, "disabled");
      assert.equal(again.registry.list().tools.length, 0);
    } finally {
      await again.close();
      await rm(t.dataDir, { recursive: true, force: true });
    }
  });
});
