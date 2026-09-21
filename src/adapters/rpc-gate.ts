import { assertCanWrite } from "./sql/common.js";

/**
 * Fail-closed RPC write heuristic for jsonrpc / xmlrpc / soap / grpc.
 * Only well-known read verb prefixes skip the allowWrite gate.
 * Unknown names are treated as writes.
 */
const READ_VERBS = [
  "get",
  "list",
  "read",
  "query",
  "describe",
  "find",
  "search",
  "lookup",
  "check",
  "health",
  "ping",
  "echo",
  "inspect",
  "introspect",
  "status",
  "info",
  "count",
  "exists",
  "listmethods",
  "methodhelp",
  "methodsignature",
] as const;

export function looksLikeReadRpc(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  const last = trimmed.split(/[./]/).filter(Boolean).pop() ?? trimmed;
  const bare = last.replace(/^rpc_/i, "").replace(/[^A-Za-z0-9_]/g, "");
  const lower = bare.toLowerCase();
  return READ_VERBS.some((verb) => lower === verb || lower.startsWith(verb));
}

/** Gate unless allowWrite or the method looks like a read. */
export function assertRpcCanWrite(protocol: string, allowWrite: boolean, methodName: string): void {
  if (looksLikeReadRpc(methodName)) return;
  assertCanWrite(protocol, allowWrite);
}

/** GraphQL: detect mutation/subscription operations, ignoring comments and string literals. */
export function graphqlDocumentLooksLikeWrite(doc: string): boolean {
  const stripped = doc
    .replace(/#[^\n]*/g, " ")
    .replace(/"""[\s\S]*?"""/g, " ")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
  return /(?:^|[}\s;])mutation\b/i.test(stripped) || /(?:^|[}\s;])subscription\b/i.test(stripped);
}
