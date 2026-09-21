import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RegistrationRecord } from "../runtime/types.js";

export interface StoreFile {
  version: 1;
  registrations: RegistrationRecord[];
}

const EMPTY: StoreFile = { version: 1, registrations: [] };

export class JsonStore {
  readonly dataDir: string;
  readonly filePath: string;
  /** Called after a successful disk write (security integrity seal). */
  onPersist?: () => Promise<void>;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.filePath = join(dataDir, "registrations.json");
  }

  async load(): Promise<RegistrationRecord[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as StoreFile;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.registrations)) {
        return [];
      }
      return parsed.registrations;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return [];
      throw err;
    }
  }

  async save(registrations: RegistrationRecord[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const body: StoreFile = { version: 1, registrations };
    await writeFile(this.filePath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    if (this.onPersist) await this.onPersist();
  }

  async upsert(record: RegistrationRecord): Promise<void> {
    const all = await this.load();
    const idx = all.findIndex((r) => r.id === record.id);
    if (idx >= 0) {
      all[idx] = record;
    } else {
      all.push(record);
    }
    await this.save(all);
  }

  async remove(id: string): Promise<boolean> {
    const all = await this.load();
    const next = all.filter((r) => r.id !== id);
    if (next.length === all.length) return false;
    await this.save(next);
    return true;
  }
}
