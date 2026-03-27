// api.ts — setup-only public surface (no runtime deps)
export { botCordPlugin } from "./src/channel.js";
export { botCordSetupAdapter } from "./src/setup-core.js";
export { botCordSetupWizard } from "./src/setup-surface.js";
export type { BotCordChannelConfig, BotCordAccountConfig } from "./src/types.js";
