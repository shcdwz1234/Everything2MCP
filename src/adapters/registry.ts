import { AdapterError } from "../runtime/errors.js";
import type { AdapterFactory, ProtocolAdapter } from "./spi.js";

const factories = new Map<string, AdapterFactory>();

export function registerAdapterFactory(protocol: string, factory: AdapterFactory): void {
  factories.set(protocol.toLowerCase(), factory);
}

export function createAdapter(protocol: string, id: string): ProtocolAdapter {
  const factory = factories.get(protocol.toLowerCase());
  if (!factory) {
    const known = [...factories.keys()].sort().join(", ") || "(none)";
    throw new AdapterError(
      "E_UNKNOWN_PROTOCOL",
      `Unknown protocol "${protocol}". Known adapters: ${known}`,
      { details: { known: [...factories.keys()].sort() } },
    );
  }
  return factory(id);
}

export function knownProtocols(): string[] {
  return [...factories.keys()].sort();
}

export function hasProtocol(protocol: string): boolean {
  return factories.has(protocol.toLowerCase());
}
