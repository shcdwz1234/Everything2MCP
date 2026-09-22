/** In-process heartbeat clock for Partner adapters (Catalog still owns live tools). */
const beats = new Map<string, number>();

export function touchPartnerHeartbeat(registrationId: string, at = Date.now()): void {
  beats.set(registrationId, at);
}

export function lastPartnerHeartbeat(registrationId: string): number | undefined {
  return beats.get(registrationId);
}

export function clearPartnerHeartbeat(registrationId: string): void {
  beats.delete(registrationId);
}
