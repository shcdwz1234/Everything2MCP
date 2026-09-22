import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname, release, type, userInfo } from "node:os";
import { delimiter, join } from "node:path";
import { env as processEnv, platform, arch, versions } from "node:process";

/**
 * Environment Plane — on-demand inventory. Not a deploy/boot hook.
 * Output feeds suggest only; never opens write.
 */

export interface ListeningPort {
  port: number;
  proto: "tcp" | "udp";
  localAddress: string;
  state: string;
  gap?: string;
}

export interface RuntimeClue {
  id: string;
  present: boolean;
  path?: string;
  version?: string;
}

export interface ConfigPathClue {
  path: string;
  exists: boolean;
  kind: string;
}

export interface EnvironmentInventory {
  collectedAt: string;
  os: {
    platform: string;
    arch: string;
    type: string;
    release: string;
    hostname: string;
    distro?: string;
    node: string;
  };
  permissions: {
    uid?: number;
    gid?: number;
    username?: string;
    homedir?: string;
    isElevatedHint: boolean;
    hints: string[];
  };
  listeningPorts: ListeningPort[];
  runtimes: RuntimeClue[];
  container: {
    inContainer: boolean;
    kubernetes: boolean;
    dockerSock: boolean;
    podmanSock: boolean;
    clues: string[];
  };
  configPaths: ConfigPathClue[];
  /** Cloud/IAM clues. Existence only — never secret values or IMDS payloads. */
  cloud: {
    providers: Array<"aws" | "gcp" | "azure" | "vault">;
    clues: string[];
    endpoints: Array<{ kind: string; url: string }>;
    tokenEnvPresent: string[];
  };
  /** Honest platform gaps (APIs we did not fake). */
  gaps: string[];
  policy: { allowWriteDefault: false; neverAutoOpenWrite: true; neverAutoOpenDesktop: true };
}

export interface InventoryFs {
  exists(path: string): boolean;
  readFile(path: string): string | undefined;
}

export interface InventoryOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  fs?: InventoryFs;
  pathList?: string[];
  now?: () => Date;
}

const defaultFs: InventoryFs = {
  exists: (p) => {
    try {
      return existsSync(p);
    } catch {
      return false;
    }
  },
  readFile: (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return undefined;
    }
  },
};

