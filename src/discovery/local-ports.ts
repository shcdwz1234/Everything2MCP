import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseProcNet } from "./environment.js";

const execFileAsync = promisify(execFile);

/** Ephemeral / OS RPC ranges we do not bother probing as HTTP. */
const SKIP_HIGH = 49152;

/**
 * Best-effort list of local TCP listen ports (localhost enrichment for auto-discovery).
 * Linux: /proc/net/tcp{,6}. Windows: `netstat -ano -p tcp`. Failures return [].
 */
export async function listLocalListenTcpPorts(opts: { max?: number } = {}): Promise<number[]> {
  const max = Math.max(1, Math.min(64, opts.max ?? 40));
  try {
    if (process.platform === "linux") {
      const ports = new Set<number>();
      for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
        try {
          const raw = readFileSync(file, "utf8");
          for (const p of parseProcNet(raw, "tcp")) {
            if (p.port > 0 && p.port < SKIP_HIGH) ports.add(p.port);
          }
        } catch {
          /* missing /proc entry */
        }
      }
      return [...ports].sort((a, b) => a - b).slice(0, max);
    }
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "tcp"], {
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 2_000_000,
      });
      const ports = new Set<number>();
      for (const line of stdout.split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue;
        // TCP    0.0.0.0:6379    0.0.0.0:0    LISTENING    1234
        // TCP    [::]:8080       [::]:0       LISTENING    1234
        // TCP    127.0.0.1:8755  0.0.0.0:0    LISTENING    1234
        const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+/i);
        if (!m) continue;
        const port = Number(m[1]);
        if (Number.isFinite(port) && port > 0 && port < SKIP_HIGH) ports.add(port);
      }
      return [...ports].sort((a, b) => a - b).slice(0, max);
    }
  } catch {
    return [];
  }
  return [];
}