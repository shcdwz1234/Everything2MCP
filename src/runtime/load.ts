import { parse } from "yaml";
import { fetchSafe } from "./ssrf.js";

export async function loadText(source: string): Promise<{ text: string; href?: string }> {
  if (/^https?:\/\//i.test(source)) {
    const res = await fetchSafe(source, { method: "GET", timeoutMs: 8000 });
    if (!res.ok) {
      throw new Error(`Failed to fetch ${source}: HTTP ${res.status} ${res.statusText}`);
    }
    return { text: await res.text(), href: source };
  }
  const { readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const path = source.startsWith("file://") ? fileURLToPath(source) : resolve(source);
  return { text: await readFile(path, "utf8") };
}

export function parseJsonOrYaml(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Document is empty");
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }
  return parse(trimmed);
}

export async function loadJsonOrYaml(source: string): Promise<{ value: unknown; href?: string }> {
  const { text, href } = await loadText(source);
  return { value: parseJsonOrYaml(text), href };
}

export function asRecord(value: unknown, label = "value"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
