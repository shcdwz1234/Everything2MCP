import { mkdir, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function copy(srcRel, destRel) {
  const src = join(root, srcRel);
  const dest = join(root, destRel);
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(src, dest);
}

const mode = process.argv[2] ?? "all";

if (mode === "proto" || mode === "all") {
  await copy(
    "src/adapters/sparkplug/sparkplug_b.proto",
    "dist/adapters/sparkplug/sparkplug_b.proto",
  );
  await copy(
    "src/adapters/pulsar/PulsarApi.proto",
    "dist/adapters/pulsar/PulsarApi.proto",
  );
}

if (mode === "ui" || mode === "all") {
  await copy("ui/index.html", "dist/ui/index.html");
  await copy("ui/styles.css", "dist/ui/styles.css");
}

console.log(`copy-assets (${mode}) done`);
