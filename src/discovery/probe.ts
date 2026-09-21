import { fetchSafe } from "../runtime/ssrf.js";
import { AdapterError } from "../runtime/errors.js";
import { assertHostAllowed } from "../runtime/ssrf.js";
import type { DiscoveryCandidate } from "../runtime/types.js";

const OPENAPI_PATHS = [
  "/openapi.json",
  "/openapi.yaml",
  "/openapi.yml",
  "/swagger.json",
  "/swagger.yaml",
  "/swagger/v1/swagger.json",
  "/v2/api-docs",
  "/v3/api-docs",
  "/api-docs",
  "/api/openapi.json",
  "/docs/openapi.json",
  "/.well-known/openapi.json",
];

const WEBDAV_PATHS = ["/", "/dav", "/webdav", "/remote.php/dav"];

const SOAP_PATHS = ["/?wsdl", "/service?wsdl", "/ws?wsdl", "/soap?wsdl", "/wsdl"];

const GRAPHQL_PATHS = ["/graphql", "/api/graphql"];

export function looksLikeNetworkRange(host: string): boolean {
  const h = host.trim();
  if (!h) return true;
  if (h.includes("/") || h.includes("*") || h.includes(",")) return true;
  if (/\s/.test(h)) return true;
  if (/^\d+\.\d+\.\d+\.\d+\s*-\s*\d+/.test(h)) return true;
  if (/^\d+\.\d+\.\d+\.\d+\s*-\s*\d+\.\d+\.\d+\.\d+$/.test(h)) return true;
  return false;
}

export interface ProbeOptions {
  host: string;
  port: number;
  https: boolean;
  protocols?: string[];
  timeoutMs: number;
}

export async function probeHost(opts: ProbeOptions): Promise<DiscoveryCandidate[]> {
  if (looksLikeNetworkRange(opts.host)) {
    throw new AdapterError("E_UNSUPPORTED", "Host looks like a range; single host/IP only");
  }
  await assertHostAllowed(opts.host);
  const wanted = new Set((opts.protocols ?? ["openapi", "soap", "graphql"]).map((p) => p.toLowerCase()));
  const scheme = opts.https || opts.port === 443 ? "https" : "http";
  const origin = `${scheme}://${formatHost(opts.host)}:${opts.port}`;
  const jobs: Array<Promise<DiscoveryCandidate | undefined>> = [];

  if (wanted.has("openapi") || wanted.has("http")) {
    for (const path of OPENAPI_PATHS) {
      jobs.push(probeOpenApi(`${origin}${path}`, opts.timeoutMs));
    }
  }
  if (wanted.has("soap") || wanted.has("wsdl")) {
    for (const path of SOAP_PATHS) {
      jobs.push(probeSoap(`${origin}${path}`, opts.timeoutMs));
    }
  }
  if (wanted.has("graphql")) {
    for (const path of GRAPHQL_PATHS) {
      jobs.push(probeGraphql(`${origin}${path}`, opts.timeoutMs));
    }
  }
  if (wanted.has("webdav") || wanted.has("dav")) {
    for (const path of WEBDAV_PATHS) {
      jobs.push(probeWebDav(`${origin}${path === "/" ? "" : path}`, opts.timeoutMs));
    }
  }
  if (wanted.has("caldav")) {
    for (const path of ["/", "/caldav", "/calendar"]) {
      jobs.push(probeCalDav(`${origin}${path === "/" ? "" : path}`, opts.timeoutMs));
    }
  }
  if (wanted.has("carddav")) {
    for (const path of ["/", "/carddav", "/addressbook"]) {
      jobs.push(probeCardDav(`${origin}${path === "/" ? "" : path}`, opts.timeoutMs));
    }
  }

  const settled = await Promise.all(jobs);
  return settled.filter((c): c is DiscoveryCandidate => Boolean(c));
}

export { mdnsDiscover } from "./ssdp.js";

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

