import { generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";
import type { SFTPWrapper } from "ssh2";

const { Client, Server, utils } = createRequire(import.meta.url)("ssh2") as typeof import("ssh2");
import { AdapterError } from "../../runtime/errors.js";
import { assertHostAllowed } from "../../runtime/ssrf.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";
import { requiredString, stringField } from "../helpers.js";

const OPEN_MODE = utils.sftp.OPEN_MODE;
const STATUS_CODE = utils.sftp.STATUS_CODE;

function attrs(size: number, mode = 0o100644) {
  return { mode, uid: 0, gid: 0, size, atime: 0, mtime: 0 };
}

export interface SftpHandle {
  list(path: string): Promise<string[]>;
  get(path: string): Promise<{ path: string; body: string }>;
  put(path: string, body: string): Promise<{ path: string; size: number }>;
  delete(path: string): Promise<{ path: string; deleted: true }>;
  close(): Promise<void>;
}

export type SftpConnectFn = (config: Record<string, unknown>) => Promise<SftpHandle>;

export function createMemorySftp(): SftpHandle {
  const files = new Map<string, string>([["readme.txt", "hello sftp"]]);
  return {
    async list() {
      return [...files.keys()].sort();
    },
    async get(path) {
      const body = files.get(path);
      if (body === undefined) throw new AdapterError("E_NOT_FOUND", `SFTP no such file ${path}`, { protocol: "sftp" });
      return { path, body };
    },
    async put(path, body) {
      files.set(path, body);
      return { path, size: Buffer.byteLength(body) };
    },
    async delete(path) {
      if (!files.delete(path)) throw new AdapterError("E_NOT_FOUND", `SFTP no such file ${path}`, { protocol: "sftp" });
      return { path, deleted: true };
    },
    async close() {
      files.clear();
    },
  };
}

function asSftp(sftp: SFTPWrapper): SftpHandle {
  const call = <T>(fn: (cb: (err: Error | undefined | null, value?: T) => void) => void): Promise<T> =>
    new Promise((resolve, reject) => {
      fn((err, value) => {
        if (err) reject(new AdapterError("E_PROTOCOL", err.message, { protocol: "sftp" }));
        else resolve(value as T);
      });
    });
  return {
    async list(path) {
      const entries = await call<Array<{ filename: string }>>((cb) => sftp.readdir(path || ".", cb));
      return entries.map((e) => e.filename).filter((n) => n !== "." && n !== "..");
    },
    async get(path) {
      const buf = await call<Buffer>((cb) => sftp.readFile(path, cb));
      return { path, body: buf.toString("utf8") };
    },
    async put(path, body) {
      await call<void>((cb) => sftp.writeFile(path, body, cb));
      return { path, size: Buffer.byteLength(body) };
    },
    async delete(path) {
      await call<void>((cb) => sftp.unlink(path, cb));
      return { path, deleted: true };
    },
    async close() {
      sftp.end();
    },
  };
}

async function liveSftp(config: Record<string, unknown>): Promise<SftpHandle> {
  const host = stringField(config, "host") ?? stringField(config, "url")?.replace(/^sftp:\/\//i, "").split(":")[0];
  if (!host) throw new AdapterError("E_INVALID_CONFIG", "SFTP adapter requires config.host", { protocol: "sftp" });
  await assertHostAllowed(host);
  const port = typeof config.port === "number" ? config.port : 22;
  const timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 4000;
  const username = stringField(config, "user") ?? stringField(config, "username") ?? "anonymous";
  const password = stringField(config, "password") ?? stringField(config, "pass") ?? "";
  const conn = new Client();
  const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AdapterError("E_TIMEOUT", "SFTP timeout", { protocol: "sftp" })), timeoutMs);
    conn.on("ready", () => {
      conn.sftp((err, wrapper) => {
        clearTimeout(timer);
        if (err || !wrapper) reject(err ?? new AdapterError("E_PROTOCOL", "SFTP subsystem failed", { protocol: "sftp" }));
        else resolve(wrapper);
      });
    });
    conn.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    conn.connect({
      host,
      port,
      username,
      password,
      readyTimeout: timeoutMs,
      hostVerifier: () => true,
    });
  });
  const handle = asSftp(sftp);
  return {
    ...handle,
    async close() {
      await handle.close();
      conn.end();
    },
  };
}

async function defaultConnect(config: Record<string, unknown>): Promise<SftpHandle> {
  const host = stringField(config, "host") ?? stringField(config, "url");
  if (config.simulator === true || !host) return createMemorySftp();
  return liveSftp(config);
}

export function generateSftpHostKey(): string {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  }).privateKey;
}

