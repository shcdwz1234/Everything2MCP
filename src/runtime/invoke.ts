import { AdapterError } from "./errors.js";
import { recordAdapterInvoke } from "./metrics.js";

export interface InvokeOptions {
  /** When set and > 0, abort the invocation after this many milliseconds. */
  timeoutMs?: number;
  tool?: string;
  protocol?: string;
  adapterId?: string;
  dataDir?: string;
}

/**
 * Invocation middleware: optional timeout + AdapterError normalization + audit counts.
 * Omitting timeoutMs preserves the previous unbounded await behavior.
 */
export async function invokeWithMiddleware<T>(
  fn: () => Promise<T>,
  options: InvokeOptions = {},
): Promise<T> {
  try {
    const result =
      options.timeoutMs && options.timeoutMs > 0 ? await withTimeout(fn(), options.timeoutMs) : await fn();
    recordAdapterInvoke(true, {
      tool: options.tool,
      protocol: options.protocol,
      adapterId: options.adapterId,
      dataDir: options.dataDir,
    });
    return result;
  } catch (err) {
    const normalized = AdapterError.from(err);
    recordAdapterInvoke(false, {
      code: normalized.code,
      tool: options.tool,
      protocol: options.protocol,
      adapterId: options.adapterId,
      detail: normalized.message,
      dataDir: options.dataDir,
    });
    throw normalized;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new AdapterError("E_TIMEOUT", `Timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
