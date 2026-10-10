export { looksLikeNetworkRange, mdnsDiscover, probeHost } from "./probe.js";

export { ssdpUnicastSearch, encodeSsdpMsearch, parseSsdpResponse } from "./ssdp.js";

export {

  mdnsUnicastQuery,

  mdnsMulticastBrowse,

  encodeDnsQuery,

  decodeDnsMessage,

  encodeDnsPtrResponse,

  encodeDnsName,

  decodeDnsName,

  MDNS_PORT,

  MDNS_MULTICAST,

} from "./dnssd.js";

export type { ProbeOptions } from "./probe.js";

export { suggestFromCandidates, sanitizeName } from "./suggest.js";

export type { SuggestedRegistration } from "./suggest.js";

export { importSchema, detectKind, IMPORT_FIRST_KINDS, baseUrlFromOpenApi } from "./import.js";

export type { ImportedSchema, SchemaKind } from "./import.js";

export { scanHost, WELL_KNOWN_PORTS } from "./scan.js";

export type { ScanOptions, ScanTransports } from "./scan.js";

export { collectEnvironmentInventory, parseProcNet, parseProcAddr } from "./environment.js";

export type { EnvironmentInventory, InventoryOptions } from "./environment.js";

export { suggestFromEnvironment } from "./environment-suggest.js";

export type { EnvironmentSuggestion } from "./environment-suggest.js";

export { scanCompat, defaultDropsDir } from "./compat.js";

export type { CompatScanResult, CompatSuggestion } from "./compat.js";

export { COMPAT_CATALOG } from "./compat-catalog.js";
export {
  LOCAL_PLATFORM_PROTOCOLS,
  filterLocalPlatformSuggestions,
  isLocalPlatformProtocol,
  localCandidateId,
  localCapabilityUrl,
} from "./local-capabilities.js";
