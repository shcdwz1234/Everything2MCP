import { AdapterError } from "../../runtime/errors.js";
import { allowWriteFrom } from "../sql/common.js";

export function allowShellFrom(config: Record<string, unknown>): boolean {
  return config.allowShell === true;
}

export function allowDesktopFrom(config: Record<string, unknown>): boolean {
  return config.allowDesktop === true;
}

export function assertCanShell(protocol: string, allowShell: boolean): void {
  if (!allowShell) {
    throw new AdapterError("E_UNSUPPORTED", `${protocol} shell/exec is gated (allowShell=false)`, { protocol });
  }
}

export function assertCanDesktop(protocol: string, allowDesktop: boolean): void {
  if (!allowDesktop) {
    throw new AdapterError("E_UNSUPPORTED", `${protocol} desktop/browser is gated (allowDesktop=false)`, { protocol });
  }
}

export function assertReadonlyFs(protocol: string, allowWrite: boolean): void {
  if (allowWriteFrom({ allowWrite })) {
    throw new AdapterError(
      "E_UNSUPPORTED",
      `${protocol} filesystem adapter is read-only; allowWrite does not enable writes`,
      { protocol },
    );
  }
}

export type OsFamily = "linux" | "win32" | "darwin" | "other";

export function osFamily(plat: NodeJS.Platform = process.platform): OsFamily {
  if (plat === "linux" || plat === "win32" || plat === "darwin") return plat;
  return "other";
}
