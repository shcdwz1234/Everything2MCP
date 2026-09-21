export const ERROR_CODES = [
  "E_UNKNOWN_PROTOCOL",
  "E_INVALID_CONFIG",
  "E_INVALID_ARGUMENT",
  "E_NOT_CONNECTED",
  "E_UNKNOWN_TOOL",
  "E_NOT_FOUND",
  "E_CONFLICT",
  "E_TIMEOUT",
  "E_AUTH",
  "E_UNSUPPORTED",
  "E_PROTOCOL",
  "E_BLACKLISTED",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Human-readable meaning of each unified MCP/adapter error code. See also docs/ERRORS.md. */
export const ERROR_CODE_HELP: Record<ErrorCode, string> = {
  E_UNKNOWN_PROTOCOL: "No adapter factory is registered for this protocol id",
  E_INVALID_CONFIG: "Registration config failed validation or is missing required keys",
  E_INVALID_ARGUMENT: "Tool argument is missing, the wrong type, or otherwise unusable",
  E_NOT_CONNECTED: "The tool name is not bound to a live adapter instance",
  E_UNKNOWN_TOOL: "No such MCP tool name in the catalog",
  E_NOT_FOUND: "Unknown registration id (protocol:name)",
  E_CONFLICT: "Registration id already exists",
  E_TIMEOUT: "Adapter invoke exceeded config.timeoutMs",
  E_AUTH: "Authentication failed (adapter credentials or HTTP transport token)",
  E_UNSUPPORTED: "Feature, live client library, or transport mode is not available",
  E_PROTOCOL: "Wire-protocol or backend error after a request was attempted",
  E_BLACKLISTED: "Target host/protocol is on the operator blacklist (new registrations and invoke are blocked)",
};

export interface AdapterErrorOptions {
  protocol?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class AdapterError extends Error {
  readonly code: ErrorCode;
  readonly protocol?: string;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options: AdapterErrorOptions = {}) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
    this.protocol = options.protocol;
    this.details = options.details;
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }

  toJSON(): AdapterErrorPayload {
    return {
      ok: false,
      error: this.message,
      code: this.code,
      ...(this.protocol ? { protocol: this.protocol } : {}),
      ...(this.details ? { details: this.details } : {}),
    };
  }

  static from(err: unknown, fallback: ErrorCode = "E_PROTOCOL"): AdapterError {
    if (err instanceof AdapterError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new AdapterError(guessCode(message, fallback), message);
  }
}

export interface AdapterErrorPayload {
  ok: false;
  error: string;
  code: ErrorCode;
  protocol?: string;
  details?: Record<string, unknown>;
}

export function errorPayload(err: unknown): AdapterErrorPayload {
  return AdapterError.from(err).toJSON();
}

export function fail(code: ErrorCode, message: string, options: AdapterErrorOptions = {}): never {
  throw new AdapterError(code, message, options);
}

function guessCode(message: string, fallback: ErrorCode): ErrorCode {
  if (/Unknown protocol/i.test(message)) return "E_UNKNOWN_PROTOCOL";
  if (/already exists/i.test(message)) return "E_CONFLICT";
  if (/Unknown registration/i.test(message)) return "E_NOT_FOUND";
  if (/not connected/i.test(message)) return "E_NOT_CONNECTED";
  if (/Unknown (tool|SOAP operation|OpenAPI operation|MQTT tool|gRPC|XML-RPC|JSON-RPC|FIX|NATS|CoAP|LDAP|Modbus|OPC-UA|Redis|SMTP)/i.test(message)) {
    return "E_UNKNOWN_TOOL";
  }
  if (/Timed out|timeout/i.test(message)) return "E_TIMEOUT";
  if (/Missing required|requires config|must match/i.test(message)) return "E_INVALID_CONFIG";
  if (/invalid credentials|Unauthorized|401/i.test(message)) return "E_AUTH";
  if (/not implemented|unsupported|deferred/i.test(message)) return "E_UNSUPPORTED";
  if (/blacklist/i.test(message)) return "E_BLACKLISTED";
  return fallback;
}
