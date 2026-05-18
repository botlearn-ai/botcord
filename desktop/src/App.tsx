import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DashboardTab } from "./tabs/DashboardTab";
import type { DesktopConfig } from "./types";

const defaultConfig: DesktopConfig = {
  daemonBin: "botcord-daemon",
  hubUrl: "https://api.botcord.chat",
  dashboardUrl: "https://botcord.chat/chats",
  label: "",
};

export function App() {
  const [config, setConfig] = useState<DesktopConfig>(defaultConfig);

  useEffect(() => {
    void invoke<DesktopConfig>("get_config")
      .then(setConfig)
      .catch(() => undefined);
  }, []);

  return (
    <main className="app-shell">
      <DashboardTab config={config} />
    </main>
  );
}
