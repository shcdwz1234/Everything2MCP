import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { AdapterError } from "../runtime/errors.js";
import type { JsonObject } from "../runtime/types.js";
import { makeId } from "../catalog/registry.js";
import { manifestToConfig, parsePartnerManifest, PARTNER_MANIFEST_SCHEMA } from "../adapters/partner/manifest.js";
import { touchPartnerHeartbeat } from "../adapters/partner/sessions.js";
import type { ManagementContext } from "./tools.js";
import { callManagementTool } from "./tools.js";
import { defaultDropsDir } from "../discovery/compat.js";

const TOKEN_FILE = "partner-token";

export async function readOrCreatePartnerToken(dataDir: string): Promise<string> {
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, TOKEN_FILE);
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing.length >= 16) return existing;
  } catch {
    /* create */
  }
  const token = randomBytes(24).toString("hex");
  await writeFile(path, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  return token;
}

export async function rotatePartnerToken(dataDir: string): Promise<string> {
  await mkdir(dataDir, { recursive: true });
  const token = randomBytes(24).toString("hex");
  await writeFile(join(dataDir, TOKEN_FILE), `${token}\n`, { encoding: "utf8", mode: 0o600 });
  return token;
}

export function partnerTokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function extractPartnerToken(headers: Record<string, string> | undefined): string | undefined {
  if (!headers) return undefined;
  const auth = headers.authorization ?? headers.Authorization;
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  const direct = headers["x-partner-token"] ?? headers["X-Partner-Token"];
  return direct?.trim() || undefined;
}

export async function assertPartnerToken(ctx: ManagementContext, headers?: Record<string, string>): Promise<void> {
  const expected = await readOrCreatePartnerToken(ctx.config.dataDir);
  const provided = extractPartnerToken(headers);
  if (!provided || !partnerTokensEqual(provided, expected)) {
    throw new AdapterError("E_AUTH", "Partner token missing or invalid (loopback + dataDir/partner-token)", {
      protocol: "partner",
    });
  }
}

export async function partnerRegister(
  ctx: ManagementContext,
  body: JsonObject,
  opts: { auto?: boolean; confirm?: boolean; allowWrite?: boolean } = {},
): Promise<unknown> {
  const manifestRaw = (body.manifest && typeof body.manifest === "object" ? body.manifest : body) as JsonObject;
  const manifest = parsePartnerManifest({ ...manifestRaw, simulator: body.simulator === true || manifestRaw.simulator === true });
  const extra: JsonObject = {};
  if (opts.allowWrite === true || body.allowWrite === true) extra.allowWrite = true;
  if (body.allowDesktop === true) extra.allowDesktop = true;
  if (body.simulator === true || manifestRaw.simulator === true) extra.simulator = true;
  const config = manifestToConfig(manifest, extra);
  const auto = opts.auto === true || body.auto === true;
  const confirm = opts.confirm === true || body.confirm === true;
  return callManagementTool(
    "capability_register",
    {
      protocol: "partner",
      name: manifest.capability_id,
      config,
      auto,
      confirm,
    },
    ctx,
  );
}

export async function partnerUnregister(ctx: ManagementContext, body: JsonObject): Promise<unknown> {
  if (body.confirm !== true) {
    throw new AdapterError("E_INVALID_ARGUMENT", "Partner unregister requires confirm:true", {
      protocol: "partner",
      details: { confirm: true },
    });
  }
  const capability_id =
    (typeof body.capability_id === "string" && body.capability_id.trim()) ||
    (typeof body.id === "string" && body.id.trim()) ||
    "";
  if (!capability_id) {
    throw new AdapterError("E_INVALID_ARGUMENT", "Unregister needs capability_id", { protocol: "partner" });
  }
  const id = capability_id.includes(":") ? capability_id : makeId("partner", capability_id);
  return callManagementTool("capability_unregister", { id }, ctx);
}

export async function partnerHeartbeat(ctx: ManagementContext, body: JsonObject): Promise<unknown> {
  const capability_id = typeof body.capability_id === "string" ? body.capability_id.trim() : "";
  if (!capability_id) {
    throw new AdapterError("E_INVALID_ARGUMENT", "heartbeat needs capability_id", { protocol: "partner" });
  }
  const id = capability_id.includes(":") ? capability_id : makeId("partner", capability_id);
  const rec = ctx.registry.getRecord(id);
  if (!rec) throw new AdapterError("E_NOT_FOUND", `Unknown partner capability: ${id}`, { details: { id } });
  touchPartnerHeartbeat(id);
  return { ok: true, id, heartbeatAt: new Date().toISOString() };
}

export async function partnerInvokeInternal(ctx: ManagementContext, body: JsonObject): Promise<unknown> {
  const capability_id = typeof body.capability_id === "string" ? body.capability_id.trim() : "";
  const op = typeof body.op === "string" ? body.op.trim() : "";
  if (!capability_id || !op) {
    throw new AdapterError("E_INVALID_ARGUMENT", "internal invoke needs capability_id and op", { protocol: "partner" });
  }
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : capability_id;
  const tool = `partner.${name}.${op}`;
  const args = body.args && typeof body.args === "object" && !Array.isArray(body.args) ? (body.args as JsonObject) : {};
  const result = await ctx.registry.invoke(tool, args);
  return { ok: true, tool, call_id: body.call_id, result };
}

export function partnerSchemaPayload(): unknown {
  return { ok: true, schema: PARTNER_MANIFEST_SCHEMA, version: "v1" };
}

export async function pickupDrops(ctx: ManagementContext, dir?: string): Promise<{ picked: string[]; errors: Array<{ file: string; error: string }> }> {
  const dropsDir = dir ?? defaultDropsDir();
  const picked: string[] = [];
  const errors: Array<{ file: string; error: string }> = [];
  let names: string[] = [];
  try {
    const st = await stat(dropsDir);
    if (!st.isDirectory()) return { picked, errors };
    names = await readdir(dropsDir);
  } catch {
    return { picked, errors };
  }
  for (const ent of names) {
    if (!ent.endsWith(".json")) continue;
    const file = join(dropsDir, ent);
    try {
      const raw = JSON.parse(await readFile(file, "utf8")) as JsonObject;
      const manifest = parsePartnerManifest({ ...raw, simulator: raw.simulator === true });
      const id = makeId("partner", manifest.capability_id);
      if (ctx.registry.getRecord(id)) {
        picked.push(file);
        continue;
      }
      await partnerRegister(
        ctx,
        { ...raw, simulator: raw.simulator === true, confirm: true, auto: false },
        { confirm: true, auto: false },
      );
      picked.push(file);
    } catch (err) {
      errors.push({ file, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { picked, errors };
}

export { defaultDropsDir, PARTNER_MANIFEST_SCHEMA };