/** Real ssh2 SFTP subsystem loopback (not FTP). */
export async function listenSftpLoopback(opts?: {
  user?: string;
  password?: string;
  hostKey?: string;
}): Promise<{ port: number; close: () => Promise<void> }> {
  const mem = createMemorySftp();
  const user = opts?.user ?? "e2mcp";
  const password = opts?.password ?? "sftp";
  const hostKey = opts?.hostKey ?? generateSftpHostKey();
  const files = new Map<string, Buffer>();
  const names = await mem.list(".");
  for (const n of names) {
    const got = await mem.get(n);
    files.set(n, Buffer.from(got.body, "utf8"));
  }
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && ctx.username === user && ctx.password === password) ctx.accept();
      else if (ctx.method === "none" && password === "") ctx.accept();
      else ctx.reject(["password"]);
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("sftp", (acceptSftp) => {
          const sftp = acceptSftp();
          const handles = new Map<string, { path: string; dir?: boolean; listing?: string[]; offset?: number }>();
          let hid = 1;
          const handleOf = (kind: string) => {
            const id = Buffer.alloc(4);
            id.writeUInt32BE(hid, 0);
            handles.set(String(hid), { path: kind });
            hid += 1;
            return id;
          };
          sftp.on("REALPATH", (reqid, path) => {
            sftp.name(reqid, [{ filename: path || ".", longname: path || ".", attrs: attrs(0, 0o040755) }]);
          });
          sftp.on("STAT", (reqid, path) => {
            const name = path.replace(/^\.\//, "") || ".";
            if (name === "." || name === "/") {
              sftp.attrs(reqid, attrs(0, 0o040755));
              return;
            }
            const hit = files.get(name);
            if (!hit) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
            sftp.attrs(reqid, attrs(hit.length));
          });
          sftp.on("OPENDIR", (reqid, path) => {
            const id = handleOf(path || ".");
            handles.get(String(id.readUInt32BE(0)))!.dir = true;
            handles.get(String(id.readUInt32BE(0)))!.listing = [...files.keys()];
            sftp.handle(reqid, id);
          });
          sftp.on("READDIR", (reqid, handle) => {
            const rec = handles.get(String(handle.readUInt32BE(0)));
            if (!rec?.dir) return sftp.status(reqid, STATUS_CODE.FAILURE);
            if (!rec.listing || rec.listing.length === 0) return sftp.status(reqid, STATUS_CODE.EOF);
            const listing = rec.listing;
            rec.listing = [];
            sftp.name(
              reqid,
              listing.map((filename) => ({
                filename,
                longname: filename,
                attrs: attrs(files.get(filename)?.length ?? 0),
              })),
            );
          });
          sftp.on("OPEN", (reqid, filename, flags) => {
            const name = filename.replace(/^\.\//, "");
            const id = handleOf(name);
            handles.get(String(id.readUInt32BE(0)))!.offset = 0;
            if (flags & OPEN_MODE.WRITE) files.set(name, Buffer.alloc(0));
            else if (!files.has(name)) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
            sftp.handle(reqid, id);
          });
          sftp.on("READ", (reqid, handle, offset, length) => {
            const rec = handles.get(String(handle.readUInt32BE(0)));
            const data = rec ? files.get(rec.path) : undefined;
            if (!data) return sftp.status(reqid, STATUS_CODE.FAILURE);
            if (offset >= data.length) return sftp.status(reqid, STATUS_CODE.EOF);
            sftp.data(reqid, data.subarray(offset, offset + length));
          });
          sftp.on("WRITE", (reqid, handle, offset, data) => {
            const rec = handles.get(String(handle.readUInt32BE(0)));
            if (!rec) return sftp.status(reqid, STATUS_CODE.FAILURE);
            const cur = files.get(rec.path) ?? Buffer.alloc(0);
            const next = Buffer.alloc(Math.max(cur.length, offset + data.length));
            cur.copy(next);
            data.copy(next, offset);
            files.set(rec.path, next);
            sftp.status(reqid, STATUS_CODE.OK);
          });
          sftp.on("CLOSE", (reqid, handle) => {
            handles.delete(String(handle.readUInt32BE(0)));
            sftp.status(reqid, STATUS_CODE.OK);
          });
          sftp.on("REMOVE", (reqid, path) => {
            const name = path.replace(/^\.\//, "");
            if (!files.delete(name)) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
            sftp.status(reqid, STATUS_CODE.OK);
          });
        });
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as { port: number }).port, close: () => new Promise((r) => server.close(() => r())) };
}

/** SFTP over SSH-2 (ssh2). LIST/GET read; PUT/DELETE need allowWrite. Not FTP. */
export class SftpAdapter implements ProtocolAdapter {
  readonly protocol = "sftp";
  private handle: SftpHandle | undefined;
  private connected = false;
  private allowWrite = false;

  constructor(
    readonly id: string,
    private readonly connectFn: SftpConnectFn = defaultConnect,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    this.allowWrite = allowWriteFrom(config);
    this.handle = await this.connectFn(config);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.handle) await this.handle.close();
    this.handle = undefined;
    this.connected = false;
  }

  async listTools(): Promise<McpToolSchema[]> {
    this.assertConnected();
    return [
      {
        name: "list",
        description: "SFTP readdir (not FTP LIST)",
        inputSchema: { type: "object", properties: { path: { type: "string", default: "." } }, additionalProperties: false },
      },
      {
        name: "get",
        description: "SFTP readFile",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
      },
      {
        name: "put",
        description: "SFTP writeFile (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" }, body: { type: "string" } },
          required: ["path", "body"],
          additionalProperties: false,
        },
      },
      {
        name: "delete",
        description: "SFTP unlink (requires allowWrite=true)",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const h = this.handle!;
    if (toolName === "list") return { names: await h.list(typeof args.path === "string" ? args.path : ".") };
    if (toolName === "get") return h.get(requiredString(args, "path"));
    if (toolName === "put") {
      assertCanWrite("sftp", this.allowWrite);
      return h.put(requiredString(args, "path"), requiredString(args, "body"));
    }
    if (toolName === "delete") {
      assertCanWrite("sftp", this.allowWrite);
      return h.delete(requiredString(args, "path"));
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown tool: ${toolName}`, { protocol: "sftp" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected || !this.handle) return { ok: false, detail: "not connected" };
    try {
      await this.handle.list(".");
      return { ok: true, detail: "sftp ssh2" };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_INVALID_CONFIG", "SFTP adapter is not connected", { protocol: "sftp" });
    }
  }
}
