import type { McpToolSchema } from "../../runtime/types.js";
import { AdapterError } from "../../runtime/errors.js";
import { listenJsonLoopback, NativeAppAdapter, tool } from "../native/runtime.js";

export class DingTalkAdapter extends NativeAppAdapter {
  readonly protocol = "dingtalk";
  private users: Array<{ userid: string; name: string }> = [];
  private notices: Array<{ id: string; userid: string; text: string }> = [];

  protected async onConnect(): Promise<void> {
    this.users = [
      { userid: "u1", name: "Ada" },
      { userid: "u2", name: "Lin" },
    ];
    this.notices = [];
  }

  protected async onDisconnect(): Promise<void> {
    this.users = [];
    this.notices = [];
  }

  async listTools(): Promise<McpToolSchema[]> {
    return [
      tool("probe", "Readonly department/user list shape (honest MVP probe)", {
        properties: { query: { type: "string" } },
      }),
      tool("send_work_notice", "Work notice send — requires allowWrite=true", {
        write: true,
        properties: { userid: { type: "string" }, text: { type: "string" } },
        required: ["userid", "text"],
      }),
      tool("send_robot", "Custom webhook robot send — requires allowWrite=true", {
        write: true,
        properties: { text: { type: "string" } },
        required: ["text"],
      }),
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (toolName === "probe") {
      if (!this.simulator && this.baseUrl) {
        return this.http("GET", "/topapi/user/listsimple");
      }
      const q = typeof args.query === "string" ? args.query.toLowerCase() : "";
      return { users: this.users.filter((u) => !q || u.name.toLowerCase().includes(q) || u.userid.includes(q)) };
    }
    if (toolName === "send_work_notice") {
      this.assertWrite();
      const userid = this.str(args, "userid");
      const text = this.str(args, "text");
      if (!this.simulator && this.baseUrl) {
        return this.http("POST", "/topapi/message/corpconversation/asyncsend_v2", { userid_list: userid, msg: { text: { content: text } } });
      }
      const row = { id: `n-${this.notices.length + 1}`, userid, text };
      this.notices.push(row);
      return { ok: true, notice: row };
    }
    if (toolName === "send_robot") {
      this.assertWrite();
      const text = this.str(args, "text");
      if (!this.simulator && this.baseUrl) {
        return this.http("POST", "/robot/send", { msgtype: "text", text: { content: text } });
      }
      return { ok: true, robot: { text } };
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown tool ${toolName}`, { protocol: this.protocol });
  }
}

export async function listenDingTalkLoopback(): Promise<{ port: number; close: () => Promise<void> }> {
  const users = [{ userid: "u-http", name: "HTTP" }];
  return listenJsonLoopback(async ({ method, pathname }) => {
    if (method === "GET" && pathname === "/topapi/user/listsimple") return { body: { useridlist: users } };
    if (method === "POST" && pathname === "/topapi/message/corpconversation/asyncsend_v2") return { body: { task_id: 1 } };
    if (method === "POST" && pathname === "/robot/send") return { body: { errcode: 0 } };
    return { status: 404, body: {} };
  });
}
