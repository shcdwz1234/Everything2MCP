export function log(message: string, extra?: unknown): void {
  if (extra === undefined) {
    console.error(`[everything2mcp] ${message}`);
    return;
  }
  try {
    console.error(`[everything2mcp] ${message} ${JSON.stringify(extra)}`);
  } catch {
    console.error(`[everything2mcp] ${message}`);
  }
}
