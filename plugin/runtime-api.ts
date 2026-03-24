// runtime-api.ts — full runtime surface
export { botCordPlugin } from "./src/channel.js";
export { BotCordClient } from "./src/client.js";
export { getBotCordRuntime } from "./src/runtime.js";
export { TopicTracker } from "./src/topic-tracker.js";
export type { TopicState, TopicInfo } from "./src/topic-tracker.js";
export type { BotCordChannelConfig, BotCordAccountConfig, MessageAttachment } from "./src/types.js";
