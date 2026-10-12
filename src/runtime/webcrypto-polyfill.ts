/** Node 18: ensure global Web Crypto for deps that expect Crypto / crypto.subtle. */
import { webcrypto } from "node:crypto";

export function ensureWebCrypto(): void {
  if (typeof globalThis.crypto === "undefined" && webcrypto) {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true, writable: true });
  }
  if (typeof (globalThis as { Crypto?: unknown }).Crypto === "undefined" && webcrypto?.constructor) {
    Object.defineProperty(globalThis, "Crypto", {
      value: webcrypto.constructor,
      configurable: true,
      writable: true,
    });
  }
}

ensureWebCrypto();