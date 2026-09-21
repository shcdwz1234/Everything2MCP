/**
 * Sole runtime → adapters edge: factories and built-in registration.
 * Leaf modules (types/errors/auth/load/log/invoke) must not import adapters.
 */
export {
  createAdapter,
  hasProtocol,
  knownProtocols,
  registerAdapterFactory,
  registerBuiltinAdapters,
} from "../adapters/index.js";
export type { AdapterFactory, ProtocolAdapter } from "../adapters/spi.js";
