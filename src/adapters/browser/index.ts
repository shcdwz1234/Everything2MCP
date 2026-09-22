import { AdapterError } from "../../runtime/errors.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { allowDesktopFrom, assertCanDesktop } from "../platform/common.js";

/**
 * Headless browser stub. Default off (allowDesktop=false).
 * Even with the gate open this v1 tool does not launch Chrome/Playwright.
 */
export class BrowserAdapter implements ProtocolAdapter {
  readonly protocol = "browser";
  private connected = false;
  private allowDesktop = false;

  constructor(readonly id: string) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    this.allowDesktop = allowDesktopFrom(config);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async listTools(): Promise<McpToolSchema[]> {
    return [
      {
        name: "navigate",
        description: "Gated stub. Default deny. Does not launch a browser even when allowDesktop=true.",
        inputSchema: {
          type: "object",
          properties: { url: { type: "string" } },
          required: ["url"],
          additionalProperties: false,
        },
      },
      {
        name: "snapshot",
        description: "Gated stub. Accessibility snapshot is not implemented.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.connected) throw new AdapterError("E_NOT_CONNECTED", "browser not connected", { protocol: this.protocol });
    if (toolName !== "navigate" && toolName !== "snapshot") {
      throw new AdapterError("E_UNKNOWN_TOOL", `Unknown tool ${toolName}`, { protocol: this.protocol });
    }
    assertCanDesktop(this.protocol, this.allowDesktop);
    throw new AdapterError(
      "E_UNSUPPORTED",
      "allowDesktop is on, but headless browser is a Phase-P5 stub and does not launch Chrome/Playwright",
      { protocol: this.protocol, details: { url: args.url } },
    );
  }

  async health(): Promise<AdapterHealth> {
    return { ok: this.connected, detail: `allowDesktop=${this.allowDesktop} stub` };
  }
}
