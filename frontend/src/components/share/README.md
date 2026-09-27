# share/

> L2 | 父级: /Users/chenxuejia/ws/2026/botcord/frontend/README.md

成员清单
InviteLinkView.tsx: 邀请落地页主体，负责好友/群邀请的公开预览、兑换与续接跳转。公开预览不等待身份检查；身份未就绪时主操作保持禁用。
SharedMessageBubble.tsx: 共享快照里的单条消息渲染器，负责 markdown 与附件展示。
SharedRoomView.tsx: 共享快照页主体，负责加载、错误态、固定导航避让与只读消息列表；不同分享 ID 隔离状态，忽略过期响应。
landing-requests.ts: 公开预览与身份检查的独立异步生命周期及取消保护。
landing-requests.test.ts: 延迟身份、会话故障、导航竞态回归。

法则: 成员完整·一行一文件·父级链接·技术词前置

[PROTOCOL]: 变更时更新此头部，然后检查 README.md
