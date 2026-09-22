import type { McpToolSchema } from "../../runtime/types.js";
import { AdapterError } from "../../runtime/errors.js";
import { listenJsonLoopback, NativeAppAdapter, tool } from "../native/runtime.js";

export class WecomAdapter extends NativeAppAdapter {
  readonly protocol = "wecom";
  private depts: Array<{ id: number; name: string }> = [];
  private users: Array<{ userid: string; name: string; department: number[] }> = [];
  private sent: Array<{ touser: string; content: string }> = [];

  protected async onConnect(): Promise<void> {
    this.depts = [{ id: 1, name: "HQ" }];
    this.users = [{ userid: "zhangsan", name: "Zhang San", department: [1] }];
    this.sent = [];
  }

  protected async onDisconnect(): Promise<void> {
    this.depts = [];
    this.users = [];
    this.sent = [];
  }

  async listTools(): Promise<McpToolSchema[]> {
    return [
      tool("list_departments", "企业微信 department list (readonly shape)"),
      tool("list_users", "企业微信 user list (readonly shape)", {
        properties: { department_id: { type: "integer" } },
      }),
      tool("send_app_message", "App message send — requires allowWrite=true", {
        write: true,
        properties: { touser: { type: "string" }, content: { type: "string" } },
        required: ["touser", "content"],
      }),
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (toolName === "list_departments") {
      if (!this.simulator && this.baseUrl) return this.http("GET", "/cgi-bin/department/list");
      return { department: this.depts };
    }
    if (toolName === "list_users") {
      if (!this.simulator && this.baseUrl) return this.http("GET", "/cgi-bin/user/list");
      const dept = typeof args.department_id === "number" ? args.department_id : undefined;
      return { userlist: this.users.filter((u) => dept === undefined || u.department.includes(dept)) };
    }
    if (toolName === "send_app_message") {
      this.assertWrite();
      const touser = this.str(args, "touser");
      const content = this.str(args, "content");
      if (!this.simulator && this.baseUrl) {
        return this.http("POST", "/cgi-bin/message/send", { touser, msgtype: "text", text: { content } });
      }
      const row = { touser, content };
      this.sent.push(row);
      return { ok: true, msgid: `m-${this.sent.length}`, message: row };
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown tool ${toolName}`, { protocol: this.protocol });
  }
}

export async function listenWecomLoopback(): Promise<{ port: number; close: () => Promise<void> }> {
  return listenJsonLoopback(async ({ method, pathname }) => {
    if (method === "GET" && pathname === "/cgi-bin/department/list") return { body: { department: [{ id: 1, name: "HQ" }] } };
    if (method === "GET" && pathname === "/cgi-bin/user/list") return { body: { userlist: [{ userid: "u", name: "U" }] } };
    if (method === "POST" && pathname === "/cgi-bin/message/send") return { body: { errcode: 0, msgid: "mid" } };
    return { status: 404, body: {} };
  });
}
