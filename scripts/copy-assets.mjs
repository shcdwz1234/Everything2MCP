#!/usr/bin/env node
// Cross-platform replacement for `mkdir -p … && cp …` in the build scripts.
// Usage: node scripts/copy-assets.mjs [protos|ui|all]   (default: all)
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const groups = {
  protos: [
    ["src/adapters/sparkplug/sparkplug_b.proto", "dist/adapters/sparkplug/sparkplug_b.proto"],
    ["src/adapters/pulsar/PulsarApi.proto", "dist/adapters/pulsar/PulsarApi.proto"],
  ],
  ui: [
    ["ui/index.html", "dist/ui/index.html"],
    ["ui/styles.css", "dist/ui/styles.css"],
  ],
};

const which = process.argv[2] ?? "all";
const selected = which === "all" ? Object.values(groups).flat() : groups[which];
if (!selected) {
  console.error(`copy-assets: unknown group "${which}" (use protos | ui | all)`);
  process.exit(2);
}
for (const [from, to] of selected) {
  const dest = join(root, to);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(join(root, from), dest);
}
console.log(`copy-assets: ${selected.length} file(s) (${which})`);
