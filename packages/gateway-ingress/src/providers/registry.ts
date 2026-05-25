import type { ProviderAdapterFactory } from "./types.js";
import { feishuProviderFactory } from "./feishu.js";
import { telegramProviderFactory } from "./telegram.js";
import { wechatProviderFactory } from "./wechat.js";

/**
 * Default provider factory table — the CLI seeds the `ProviderRunner`
 * with this. Tests inject a custom map to swap real providers for
 * stubs.
 */
export const DEFAULT_PROVIDER_FACTORIES: Record<string, ProviderAdapterFactory> = {
  telegram: telegramProviderFactory,
  feishu: feishuProviderFactory,
  wechat: wechatProviderFactory,
};
