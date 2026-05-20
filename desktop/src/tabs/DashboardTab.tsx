import { useEffect } from "react";
import type { DesktopConfig } from "../types";

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  const base = !trimmed
    ? "https://botcord.chat/chats"
    : /^https?:\/\//.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
  const url = new URL(base);
  if (
    (url.hostname === "botcord.chat" ||
      url.hostname === "www.botcord.chat" ||
      url.hostname === "preview.botcord.chat") &&
    url.pathname === "/"
  ) {
    url.pathname = "/chats";
  }
  return url.toString();
}

export function DashboardTab({ config }: { config: DesktopConfig }) {
  useEffect(() => {
    window.location.replace(normalizeUrl(config.dashboardUrl));
  }, [config.dashboardUrl]);

  return (
    <div className="dashboard-loading">
      <div className="spinner" />
    </div>
  );
}
