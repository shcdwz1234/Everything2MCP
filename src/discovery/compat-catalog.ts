export type CompatIngress = "partner" | "native" | "mcp_bridge";
export type CompatPriority = "P0" | "P1" | "P2" | "P3" | "P4";

export interface CompatApp {
  appId: string;
  displayName: string;
  ingress: CompatIngress;
  adapterProtocol: string;
  risk: "readonly" | "write" | "desktop";
  gaps: string[];
  detect: {
    binaries?: string[];
    paths?: string[];
    env?: string[];
    ports?: number[];
    configFiles?: string[];
  };
}

export const COMPAT_CATALOG: CompatApp[] = [
  {
    appId: "feishu",
    displayName: "Feishu / Lark",
    ingress: "native",
    adapterProtocol: "feishu",
    risk: "write",
    gaps: ["Full IM admin APIs, approval, calendar, and drive are out of this MVP", "Personal WeChat is not Feishu"],
    detect: {
      binaries: ["feishu", "lark", "Feishu"],
      env: ["FEISHU_APP_ID", "LARK_APP_ID"],
      ports: [],
      configFiles: [],
    },
  },
  {
    appId: "dingtalk",
    displayName: "DingTalk",
    ingress: "native",
    adapterProtocol: "dingtalk",
    risk: "write",
    gaps: ["Attendance / OA / drive not implemented", "Personal DingTalk chat is not this adapter"],
    detect: { binaries: ["dingtalk", "DingTalk"], env: ["DINGTALK_APP_KEY"] },
  },
  {
    appId: "wecom",
    displayName: "WeCom / 企业微信",
    ingress: "native",
    adapterProtocol: "wecom",
    risk: "write",
    gaps: [
      "Personal WeChat (微信) is a different product: no private-chat Partner compatibility is claimed",
      "Payment / personal QQ protocol are out of scope",
    ],
    detect: { binaries: ["wxwork", "WeCom", "wecom"], env: ["WECOM_CORP_ID", "WECHAT_WORK_CORP_ID"] },
  },
  {
    appId: "slack",
    displayName: "Slack",
    ingress: "native",
    adapterProtocol: "slack",
    risk: "write",
    gaps: ["Socket Mode / RTM not implemented", "Files and admin APIs out of MVP"],
    detect: { binaries: ["slack"], env: ["SLACK_BOT_TOKEN", "SLACK_TOKEN"] },
  },
  {
    appId: "notion",
    displayName: "Notion",
    ingress: "native",
    adapterProtocol: "notion",
    risk: "write",
    gaps: ["Database query / blocks / comments out of this MVP"],
    detect: { binaries: ["notion"], env: ["NOTION_TOKEN", "NOTION_API_KEY"] },
  },
  {
    appId: "github",
    displayName: "GitHub",
    ingress: "native",
    adapterProtocol: "github",
    risk: "write",
    gaps: ["Actions, checks, and gist APIs out of MVP", "Never talks to 169.254.169.254"],
    detect: { binaries: ["gh", "git"], env: ["GITHUB_TOKEN", "GH_TOKEN"] },
  },
  {
    appId: "personal_wechat",
    displayName: "Personal WeChat (honest non-claim)",
    ingress: "native",
    adapterProtocol: "wecom",
    risk: "desktop",
    gaps: [
      "Personal WeChat private chat is NOT a Partner-compatible integration",
      "No unofficial protocol hook is shipped",
      "Desktop UI automation is P4 deferred/gated (allowDesktop)",
    ],
    detect: { binaries: ["wechat", "WeChat"], env: [] },
  },
];

export const MCP_SERVERS_CONFIG_HINTS = [
  { kind: "cursor", rel: ".cursor/mcp.json" },
  { kind: "claude", rel: ".claude.json" },
  { kind: "vscode", rel: ".vscode/mcp.json" },
  { kind: "windsurf", rel: ".codeium/windsurf/mcp_config.json" },
];
