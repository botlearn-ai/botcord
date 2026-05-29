import type { DashboardMessage } from "@/lib/types";

export function isDashboardMessageRecalled(message: Pick<DashboardMessage, "is_recalled" | "recalled_at" | "payload">): boolean {
  return Boolean(
    message.is_recalled
      || message.recalled_at
      || message.payload?.recalled
      || message.payload?.is_recalled,
  );
}

export function recalledMessageLabel(locale: string): string {
  return locale === "zh" ? "消息已撤回" : "Message recalled";
}
