import type { JsonObject } from "../runtime/types.js";
import type { EnvironmentInventory } from "./environment.js";

export interface EnvironmentSuggestion {
  protocol: string;
  name: string;
  config: JsonObject;
  confidence: number;
  reason: string;
  source: "environment";
}

function locked(config: JsonObject): JsonObject {
  return {
    ...config,
    allowWrite: false,
    allowShell: false,
    allowDesktop: false,
    allowReadSecrets: false,
  };
}

/** Map inventory → capability suggestions. Write/shell/desktop/secrets never opened. */
export function suggestFromEnvironment(inv: EnvironmentInventory): EnvironmentSuggestion[] {
  const out: EnvironmentSuggestion[] = [];
  const plat = inv.os.platform;
  const seen = new Set<string>();

  const push = (s: Omit<EnvironmentSuggestion, "config" | "source"> & { config: JsonObject }) => {
    const key = `${s.protocol}:${s.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...s, source: "environment", config: locked(s.config) });
  };

  push({
    protocol: "os_info",
    name: "local",
    config: {},
    confidence: 0.95,
    reason: `Local OS ${plat}/${inv.os.arch} ${inv.os.distro ?? ""}`.trim(),
  });
  push({
    protocol: "platform_fs",
    name: "local",
    config: { roots: defaultFsRoots(plat) },
    confidence: 0.85,
    reason: "Gated filesystem list/read (roots only; never / ).",
  });
  push({
    protocol: "platform_process",
    name: "local",
    config: {},
    confidence: 0.8,
    reason: "Process list via OS driver; shell_exec stays gated.",
  });
  push({
    protocol: "platform_service",
    name: "local",
    config: {},
    confidence: plat === "linux" || plat === "win32" ? 0.7 : 0.4,
    reason: plat === "darwin" ? "macOS launchctl is best-effort." : "Service list (systemd / sc.exe).",
  });

  {
    const present = (inv.browsers ?? []).filter((b) => b.present);
    push({
      protocol: "browser",
      name: "local",
      config: {},
      confidence: present.length ? 0.75 : 0.45,
      reason: present.length
        ? `Detected ${present.map((b) => b.id).join(", ")} (allowDesktop stays false until explicit).`
        : "Browser capability available (stub; allowDesktop default false, never auto-granted).",
    });
  }

  if (inv.container.dockerSock || inv.runtimes.some((r) => r.id === "docker" && r.present)) {
    push({
      protocol: "docker",
      name: "local",
      config: inv.container.dockerSock ? { socket: "/var/run/docker.sock" } : {},
      confidence: inv.container.dockerSock ? 0.85 : 0.5,
      reason: inv.container.dockerSock ? "docker.sock present" : "docker binary on PATH",
    });
  }
  if (inv.container.podmanSock || inv.runtimes.some((r) => r.id === "podman" && r.present)) {
    push({
      protocol: "podman",
      name: "local",
      config: inv.container.podmanSock ? { socket: "/run/podman/podman.sock" } : {},
      confidence: inv.container.podmanSock ? 0.8 : 0.45,
      reason: inv.container.podmanSock ? "podman.sock present" : "podman binary on PATH",
    });
  }

  const hasLogFile = inv.configPaths.some((p) => (p.kind === "syslog" || p.kind === "messages") && p.exists);
  if (hasLogFile || plat === "linux" || plat === "win32") {
    push({
      protocol: "journal",
      name: "local",
      config: { simulator: !hasLogFile },
      confidence: hasLogFile ? 0.7 : 0.45,
      reason: hasLogFile
        ? "syslog file present"
        : plat === "win32"
          ? "Event Log: suggest simulator or XML export path"
          : "no syslog; simulator stub",
    });
  }

  if (inv.container.kubernetes || inv.configPaths.some((p) => p.kind === "kubeconfig" && p.exists) || inv.runtimes.some((r) => r.id === "kubectl" && r.present)) {
    push({
      protocol: "kubernetes",
      name: "local",
      config: { simulator: !inv.container.kubernetes, namespace: "default" },
      confidence: inv.container.kubernetes ? 0.8 : 0.5,
      reason: inv.container.kubernetes ? "in-cluster service account clue" : "kubeconfig or kubectl present",
    });
  }

  if (inv.configPaths.some((p) => p.kind === "nfs-exports" && p.exists) || inv.runtimes.some((r) => r.id === "mount.nfs" && r.present)) {
    push({
      protocol: "nfs",
      name: "local",
      config: { simulator: true },
      confidence: 0.4,
      reason: "NFS exports/mount clue; live SHOWMOUNT not auto-enabled",
    });
  }

  if (inv.runtimes.some((r) => r.id === "smbclient" && r.present)) {
    push({
      protocol: "smb",
      name: "local",
      config: { simulator: true },
      confidence: 0.4,
      reason: "smbclient on PATH; live file ops stay E_UNSUPPORTED",
    });
  }

  if (inv.cloud.providers.includes("vault") || inv.runtimes.some((r) => r.id === "vault" && r.present)) {
    const ep = inv.cloud.endpoints.find((e) => e.kind === "vault");
    push({
      protocol: "vault",
      name: "local",
      config: ep ? { url: ep.url } : { simulator: true },
      confidence: ep ? 0.75 : 0.45,
      reason: ep ? "VAULT_ADDR host only (no token in suggest)" : "vault binary; simulator until address confirmed",
    });
  }

  if (inv.cloud.providers.includes("aws")) {
    push({
      protocol: "aws_iam",
      name: "local",
      config: { simulator: true },
      confidence: 0.55,
      reason: "AWS region/config clue. IMDS is not queried; secrets are not copied.",
    });
  }

  const portHits: Array<{ port: number; protocol: string; name: string; extra?: JsonObject }> = [
    { port: 6379, protocol: "redis", name: "local" },
    { port: 5432, protocol: "postgres", name: "local" },
    { port: 3306, protocol: "mysql", name: "local" },
    { port: 27017, protocol: "mongodb", name: "local" },
    { port: 2379, protocol: "etcd", name: "local" },
    { port: 2375, protocol: "docker", name: "tcp", extra: { url: "http://127.0.0.1:2375" } },
    { port: 2376, protocol: "docker", name: "tls", extra: { url: "https://127.0.0.1:2376" } },
    { port: 445, protocol: "smb", name: "tcp", extra: { host: "127.0.0.1", port: 445 } },
    { port: 2049, protocol: "nfs", name: "tcp", extra: { host: "127.0.0.1", port: 2049 } },
    { port: 8200, protocol: "vault", name: "tcp", extra: { url: "http://127.0.0.1:8200" } },
    { port: 9093, protocol: "alertmanager", name: "local", extra: { url: "http://127.0.0.1:9093" } },
    { port: 9090, protocol: "prometheus", name: "local", extra: { url: "http://127.0.0.1:9090" } },
    { port: 9200, protocol: "opensearch", name: "local", extra: { url: "http://127.0.0.1:9200" } },
    { port: 8085, protocol: "pubsub", name: "emulator", extra: { url: "http://127.0.0.1:8085", project: "demo" } },
    { port: 6443, protocol: "kubernetes", name: "api", extra: { url: "http://127.0.0.1:6443", namespace: "default" } },
    { port: 9092, protocol: "kafka", name: "local", extra: { brokers: ["127.0.0.1:9092"] } },
  ];
  for (const hit of portHits) {
    if (!inv.listeningPorts.some((p) => p.port === hit.port)) continue;
    push({
      protocol: hit.protocol,
      name: hit.name,
      config: { host: "127.0.0.1", port: hit.port, ...(hit.extra ?? {}) },
      confidence: 0.55,
      reason: `Listening TCP ${hit.port} (inventory; still readonly suggest).`,
    });
  }

  return out;
}

function defaultFsRoots(plat: string): string[] {
  if (plat === "win32") return ["C:\\Windows\\System32\\drivers\\etc"];
  if (plat === "darwin") return ["/etc", "/usr/share", "/var/log"];
  return ["/etc", "/usr/share", "/var/log", "/proc"];
}