async function probeOpenApi(url: string, timeoutMs: number): Promise<DiscoveryCandidate | undefined> {
  const res = await get(url, timeoutMs);
  if (!res || res.status >= 400) return undefined;
  const looksJson = /json/i.test(res.contentType) || res.body.trim().startsWith("{");
  const looksYaml = /yaml|yml/i.test(res.contentType) || /^(openapi|swagger):/m.test(res.body);
  if (!looksJson && !looksYaml) return undefined;
  if (!/openapi|swagger/i.test(res.body.slice(0, 400))) return undefined;
  const title = extractTitle(res.body);
  return {
    protocol: "openapi",
    url,
    hint: "mcp_add protocol=openapi config.spec=<url>",
    status: res.status,
    contentType: res.contentType,
    title,
    confidence: title ? 0.95 : 0.9,
    config: { spec: url },
  };
}

async function probeSoap(url: string, timeoutMs: number): Promise<DiscoveryCandidate | undefined> {
  const res = await get(url, timeoutMs);
  if (!res || res.status >= 400) return undefined;
  if (!/<definitions[\s>]|<wsdl:definitions/i.test(res.body)) return undefined;
  return {
    protocol: "soap",
    url,
    hint: "mcp_add protocol=soap config.wsdl=<url>",
    status: res.status,
    contentType: res.contentType,
    confidence: 0.9,
    config: { wsdl: url },
  };
}

async function probeGraphql(url: string, timeoutMs: number): Promise<DiscoveryCandidate | undefined> {
  try {
    const res = await fetchSafe(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ __schema { queryType { name } } }" }),
      timeoutMs,
    });
    const text = await res.text();
    if (!res.ok) return undefined;
    if (!/"__schema"|queryType/.test(text)) return undefined;
    return {
      protocol: "graphql",
      url,
      hint: "mcp_add protocol=graphql config.url=<url>",
      status: res.status,
      contentType: res.headers.get("content-type") ?? undefined,
      confidence: 0.86,
      config: { url },
    };
  } catch {
    return undefined;
  }
}

async function get(
  url: string,
  timeoutMs: number,
): Promise<{ status: number; contentType: string; body: string } | undefined> {
  try {
    const res = await fetchSafe(url, { method: "GET", timeoutMs });
    const body = await res.text();
    return {
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      body: body.slice(0, 8000),
    };
  } catch {
    return undefined;
  }
}

async function probeWebDav(url: string, timeoutMs: number): Promise<DiscoveryCandidate | undefined> {
  try {
    const res = await fetchSafe(url || "/", { method: "OPTIONS", timeoutMs });
    const dav = res.headers.get("dav") ?? res.headers.get("DAV") ?? "";
    const allow = res.headers.get("allow") ?? "";
    if (!/dav|1|2/i.test(dav) && !/PROPFIND|MKCOL/i.test(allow)) return undefined;
    return {
      protocol: "webdav",
      url,
      hint: "mcp_add protocol=webdav config.url=<url> config.allowWrite=false",
      status: res.status,
      title: "WebDAV",
      confidence: 0.88,
      config: { url, allowWrite: false },
    };
  } catch {
    return undefined;
  }
}

async function probeCardDav(url: string, timeoutMs: number): Promise<DiscoveryCandidate | undefined> {
  try {
    const res = await fetchSafe(url || "/", { method: "OPTIONS", timeoutMs });
    const dav = res.headers.get("dav") ?? "";
    if (!/addressbook/i.test(dav)) return undefined;
    return {
      protocol: "carddav",
      url,
      hint: "mcp_add protocol=carddav config.url=<url> config.allowWrite=false",
      status: res.status,
      title: "CardDAV",
      confidence: 0.9,
      config: { url, allowWrite: false },
    };
  } catch {
    return undefined;
  }
}

async function probeCalDav(url: string, timeoutMs: number): Promise<DiscoveryCandidate | undefined> {
  try {
    const res = await fetchSafe(url || "/", { method: "OPTIONS", timeoutMs });
    const dav = res.headers.get("dav") ?? "";
    if (!/calendar-access/i.test(dav)) return undefined;
    return {
      protocol: "caldav",
      url,
      hint: "mcp_add protocol=caldav config.url=<url> config.allowWrite=false",
      status: res.status,
      title: "CalDAV",
      confidence: 0.9,
      config: { url, allowWrite: false },
    };
  } catch {
    return undefined;
  }
}

function extractTitle(body: string): string | undefined {
  try {
    const json = JSON.parse(body) as { info?: { title?: string } };
    return json.info?.title;
  } catch {
    const m = body.match(/title:\s*["']?(.+)/);
    return m?.[1]?.trim();
  }
}
