import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AdapterError } from "../../runtime/errors.js";

export const INTEGRITY_WATCH = ["security.json", "blacklist.json", "registrations.json"] as const;
export const INTEGRITY_KEY_FILE = ".integrity-key";

export type IntegrityAlgo = "sha256" | "hmac-sha256";
export type IntegrityKeySource = "env" | "file" | "none";

export interface IntegrityFile {
  version: 1;
  algo: IntegrityAlgo;
  files: Record<string, string>;
  mac?: string;
}

export interface IntegritySnapshot {
  algo: IntegrityAlgo;
  hmac: boolean;
  keySource: IntegrityKeySource;
  files: Record<string, string | null>;
}

export function resolveIntegrityKey(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): { key?: Buffer; source: IntegrityKeySource } {
  const fromEnv = env.EVERYTHING2MCP_INTEGRITY_KEY?.trim();
  if (fromEnv) return { key: Buffer.from(fromEnv, "utf8"), source: "env" };
  const path = join(dataDir, INTEGRITY_KEY_FILE);
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf8").trim();
      if (raw) return { key: Buffer.from(raw, "utf8"), source: "file" };
    } catch {
      /* fall through */
    }
  }
  return { source: "none" };
}

/**
 * SHA-256 ledger for critical JSON. When EVERYTHING2MCP_INTEGRITY_KEY or
 * dataDir/.integrity-key is present, hashes become HMAC-SHA256 and the ledger
 * itself is MAC'd — tampering the target or integrity.json fails.
 * Without a key, first-seen SHA-256 still detects casual edits only.
 */
export class IntegrityLedger {
  readonly filePath: string;
  readonly keySource: IntegrityKeySource;
  private readonly key?: Buffer;

  constructor(dataDir: string, opts?: { key?: Buffer | string; keySource?: IntegrityKeySource }) {
    this.filePath = join(dataDir, "integrity.json");
    if (opts?.key !== undefined) {
      this.key = typeof opts.key === "string" ? Buffer.from(opts.key, "utf8") : opts.key;
      this.keySource = opts.keySource ?? "file";
    } else {
      const resolved = resolveIntegrityKey(dataDir);
      this.key = resolved.key;
      this.keySource = resolved.source;
    }
  }

  get hmac(): boolean {
    return Boolean(this.key);
  }

  get algo(): IntegrityAlgo {
    return this.key ? "hmac-sha256" : "sha256";
  }

  async seal(name: string): Promise<string | undefined> {
    const hash = await this.hashName(name);
    const body = await this.readLedger({ verifyMac: false });
    body.algo = this.algo;
    if (hash) body.files[name] = hash;
    else delete body.files[name];
    await this.writeLedger(body);
    return hash;
  }

  async verify(name: string): Promise<void> {
    const body = await this.readLedger({ verifyMac: true });
    const hash = await this.hashName(name);
    const expected = body.files[name];
    if (this.key && !expected && hash) {
      throw new AdapterError(
        "E_UNSUPPORTED",
        `Integrity check failed: ${name} exists but is not sealed (ledger may have been edited)`,
        { details: { file: name } },
      );
    }
    if (!expected && hash) {
      await this.seal(name);
      return;
    }
    if (!expected && !hash) return;
    if (expected && !hash) {
      throw new AdapterError(
        "E_UNSUPPORTED",
        `Integrity check failed: ${name} is missing but was sealed`,
        { details: { file: name } },
      );
    }
    if (!safeEqualHex(expected, hash)) {
      throw new AdapterError(
        "E_UNSUPPORTED",
        `Integrity check failed: ${name} hash mismatch (file may have been edited on disk)`,
        { details: { file: name } },
      );
    }
  }

  async verifyAll(): Promise<void> {
    if (this.key) {
      const existing = await this.readLedger({ verifyMac: false });
      if (existing.algo === "sha256" && Object.keys(existing.files).length > 0) {
        for (const name of INTEGRITY_WATCH) await this.seal(name);
      }
      await this.assertLedgerPresentIfWatchedExist();
    }
    for (const name of INTEGRITY_WATCH) await this.verify(name);
  }

  async snapshot(): Promise<IntegritySnapshot> {
    const body = await this.readLedger({ verifyMac: false });
    const files: Record<string, string | null> = {};
    for (const name of INTEGRITY_WATCH) files[name] = body.files[name] ?? null;
    return { algo: this.algo, hmac: this.hmac, keySource: this.keySource, files };
  }

  private async assertLedgerPresentIfWatchedExist(): Promise<void> {
    try {
      await readFile(this.filePath);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    for (const name of INTEGRITY_WATCH) {
      const hash = await this.hashName(name);
      if (hash) {
        throw new AdapterError(
          "E_UNSUPPORTED",
          "Integrity check failed: integrity.json is missing but watched files exist (HMAC ledger cannot first-seen after wipe)",
        );
      }
    }
  }

  private digest(raw: Buffer): string {
    if (this.key) return createHmac("sha256", this.key).update(raw).digest("hex");
    return createHash("sha256").update(raw).digest("hex");
  }

  private async hashName(name: string): Promise<string | undefined> {
    try {
      const raw = await readFile(join(dirname(this.filePath), name));
      return this.digest(raw);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  private macFiles(files: Record<string, string>): string | undefined {
    if (!this.key) return undefined;
    const canonical = JSON.stringify(
      Object.keys(files)
        .sort()
        .reduce<Record<string, string>>((acc, k) => {
          acc[k] = files[k]!;
          return acc;
        }, {}),
    );
    return createHmac("sha256", this.key).update(canonical).digest("hex");
  }

  private async writeLedger(body: IntegrityFile): Promise<void> {
    const next: IntegrityFile = {
      version: 1,
      algo: this.algo,
      files: { ...body.files },
      ...(this.key ? { mac: this.macFiles(body.files) } : {}),
    };
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }

  private async readLedger(opts: { verifyMac: boolean }): Promise<IntegrityFile> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as IntegrityFile;
      if (!parsed || parsed.version !== 1 || !parsed.files || typeof parsed.files !== "object") {
        return { version: 1, algo: this.algo, files: {} };
      }
      const files = { ...parsed.files };
      if (this.key && parsed.algo === "hmac-sha256" && opts.verifyMac) {
        const expected = parsed.mac;
        const actual = this.macFiles(files);
        if (!expected || !actual || !safeEqualHex(expected, actual)) {
          throw new AdapterError(
            "E_UNSUPPORTED",
            "Integrity check failed: integrity.json MAC mismatch (ledger may have been edited)",
          );
        }
      }
      if (this.key && parsed.algo === "sha256" && opts.verifyMac) {
        /* upgrade: reseal under HMAC on next seal/verifyAll */
      }
      return { version: 1, algo: parsed.algo === "hmac-sha256" ? "hmac-sha256" : "sha256", files };
    } catch (err) {
      if (err instanceof AdapterError) throw err;
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, algo: this.algo, files: {} };
      }
      throw err;
    }
  }
}

function safeEqualHex(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  try {
    const left = Buffer.from(a, "hex");
    const right = Buffer.from(b, "hex");
    if (left.length === 0 || left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}
