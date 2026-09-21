import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AdapterError } from "../../runtime/errors.js";
import type { ControlMode, SecurityFile } from "./types.js";

export class SecurityStore {
  readonly filePath: string;
  private mode: ControlMode = "safe";
  private loaded = false;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "security.json");
  }

  async load(): Promise<ControlMode> {
    if (this.loaded) return this.mode;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as SecurityFile;
      if (parsed?.mode === "full" || parsed?.mode === "safe") this.mode = parsed.mode;
      if (Array.isArray(parsed?.modules)) {
        for (const row of parsed.modules) {
          if (row.source && row.source !== "builtin") {
            throw new AdapterError(
              "E_UNSUPPORTED",
              `v1 security loader only ships builtin modules (got source=${row.source} id=${row.id ?? "?"})`,
              { details: { source: row.source, id: row.id } },
            );
          }
        }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.mode = "safe";
      } else if (err instanceof AdapterError) {
        throw err;
      } else if (err instanceof SyntaxError) {
        this.mode = "safe";
      } else {
        throw err;
      }
    }
    this.loaded = true;
    return this.mode;
  }

  async save(mode: ControlMode): Promise<void> {
    this.mode = mode;
    this.loaded = true;
    await mkdir(dirname(this.filePath), { recursive: true });
    const body: SecurityFile = { version: 1, mode, modules: [] };
    await writeFile(this.filePath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  }

  current(): ControlMode {
    return this.mode;
  }

  invalidate(): void {
    this.loaded = false;
  }
}
