import type { McpToolSchema } from "../../runtime/types.js";
import { AdapterError } from "../../runtime/errors.js";
import { listenJsonLoopback, NativeAppAdapter, tool } from "../native/runtime.js";

interface Chat {
  chat_id: string;
  name: string;
}

interface Msg {
  message_id: string;
  chat_id: string;
  text: string;
}

export class FeishuAdapter extends NativeAppAdapter {
  readonly protocol = "feishu";
  private chats: Chat[] = [];
  private messages: Msg[] = [];

  protected async onConnect(): Promise<void> {
    this.chats = [
      { chat_id: "oc_demo", name: "E2MCP Partner room" },
      { chat_id: "oc_ops", name: "Ops" },
    ];
    this.messages = [{ message_id: "om_1", chat_id: "oc_demo", text: "hello from simulator" }];
  }

  protected async onDisconnect(): Promise<void> {
    this.chats = [];
    this.messages = [];
  }

  async listTools(): Promise<McpToolSchema[]> {
    return [
      tool("list_chats", "Feishu/Lark IM chats (readonly list shape)", {
        properties: { query: { type: "string" } },
      }),
      tool("search_messages", "Search in-memory/local messages (readonly)", {
        properties: { query: { type: "string" }, chat_id: { type: "string" } },
      }),
      tool("send_message", "Send IM message — requires allowWrite=true", {
        write: true,
        properties: { chat_id: { type: "string" }, text: { type: "string" } },
        required: ["chat_id", "text"],
      }),
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (toolName === "list_chats") {
      if (!this.simulator && this.baseUrl) {
        const json = (await this.http("GET", "/open-apis/im/v1/chats")) as { data?: { items?: Chat[] }; items?: Chat[] };
        return { chats: json.data?.items ?? json.items ?? [] };
      }
      const q = typeof args.query === "string" ? args.query.toLowerCase() : "";
      return { chats: this.chats.filter((c) => !q || c.name.toLowerCase().includes(q) || c.chat_id.includes(q)) };
    }
    if (toolName === "search_messages") {
      if (!this.simulator && this.baseUrl) {
        const json = (await this.http("GET", "/open-apis/im/v1/messages")) as { data?: { items?: Msg[] }; items?: Msg[] };
        return { messages: json.data?.items ?? json.items ?? [] };
      }
      const q = typeof args.query === "string" ? args.query.toLowerCase() : "";
      const chat = typeof args.chat_id === "string" ? args.chat_id : "";
      return {
        messages: this.messages.filter(
          (m) => (!chat || m.chat_id === chat) && (!q || m.text.toLowerCase().includes(q)),
        ),
      };
    }
    if (toolName === "send_message") {
      this.assertWrite();
      const chat_id = this.str(args, "chat_id");
      const text = this.str(args, "text");
      if (!this.simulator && this.baseUrl) {
        return this.http("POST", "/open-apis/im/v1/messages", { chat_id, content: JSON.stringify({ text }), msg_type: "text" });
      }
      const row: Msg = { message_id: `om_${this.messages.length + 1}`, chat_id, text };
      this.messages.push(row);
      return { ok: true, message: row };
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown tool ${toolName}`, { protocol: this.protocol });
  }
}

export async function listenFeishuLoopback(): Promise<{ port: number; close: () => Promise<void> }> {
  const chats = [{ chat_id: "oc_http", name: "HTTP loopback" }];
  const messages: Msg[] = [];
  return listenJsonLoopback(async ({ method, pathname, body }) => {
    if (method === "GET" && pathname === "/open-apis/im/v1/chats") return { body: { data: { items: chats } } };
    if (method === "GET" && pathname === "/open-apis/im/v1/messages") return { body: { data: { items: messages } } };
    if (method === "POST" && pathname === "/open-apis/im/v1/messages") {
      const b = (body ?? {}) as Record<string, unknown>;
      const row: Msg = {
        message_id: `om_h_${messages.length + 1}`,
        chat_id: String(b.chat_id ?? ""),
        text: String(b.content ?? b.text ?? ""),
      };
      messages.push(row);
      return { body: { data: row } };
    }
    return { status: 404, body: {} };
  });
}
