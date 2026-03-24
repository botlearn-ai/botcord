// setup-entry.ts — lightweight entry for onboarding/config (no heavy deps like ws)
import { botCordPlugin } from "./src/channel.js";

// Inline replacement for defineSetupPluginEntry (just returns { plugin }).
export default { plugin: botCordPlugin };