export async function collectEnvironmentInventory(opts: InventoryOptions = {}): Promise<EnvironmentInventory> {
  const plat = opts.platform ?? platform;
  const cpu = opts.arch ?? arch;
  const env = opts.env ?? processEnv;
  const fs = opts.fs ?? defaultFs;
  const pathList = opts.pathList ?? (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  const gaps: string[] = [];

  const distro = readDistro(plat, fs);
  let user: { uid?: number; gid?: number; username?: string; homedir?: string } = {};
  try {
    const u = userInfo();
    user = { uid: u.uid, gid: u.gid, username: u.username, homedir: u.homedir };
  } catch {
    user = { homedir: homedir() };
    gaps.push("userInfo() unavailable");
  }

  const ports = readListeningPorts(plat, fs, gaps);
  const runtimes = detectRuntimes(pathList, fs);
  const container = detectContainer(plat, fs, env);
  const configPaths = collectConfigPaths(plat, fs, user.homedir ?? homedir());
  const cloud = detectCloud(fs, env, user.homedir ?? homedir(), gaps);

  const isElevatedHint =
    (typeof user.uid === "number" && user.uid === 0) ||
    String(env.USERNAME ?? env.USER ?? "").toLowerCase() === "administrator";

  const hints = [
    "Inventory never auto-registers adapters and never sets allowWrite=true.",
    isElevatedHint ? "Process looks elevated; still default readonly hot-add." : "Unprivileged process; fs/process tools stay gated.",
  ];

  if (plat !== "linux" && plat !== "win32") {
    gaps.push(`listening-ports: ${plat} uses a best-effort path; linux /proc/net is the only hermetic parser`);
  }
  if (plat === "win32") {
    gaps.push("win32 listening ports: /proc/net is absent; netstat spawn is not used (no fake list)");
  }

  return {
    collectedAt: (opts.now ?? (() => new Date()))().toISOString(),
    os: {
      platform: plat,
      arch: cpu,
      type: type(),
      release: release(),
      hostname: hostname(),
      distro,
      node: versions.node,
    },
    permissions: {
      ...user,
      isElevatedHint,
      hints,
    },
    listeningPorts: ports,
    runtimes,
    container,
    configPaths,
    cloud,
    gaps,
    policy: { allowWriteDefault: false, neverAutoOpenWrite: true, neverAutoOpenDesktop: true },
  };
}

function readDistro(plat: NodeJS.Platform, fs: InventoryFs): string | undefined {
  if (plat === "linux") {
    const raw = fs.readFile("/etc/os-release") ?? fs.readFile("/usr/lib/os-release");
    if (!raw) return undefined;
    const pretty = raw.match(/^PRETTY_NAME=(.*)$/m)?.[1];
    const id = raw.match(/^ID=(.*)$/m)?.[1];
    const pick = pretty ?? id;
    return pick?.replaceAll('"', "").trim();
  }
  if (plat === "win32") return "Windows";
  if (plat === "darwin") return "macOS";
  return undefined;
}

function readListeningPorts(plat: NodeJS.Platform, fs: InventoryFs, gaps: string[]): ListeningPort[] {
  if (plat !== "linux") return [];
  const out: ListeningPort[] = [];
  for (const [file, proto] of [
    ["/proc/net/tcp", "tcp"],
    ["/proc/net/tcp6", "tcp"],
    ["/proc/net/udp", "udp"],
    ["/proc/net/udp6", "udp"],
  ] as const) {
    const raw = fs.readFile(file);
    if (!raw) {
      gaps.push(`missing ${file}`);
      continue;
    }
    out.push(...parseProcNet(raw, proto));
  }
  return out;
}

/** Parse Linux /proc/net/{tcp,udp} listen (st=0A) rows. IPv4 addresses are little-endian hex. */
export function parseProcNet(raw: string, proto: "tcp" | "udp"): ListeningPort[] {
  const lines = raw.split(/\r?\n/).slice(1);
  const ports: ListeningPort[] = [];
  for (const line of lines) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const local = cols[1] ?? "";
    const st = (cols[3] ?? "").toUpperCase();
    const listen = proto === "udp" ? true : st === "0A";
    if (!listen) continue;
    const parsed = parseProcAddr(local);
    if (!parsed) continue;
    ports.push({ port: parsed.port, proto, localAddress: parsed.address, state: proto === "udp" ? "open" : "LISTEN" });
  }
  return ports;
}

export function parseProcAddr(hexAddr: string): { address: string; port: number } | undefined {
  const [ipHex, portHex] = hexAddr.split(":");
  if (!ipHex || !portHex) return undefined;
  const port = Number.parseInt(portHex, 16);
  if (!Number.isFinite(port)) return undefined;
  if (ipHex.length === 8) {
    const b = ipHex.match(/../g)?.map((h) => Number.parseInt(h, 16)) ?? [];
    if (b.length !== 4) return undefined;
    return { address: `${b[3]}.${b[2]}.${b[1]}.${b[0]}`, port };
  }
  return { address: "ipv6", port };
}

const RUNTIME_BINS = [
  "node",
  "python",
  "python3",
  "java",
  "docker",
  "podman",
  "kubectl",
  "vault",
  "psql",
  "mysql",
  "redis-cli",
  "nginx",
  "smbclient",
  "mount.nfs",
  "feishu",
  "lark",
  "dingtalk",
  "wxwork",
  "wecom",
  "gh",
  "slack",
  "notion",
];

function detectRuntimes(pathList: string[], fs: InventoryFs): RuntimeClue[] {
  const found: RuntimeClue[] = [];
  for (const id of RUNTIME_BINS) {
    let hit: string | undefined;
    for (const dir of pathList) {
      const unix = join(dir, id);
      const win = join(dir, `${id}.exe`);
      if (fs.exists(unix)) {
        hit = unix;
        break;
      }
      if (fs.exists(win)) {
        hit = win;
        break;
      }
    }
    found.push(hit ? { id, present: true, path: hit } : { id, present: false });
  }
  return found;
}

