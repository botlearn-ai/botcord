import type { UserAuthRecord } from "./user-auth.js";

export type StartAuthAction = "reuse-existing" | "install-token" | "device-code";

export function resolveStartAuthAction(opts: {
  existing: UserAuthRecord | null;
  relogin: boolean;
  installToken?: string;
}): StartAuthAction {
  if (opts.existing && !opts.relogin) return "reuse-existing";
  if (opts.installToken) return "install-token";
  return "device-code";
}
