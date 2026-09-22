import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectEnvironmentInventory, parseProcAddr, parseProcNet } from "../src/discovery/environment.js";
import { suggestFromEnvironment } from "../src/discovery/environment-suggest.js";

describe("Phase V2 environment inventory", () => {
  it("parses Linux /proc/net listen rows", () => {
    const raw = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1
   1: 00000000:0050 00000000:0000 01 00000000:00000000 00:00000000 00000000     0        0 2
`;
    const ports = parseProcNet(raw, "tcp");
    assert.equal(ports.length, 1);
    assert.equal(ports[0]?.port, 8080);
    assert.equal(ports[0]?.localAddress, "127.0.0.1");
    assert.equal(parseProcAddr("0100007F:1F90")?.address, "127.0.0.1");
  });

  it("collects a fixture inventory without auto-opening write", async () => {
    const inv = await collectEnvironmentInventory({
      platform: "linux",
      arch: "x64",
      env: { PATH: "/usr/bin:/opt/bin", KUBERNETES_SERVICE_HOST: "" },
      pathList: ["/usr/bin"],
      fs: {
        exists: (p) => p === "/usr/bin/node" || p === "/etc/os-release" || p === "/.dockerenv",
        readFile: (p) => {
          if (p === "/etc/os-release") return 'PRETTY_NAME="Fixture Linux"\nID=fixture\n';
          if (p === "/proc/net/tcp") {
            return `sl local_address rem_address st\n 0: 0100007F:18EB 00000000:0000 0A\n`;
          }
          return undefined;
        },
      },
      now: () => new Date("2026-09-22T00:00:00.000Z"),
    });
    assert.equal(inv.policy.allowWriteDefault, false);
    assert.equal(inv.policy.neverAutoOpenWrite, true);
    assert.equal(inv.policy.neverAutoOpenDesktop, true);
    assert.equal(inv.os.distro, "Fixture Linux");
    assert.equal(inv.os.platform, "linux");
    assert.equal(inv.container.inContainer, true);
    assert.ok(inv.runtimes.some((r) => r.id === "node" && r.present));
    assert.ok(inv.listeningPorts.some((p) => p.port === 6379));

    const suggestions = suggestFromEnvironment(inv);
    assert.ok(suggestions.every((s) => s.config.allowWrite !== true));
    assert.ok(suggestions.every((s) => s.config.allowShell !== true));
    assert.ok(suggestions.every((s) => s.config.allowDesktop !== true));
    assert.ok(suggestions.every((s) => s.config.allowReadSecrets !== true));
    assert.ok(suggestions.some((s) => s.protocol === "os_info"));
    assert.ok(suggestions.some((s) => s.protocol === "platform_fs"));
    assert.ok(suggestions.some((s) => s.protocol === "redis"));
  });

  it("cloud clues never copy secrets or query IMDS", async () => {
    const inv = await collectEnvironmentInventory({
      platform: "linux",
      env: {
        PATH: "/usr/bin",
        AWS_REGION: "us-east-1",
        AWS_SECRET_ACCESS_KEY: "super-secret-value",
        VAULT_ADDR: "http://127.0.0.1:8200",
        VAULT_TOKEN: "s.xxxxxxxx",
      },
      pathList: ["/usr/bin"],
      fs: {
        exists: (p) => p === "/usr/bin/vault",
        readFile: () => undefined,
      },
    });
    assert.ok(inv.cloud.providers.includes("aws"));
    assert.ok(inv.cloud.providers.includes("vault"));
    assert.ok(inv.cloud.tokenEnvPresent.includes("AWS_SECRET_ACCESS_KEY"));
    assert.ok(inv.gaps.some((g) => /IMDS/i.test(g)));
    const blob = JSON.stringify(inv.cloud.endpoints) + JSON.stringify(suggestFromEnvironment(inv));
    assert.equal(blob.includes("super-secret-value"), false);
    assert.equal(blob.includes("s.xxxxxxxx"), false);
    const suggestions = suggestFromEnvironment(inv);
    assert.ok(suggestions.some((s) => s.protocol === "vault"));
    assert.ok(suggestions.some((s) => s.protocol === "aws_iam"));
    assert.ok(suggestions.every((s) => s.config.allowReadSecrets !== true));
  });

  it("labels win32 listening-port gap instead of faking netstat", async () => {
    const inv = await collectEnvironmentInventory({
      platform: "win32",
      fs: { exists: () => false, readFile: () => undefined },
      pathList: [],
    });
    assert.deepEqual(inv.listeningPorts, []);
    assert.ok(inv.gaps.some((g) => /win32 listening/i.test(g)));
  });
});
