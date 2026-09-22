import { AdapterError } from "../../runtime/errors.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";

export interface AwsIamHandle {
  callerIdentity(): Promise<{ account: string; arn: string; userId: string; source: string }>;
  listRoles(): Promise<string[]>;
  close(): Promise<void>;
}

export type AwsIamConnectFn = (config: Record<string, unknown>) => Promise<AwsIamHandle>;

export function createMemoryAwsIam(): AwsIamHandle {
  return {
    async callerIdentity() {
      return {
        account: "000000000000",
        arn: "arn:aws:iam::000000000000:user/e2mcp-sim",
        userId: "AIDAEXAMPLE",
        source: "simulator",
      };
    },
    async listRoles() {
      return ["e2mcp-readonly"];
    },
    async close() {
      /* mem */
    },
  };
}

/**
 * AWS IAM/STS read-only slice. Never talks to IMDS (169.254.169.254 is SSRF-blocked).
 * Live STS without an injected connectFn is E_UNSUPPORTED — no fake caller identity.
 */
export class AwsIamAdapter implements ProtocolAdapter {
  readonly protocol = "aws_iam";
  private handle: AwsIamHandle | undefined;

  constructor(
    readonly id: string,
    private readonly connectFn: AwsIamConnectFn = defaultConnect,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    this.handle = await this.connectFn(config);
  }

  async disconnect(): Promise<void> {
    await this.handle?.close();
    this.handle = undefined;
  }

  async listTools(): Promise<McpToolSchema[]> {
    return [
      {
        name: "caller_identity",
        description: "Simulator STS GetCallerIdentity. Live IMDS/STS is not called.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
      },
      {
        name: "list_roles",
        description: "Simulator IAM role names. Live ListRoles is E_UNSUPPORTED without inject.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    void args;
    if (!this.handle) throw new AdapterError("E_NOT_CONNECTED", "aws_iam not connected", { protocol: this.protocol });
    if (toolName === "caller_identity") return this.handle.callerIdentity();
    if (toolName === "list_roles") return { roles: await this.handle.listRoles() };
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown tool ${toolName}`, { protocol: this.protocol });
  }

  async health(): Promise<AdapterHealth> {
    return { ok: Boolean(this.handle), detail: "never-imds" };
  }
}

async function defaultConnect(config: Record<string, unknown>): Promise<AwsIamHandle> {
  if (config.simulator === true || config.live !== true) return createMemoryAwsIam();
  throw new AdapterError(
    "E_UNSUPPORTED",
    "aws_iam live STS/IMDS is not implemented (SSRF blocks 169.254.169.254; inject connectFn for tests)",
    { protocol: "aws_iam" },
  );
}
