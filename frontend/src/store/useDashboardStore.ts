/**
 * [INPUT]: 依赖 useDashboardChannelStore 提供 dashboard 主域能力
 * [OUTPUT]: 对外提供 useDashboardStore 兼容导出，保持旧引用路径稳定
 * [POS]: dashboard store 迁移兼容层，避免批量改动既有业务导入
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

export { useDashboardChannelStore as useDashboardStore } from "./useDashboardChannelStore";

