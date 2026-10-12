#!/usr/bin/env node
// Cross-platform test runner: shells do not expand `tests/**/*.test.ts` the same way
// (bash without globstar, cmd.exe not at all), so collect the files here and hand them to tsx.
// Extra args are passed through, e.g. `npm test -- --test-name-pattern=blacklist`.
// Positional args ending in .test.ts replace the default file set.
import { spawn } from "node:child_process";
import { webcrypto } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Node 18: some deps (node-opcua / @peculiar) expect global Crypto. */
function ensureWebCrypto() {
  if (typeof globalThis.crypto === "undefined" && webcrypto) {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true, writable: true });
  }
  if (typeof globalThis.Crypto === "undefined" && webcrypto?.constructor) {
    Object.defineProperty(globalThis, "Crypto", { value: webcrypto.constructor, configurable: true, writable: true });
  }
}
ensureWebCrypto();

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function collect(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...collect(p));
    else if (name.endsWith(".test.ts")) out.push(relative(root, p));
  }
  return out;
}

const args = process.argv.slice(2);
const explicit = args.filter((a) => a.endsWith(".test.ts"));
const flags = args.filter((a) => !a.endsWith(".test.ts"));
const files = explicit.length ? explicit : collect(join(root, "tests")).sort();
if (!files.length) {
  console.error("run-tests: no *.test.ts files found under tests/");
  process.exit(1);
}

const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
const child = spawn(process.execPath, [tsxCli, "--test", ...flags, ...files], { cwd: root, stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
