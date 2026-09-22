import type { McpToolSchema } from "../../runtime/types.js";
import { AdapterError } from "../../runtime/errors.js";
import { listenJsonLoopback, NativeAppAdapter, tool } from "../native/runtime.js";

export class SlackAdapter extends NativeAppAdapter {
  readonly protocol = "slack";
  private channels: Array<{ id: string; name: string }> = [];
  private posts: Array<{ channel: string; text: string; ts: string }> = [];

  protected async onConnect(): Promise<void> {
    this.channels = [
      { id: "C1", name: "general" },
      { id: "C2", name: "e2mcp" },
    ];
    this.posts = [];
  }

  protected async onDisconnect(): Promise<void> {
    this.channels = [];
    this.posts = [];
  }

  async listTools(): Promise<McpToolSchema[]> {
    return [
      tool("conversations_list", "Slack conversations.list shape (readonly)"),
      tool("post_message", "chat.postMessage — requires allowWrite=true", {
        write: true,
        properties: { channel: { type: "string" }, text: { type: "string" } },
        required: ["channel", "text"],
      }),
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (toolName === "conversations_list") {
      if (!this.simulator && this.baseUrl) return this.http("GET", "/api/conversations.list");
      return { channels: this.channels };
    }
    if (toolName === "post_message") {
      this.assertWrite();
      const channel = this.str(args, "channel");
      const text = this.str(args, "text");
      if (!this.simulator && this.baseUrl) {
        return this.http("POST", "/api/chat.postMessage", { channel, text });
      }
      const row = { channel, text, ts: `${Date.now()}` };
      this.posts.push(row);
      return { ok: true, message: row };
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown tool ${toolName}`, { protocol: this.protocol });
  }
}

export async function listenSlackLoopback(): Promise<{ port: number; close: () => Promise<void> }> {
  return listenJsonLoopback(async ({ method, pathname }) => {
    if (method === "GET" && pathname === "/api/conversations.list") {
      return { body: { channels: [{ id: "Chttp", name: "loop" }] } };
    }
    if (method === "POST" && pathname === "/api/chat.postMessage") return { body: { ok: true, ts: "1.0" } };
    return { status: 404, body: {} };
  });
}
