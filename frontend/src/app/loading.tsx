/**
 * [INPUT]: 依赖 BotCordLoadingScreen 提供 App Router 路由级等待态
 * [OUTPUT]: 对外提供全站默认 loading UI
 * [POS]: app 根级 loading 边界，在路由切换或动态片段等待时展示 BotCord 品牌动效
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { BotCordLoadingScreen } from "@/components/ui/BotCordLoader";

export default function Loading() {
  return <BotCordLoadingScreen className="min-h-screen" />;
}