function detectContainer(plat: NodeJS.Platform, fs: InventoryFs, env: NodeJS.ProcessEnv) {
  const clues: string[] = [];
  const dockerSock = fs.exists("/var/run/docker.sock") || fs.exists("//./pipe/docker_engine");
  if (dockerSock) clues.push("docker.sock");
  const podmanSock = fs.exists("/run/podman/podman.sock") || fs.exists("/var/run/podman/podman.sock");
  if (podmanSock) clues.push("podman.sock");
  const kubernetes = Boolean(env.KUBERNETES_SERVICE_HOST) || fs.exists("/var/run/secrets/kubernetes.io/serviceaccount");
  if (kubernetes) clues.push("k8s-serviceaccount-or-env");
  let inContainer = kubernetes;
  if (plat === "linux") {
    if (fs.exists("/.dockerenv")) {
      inContainer = true;
      clues.push(".dockerenv");
    }
    const cgroup = fs.readFile("/proc/1/cgroup") ?? "";
    if (/docker|containerd|kubepods|libpod|podman/i.test(cgroup)) {
      inContainer = true;
      clues.push("cgroup");
    }
  }
  return { inContainer, kubernetes, dockerSock, podmanSock, clues };
}

/** Detect cloud metadata files/env. Never fetch IMDS; never copy secrets. */
export function detectCloud(
  fs: InventoryFs,
  env: NodeJS.ProcessEnv,
  home: string,
  gaps: string[],
): EnvironmentInventory["cloud"] {
  const providers: Array<"aws" | "gcp" | "azure" | "vault"> = [];
  const clues: string[] = [];
  const endpoints: Array<{ kind: string; url: string }> = [];
  const tokenEnvPresent: string[] = [];

  gaps.push("IMDS (169.254.169.254) is never queried (SSRF deny).");

  if (env.AWS_REGION || env.AWS_DEFAULT_REGION || fs.exists(join(home, ".aws", "config"))) {
    providers.push("aws");
    clues.push(env.AWS_REGION || env.AWS_DEFAULT_REGION ? "AWS_REGION" : "aws-config-file");
  }
  if (fs.exists(join(home, ".aws", "credentials"))) clues.push("aws-credentials-file-present");

  if (env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT || fs.exists(join(home, ".config", "gcloud"))) {
    providers.push("gcp");
    clues.push(env.GOOGLE_CLOUD_PROJECT ? "GOOGLE_CLOUD_PROJECT" : "gcloud-config");
  }

  if (env.IDENTITY_ENDPOINT || env.MSI_ENDPOINT || env.AZURE_CLIENT_ID) {
    providers.push("azure");
    clues.push("azure-identity-env");
  }

  const vaultAddr = env.VAULT_ADDR ?? env.OPENBAO_ADDR;
  if (vaultAddr && /^https?:\/\//i.test(vaultAddr)) {
    providers.push("vault");
    try {
      const u = new URL(vaultAddr);
      endpoints.push({ kind: "vault", url: `${u.protocol}//${u.host}` });
      clues.push("VAULT_ADDR");
    } catch {
      clues.push("VAULT_ADDR-unparsed");
    }
  }
  if (fs.exists(join(home, ".vault-token"))) clues.push("vault-token-file-present");

  for (const name of ["VAULT_TOKEN", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AZURE_CLIENT_SECRET"]) {
    if (env[name]) tokenEnvPresent.push(name);
  }

  return { providers, clues, endpoints, tokenEnvPresent };
}

function collectConfigPaths(plat: NodeJS.Platform, fs: InventoryFs, home: string): ConfigPathClue[] {
  const candidates: Array<{ path: string; kind: string }> = [
    { path: join(home, ".kube", "config"), kind: "kubeconfig" },
    { path: join(home, ".aws", "config"), kind: "aws-config" },
    { path: join(home, ".vault-token"), kind: "vault-token" },
    { path: "/etc/hosts", kind: "hosts" },
    { path: "/etc/os-release", kind: "os-release" },
    { path: "/var/run/docker.sock", kind: "docker-sock" },
    { path: "/run/podman/podman.sock", kind: "podman-sock" },
    { path: "/var/log/syslog", kind: "syslog" },
    { path: "/var/log/messages", kind: "messages" },
    { path: "/etc/exports", kind: "nfs-exports" },
  ];
  if (plat === "win32") {
    const win = envWinSystemRoot();
    candidates.push(
      { path: join(win, "System32", "drivers", "etc", "hosts"), kind: "hosts" },
      { path: join(home, ".docker", "config.json"), kind: "docker-config" },
    );
  }
  return candidates.map((c) => ({ ...c, exists: fs.exists(c.path) }));
}

function envWinSystemRoot(): string {
  return processEnv.SystemRoot ?? processEnv.SYSTEMROOT ?? "C:\\Windows";
}
