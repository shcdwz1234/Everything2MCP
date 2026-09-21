import { readFileSync, watch, type FSWatcher } from "node:fs";
import { AdapterError } from "../runtime/errors.js";

export type PemSource = "inline" | "file";

export interface LoadedPem {
  buffer: Buffer;
  source: PemSource;
  key: string;
  path?: string;
}

export interface TlsMaterial {
  ca?: LoadedPem;
  cert?: LoadedPem;
  key?: LoadedPem;
  loadedAt: string;
  /** File paths that will be re-read on the next adapter reconnect (`mcp_update`). */
  filePaths: string[];
  note: string;
}

const CA_KEYS = ["ca", "tlsCa", "caFile", "tlsCaFile"];
const CERT_KEYS = ["cert", "tlsCert", "certFile", "tlsCertFile"];
const KEY_KEYS = ["key", "tlsKey", "keyFile", "tlsKeyFile"];

function asString(config: Record<string, unknown>, key: string): string | undefined {
  const v = config[key];
  return typeof v === "string" && v.trim() ? v : undefined;
}

/**
 * Load one PEM from inline text or a filesystem path.
 * Use `watchTlsMaterial` to re-read file paths without restarting the process.
 */
export function loadPemFromConfig(
  config: Record<string, unknown>,
  keys: string[],
  protocol: string,
): LoadedPem | undefined {
  for (const key of keys) {
    const value = asString(config, key);
    if (!value) continue;
    if (/-----BEGIN /.test(value)) {
      return { buffer: Buffer.from(value, "utf8"), source: "inline", key };
    }
    try {
      return { buffer: readFileSync(value), source: "file", key, path: value };
    } catch (err) {
      throw new AdapterError(
        "E_INVALID_CONFIG",
        `${protocol} TLS file "${key}" is not readable: ${value} (${err instanceof Error ? err.message : String(err)})`,
        { protocol },
      );
    }
  }
  return undefined;
}

/** Shared TLS material for gRPC / other adapters. Reconnect (`mcp_update`) re-reads file paths. */
export function loadTlsMaterial(config: Record<string, unknown>, protocol: string): TlsMaterial {
  const ca = loadPemFromConfig(config, CA_KEYS, protocol);
  const cert = loadPemFromConfig(config, CERT_KEYS, protocol);
  const key = loadPemFromConfig(config, KEY_KEYS, protocol);
  if ((cert && !key) || (key && !cert)) {
    throw new AdapterError("E_INVALID_CONFIG", `${protocol} mTLS requires both cert and key (inline PEM or file path)`, {
      protocol,
    });
  }
  const filePaths = [ca, cert, key].flatMap((p) => (p?.path ? [p.path] : []));
  return {
    ca,
    cert,
    key,
    loadedAt: new Date().toISOString(),
    filePaths,
    note: "PEM files are read at connect. watchTlsMaterial re-reads file paths in-process. gRPC tlsWatch remounts ChannelCredentials without mcp_update; bidi sessions drop. mcp_update is only needed if remount fails.",
  };
}

export interface TlsWatchHandle {
  get(): TlsMaterial;
  lastError?: AdapterError;
  generations: number;
  watching: boolean;
  stop(): void;
}

/** Watch PEM file paths and re-read them. gRPC adapter remounts clients on change. */
export function watchTlsMaterial(
  config: Record<string, unknown>,
  protocol: string,
  onChange?: (material: TlsMaterial) => void,
): TlsWatchHandle {
  let material = loadTlsMaterial(config, protocol);
  const handle: TlsWatchHandle = {
    get() {
      return material;
    },
    lastError: undefined,
    generations: 1,
    watching: false,
    stop() {
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          /* already closed */
        }
      }
      watchers.length = 0;
      handle.watching = false;
      if (timer) clearTimeout(timer);
    },
  };
  const watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reload = () => {
    try {
      material = loadTlsMaterial(config, protocol);
      handle.lastError = undefined;
      handle.generations += 1;
      onChange?.(material);
    } catch (err) {
      handle.lastError =
        err instanceof AdapterError
          ? err
          : new AdapterError("E_INVALID_CONFIG", err instanceof Error ? err.message : String(err), { protocol });
    }
  };
  for (const path of material.filePaths) {
    try {
      const w = watch(path, { persistent: false }, () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(reload, 25);
      });
      w.on("error", () => {
        handle.lastError = new AdapterError("E_INVALID_CONFIG", `${protocol} TLS watch failed for ${path}`, {
          protocol,
        });
      });
      watchers.push(w);
    } catch (err) {
      handle.lastError = new AdapterError(
        "E_INVALID_CONFIG",
        `${protocol} TLS watch could not start on ${path}: ${err instanceof Error ? err.message : String(err)}`,
        { protocol },
      );
    }
  }
  handle.watching = watchers.length > 0;
  return handle;
}

export function tlsMaterialSummary(material: TlsMaterial): string {
  const bits = [
    material.ca ? `ca=${material.ca.source}` : undefined,
    material.cert ? `cert=${material.cert.source}` : undefined,
    material.key ? `key=${material.key.source}` : undefined,
    material.filePaths.length ? `files=${material.filePaths.length}` : undefined,
  ].filter(Boolean);
  return bits.length ? bits.join(" ") : "tls=insecure-or-default";
}
