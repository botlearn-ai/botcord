// setup-entry.ts — lightweight entry for onboarding/config (no heavy deps like ws)
import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { botCordPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(botCordPlugin);
