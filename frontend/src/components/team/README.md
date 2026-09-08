# team/

`TeamSpacesPage.tsx`：`/settings/spaces` 的组织治理页面，包含空间选择、组织创建、邀请与接受、用户退出/移除、个人 Agent 入组申请/审批和组织政策。沿用全站主题、中英文及确认对话框，适配窄屏布局。

选择的空间放在 URL `?space=<id>`，只控制此管理页面；不会把现有聊天或运行中的任务切换成组织上下文。数据加载由 `store/team-space-store.ts` 隔离，页面离开或空间变化时关闭未决确认。接口请求使用已登录用户身份，写操作按后端权限重新校验。

`TeamSpacesPage.test.tsx`：实际页面渲染测试，验证 owner/member/invited 状态及旧空间内容在 URL 切换时隐藏。浏览器实测与后端集成验证不能由静态渲染测试代替。
