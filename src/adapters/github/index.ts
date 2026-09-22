import type { McpToolSchema } from "../../runtime/types.js";
import { AdapterError } from "../../runtime/errors.js";
import { listenJsonLoopback, NativeAppAdapter, tool } from "../native/runtime.js";

interface Issue {
  number: number;
  title: string;
  state: string;
}

interface Pull {
  number: number;
  title: string;
  state: string;
}

export class GithubAdapter extends NativeAppAdapter {
  readonly protocol = "github";
  private owner = "acme";
  private repo = "e2mcp";
  private issues: Issue[] = [];
  private pulls: Pull[] = [];

  protected async onConnect(config: Record<string, unknown>): Promise<void> {
    this.owner = typeof config.owner === "string" && config.owner.trim() ? config.owner.trim() : "acme";
    this.repo = typeof config.repo === "string" && config.repo.trim() ? config.repo.trim() : "e2mcp";
    this.issues = [{ number: 1, title: "Partner protocol", state: "open" }];
    this.pulls = [{ number: 2, title: "compat scan", state: "open" }];
  }

  protected async onDisconnect(): Promise<void> {
    this.issues = [];
    this.pulls = [];
  }

  async listTools(): Promise<McpToolSchema[]> {
    return [
      tool("list_issues", "List issues (readonly)", { properties: { state: { type: "string" } } }),
      tool("list_pulls", "List pull requests (readonly)", { properties: { state: { type: "string" } } }),
      tool("create_issue", "Create issue — requires allowWrite=true", {
        write: true,
        properties: { title: { type: "string" }, body: { type: "string" } },
        required: ["title"],
      }),
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const root = `/repos/${this.owner}/${this.repo}`;
    if (toolName === "list_issues") {
      if (!this.simulator && this.baseUrl) return this.http("GET", `${root}/issues`);
      const state = typeof args.state === "string" ? args.state : "";
      return { issues: this.issues.filter((i) => !state || i.state === state) };
    }
    if (toolName === "list_pulls") {
      if (!this.simulator && this.baseUrl) return this.http("GET", `${root}/pulls`);
      const state = typeof args.state === "string" ? args.state : "";
      return { pulls: this.pulls.filter((i) => !state || i.state === state) };
    }
    if (toolName === "create_issue") {
      this.assertWrite();
      const title = this.str(args, "title");
      const body = typeof args.body === "string" ? args.body : "";
      if (!this.simulator && this.baseUrl) return this.http("POST", `${root}/issues`, { title, body });
      const row: Issue = { number: this.issues.length + 10, title, state: "open" };
      this.issues.push(row);
      return { ok: true, issue: row };
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown tool ${toolName}`, { protocol: this.protocol });
  }
}

export async function listenGithubLoopback(): Promise<{ port: number; close: () => Promise<void> }> {
  const issues: Issue[] = [{ number: 7, title: "loop", state: "open" }];
  const pulls: Pull[] = [{ number: 8, title: "pr", state: "open" }];
  return listenJsonLoopback(async ({ method, pathname, body }) => {
    if (method === "GET" && /\/issues$/.test(pathname)) return { body: issues };
    if (method === "GET" && /\/pulls$/.test(pathname)) return { body: pulls };
    if (method === "POST" && /\/issues$/.test(pathname)) {
      const b = (body ?? {}) as Record<string, unknown>;
      const row: Issue = { number: 99, title: String(b.title ?? ""), state: "open" };
      issues.push(row);
      return { body: row };
    }
    return { status: 404, body: {} };
  });
}
