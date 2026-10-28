# BotCord 组件使用清单

由 `cd frontend && node scripts/audit-ui-components.mjs` 生成。扫描非测试 TS/TSX 静态 import、re-export 和 JSX，不计动态拼装的组件名。

共 265 个 TSX 文件、221 个组件模块，其中 UI 组件库 57 个模块。

“预览可达”表示从 /design 或根布局的 ConfirmDialog / Toaster 宿主可达，不代表全部业务状态均已演示。生产引用不包含 /design；兼容导出也算引用。

## 原生元素存量（不含预览页）

UI 原语内部、消息编辑器和业务交互中的原生元素是合法实现；这些计数不能直接等同于违规数量。

| 元素 | 出现次数 | 文件数 |
|---|---:|---:|
| button | 28 | 17 |
| details | 1 | 1 |
| input | 5 | 5 |
| select | 1 | 1 |
| table | 2 | 2 |
| textarea | 1 | 1 |

## 业务界面原生控件例外

业务接口中的 button/input/textarea/select/table/dialog/details 由 ui-migration.test.ts 防止回退。隐藏原生文件选择器保留浏览器文件访问语义；布局容器、文本链接、图解与专业消息结构不按原生控件违规计数。

| 文件与元素 | 数量 |
|---|---:|
| components/dashboard/MessageComposer.tsx · input | 1 |

## 组件库

| 模块 | 生产引用文件数 | 预览可达 |
|---|---:|---|
| [components/ui/AgentReactionStrip.tsx](../../../frontend/src/components/ui/AgentReactionStrip.tsx) | 1 | 是 |
| [components/ui/AgentResponseAvatar.tsx](../../../frontend/src/components/ui/AgentResponseAvatar.tsx) | 2 | 是 |
| [components/ui/Alert.tsx](../../../frontend/src/components/ui/Alert.tsx) | 63 | 是 |
| [components/ui/AttachmentItem.tsx](../../../frontend/src/components/ui/AttachmentItem.tsx) | 5 | 是 |
| [components/ui/Avatar.tsx](../../../frontend/src/components/ui/Avatar.tsx) | 18 | 是 |
| [components/ui/Badge.tsx](../../../frontend/src/components/ui/Badge.tsx) | 55 | 是 |
| [components/ui/BotCordLoader.tsx](../../../frontend/src/components/ui/BotCordLoader.tsx) | 40 | 是 |
| [components/ui/BrandMark.tsx](../../../frontend/src/components/ui/BrandMark.tsx) | 6 | 是 |
| [components/ui/Button.tsx](../../../frontend/src/components/ui/Button.tsx) | 108 | 是 |
| [components/ui/Card.tsx](../../../frontend/src/components/ui/Card.tsx) | 78 | 是 |
| [components/ui/Checkbox.tsx](../../../frontend/src/components/ui/Checkbox.tsx) | 9 | 是 |
| [components/ui/Chip.tsx](../../../frontend/src/components/ui/Chip.tsx) | 2 | 是 |
| [components/ui/ChoiceCard.tsx](../../../frontend/src/components/ui/ChoiceCard.tsx) | 2 | 是 |
| [components/ui/ConfirmDialog.tsx](../../../frontend/src/components/ui/ConfirmDialog.tsx) | 1 | 是 |
| [components/ui/CopyableId.tsx](../../../frontend/src/components/ui/CopyableId.tsx) | 7 | 是 |
| [components/ui/CordField.tsx](../../../frontend/src/components/ui/CordField.tsx) | 4 | 是 |
| [components/ui/DialogShell.tsx](../../../frontend/src/components/ui/DialogShell.tsx) | 19 | 是 |
| [components/ui/DialogSurface.tsx](../../../frontend/src/components/ui/DialogSurface.tsx) | 28 | 是 |
| [components/ui/Disclosure.tsx](../../../frontend/src/components/ui/Disclosure.tsx) | 5 | 是 |
| [components/ui/DismissLayer.tsx](../../../frontend/src/components/ui/DismissLayer.tsx) | 3 | 是 |
| [components/ui/DrawerShell.tsx](../../../frontend/src/components/ui/DrawerShell.tsx) | 1 | 是 |
| [components/ui/EmptyState.tsx](../../../frontend/src/components/ui/EmptyState.tsx) | 29 | 是 |
| [components/ui/Field.tsx](../../../frontend/src/components/ui/Field.tsx) | 21 | 是 |
| [components/ui/IconButton.tsx](../../../frontend/src/components/ui/IconButton.tsx) | 52 | 是 |
| [components/ui/IconTile.tsx](../../../frontend/src/components/ui/IconTile.tsx) | 4 | 是 |
| [components/ui/ImagePreviewOverlay.tsx](../../../frontend/src/components/ui/ImagePreviewOverlay.tsx) | 4 | 是 |
| [components/ui/Input.tsx](../../../frontend/src/components/ui/Input.tsx) | 38 | 是 |
| [components/ui/LinkButton.tsx](../../../frontend/src/components/ui/LinkButton.tsx) | 10 | 是 |
| [components/ui/ListGroup.tsx](../../../frontend/src/components/ui/ListGroup.tsx) | 2 | 是 |
| [components/ui/MarkdownContent.tsx](../../../frontend/src/components/ui/MarkdownContent.tsx) | 8 | 是 |
| [components/ui/MarketingButton.tsx](../../../frontend/src/components/ui/MarketingButton.tsx) | 4 | 是 |
| [components/ui/MarketingCard.tsx](../../../frontend/src/components/ui/MarketingCard.tsx) | 3 | 是 |
| [components/ui/Menu.tsx](../../../frontend/src/components/ui/Menu.tsx) | 3 | 是 |
| [components/ui/MessageActionPopover.tsx](../../../frontend/src/components/ui/MessageActionPopover.tsx) | 1 | 是 |
| [components/ui/MetricCard.tsx](../../../frontend/src/components/ui/MetricCard.tsx) | 2 | 是 |
| [components/ui/MultiSelect.tsx](../../../frontend/src/components/ui/MultiSelect.tsx) | 1 | 是 |
| [components/ui/NodeCordStatus.tsx](../../../frontend/src/components/ui/NodeCordStatus.tsx) | 0 | 是 |
| [components/ui/PageHeader.tsx](../../../frontend/src/components/ui/PageHeader.tsx) | 2 | 是 |
| [components/ui/PresenceIndicator.tsx](../../../frontend/src/components/ui/PresenceIndicator.tsx) | 2 | 是 |
| [components/ui/Radio.tsx](../../../frontend/src/components/ui/Radio.tsx) | 8 | 是 |
| [components/ui/ReactionPanel.tsx](../../../frontend/src/components/ui/ReactionPanel.tsx) | 1 | 是 |
| [components/ui/SearchInput.tsx](../../../frontend/src/components/ui/SearchInput.tsx) | 3 | 是 |
| [components/ui/SectionHeading.tsx](../../../frontend/src/components/ui/SectionHeading.tsx) | 5 | 是 |
| [components/ui/Select.tsx](../../../frontend/src/components/ui/Select.tsx) | 6 | 是 |
| [components/ui/SignalDot.tsx](../../../frontend/src/components/ui/SignalDot.tsx) | 3 | 是 |
| [components/ui/SingleSelect.tsx](../../../frontend/src/components/ui/SingleSelect.tsx) | 3 | 是 |
| [components/ui/Skeleton.tsx](../../../frontend/src/components/ui/Skeleton.tsx) | 9 | 是 |
| [components/ui/StatusCapsule.tsx](../../../frontend/src/components/ui/StatusCapsule.tsx) | 2 | 是 |
| [components/ui/SwipeableRow.tsx](../../../frontend/src/components/ui/SwipeableRow.tsx) | 1 | 是 |
| [components/ui/Switch.tsx](../../../frontend/src/components/ui/Switch.tsx) | 2 | 是 |
| [components/ui/SystemMessageNotice.tsx](../../../frontend/src/components/ui/SystemMessageNotice.tsx) | 2 | 是 |
| [components/ui/Table.tsx](../../../frontend/src/components/ui/Table.tsx) | 4 | 是 |
| [components/ui/Tabs.tsx](../../../frontend/src/components/ui/Tabs.tsx) | 15 | 是 |
| [components/ui/Toast.tsx](../../../frontend/src/components/ui/Toast.tsx) | 2 | 是 |
| [components/ui/Tooltip.tsx](../../../frontend/src/components/ui/Tooltip.tsx) | 3 | 是 |
| [components/ui/TypewriterCode.tsx](../../../frontend/src/components/ui/TypewriterCode.tsx) | 1 | 是 |
| [components/ui/UnreadBadge.tsx](../../../frontend/src/components/ui/UnreadBadge.tsx) | 4 | 是 |

## 业务与页面组合组件

| 模块 | 生产引用文件数 | 预览可达 |
|---|---:|---|
| [components/admin/AdminCodesPage.tsx](../../../frontend/src/components/admin/AdminCodesPage.tsx) | 0 | 否 |
| [components/admin/AdminWaitlistPage.tsx](../../../frontend/src/components/admin/AdminWaitlistPage.tsx) | 0 | 否 |
| [components/analytics/GoogleAnalytics.tsx](../../../frontend/src/components/analytics/GoogleAnalytics.tsx) | 1 | 是 |
| [components/auth/LoginPage.tsx](../../../frontend/src/components/auth/LoginPage.tsx) | 0 | 否 |
| [components/claim/ClaimAgentPage.tsx](../../../frontend/src/components/claim/ClaimAgentPage.tsx) | 1 | 否 |
| [components/daemon/ActivatePage.tsx](../../../frontend/src/components/daemon/ActivatePage.tsx) | 0 | 否 |
| [components/daemon/DaemonInstallCommand.tsx](../../../frontend/src/components/daemon/DaemonInstallCommand.tsx) | 5 | 否 |
| [components/daemon/DaemonsSettingsPage.tsx](../../../frontend/src/components/daemon/DaemonsSettingsPage.tsx) | 0 | 否 |
| [components/dashboard/AccountMenu.tsx](../../../frontend/src/components/dashboard/AccountMenu.tsx) | 1 | 否 |
| [components/dashboard/ActivityPanel.tsx](../../../frontend/src/components/dashboard/ActivityPanel.tsx) | 1 | 否 |
| [components/dashboard/AddDeviceDialog.tsx](../../../frontend/src/components/dashboard/AddDeviceDialog.tsx) | 2 | 否 |
| [components/dashboard/AddFriendModal.tsx](../../../frontend/src/components/dashboard/AddFriendModal.tsx) | 1 | 否 |
| [components/dashboard/AddRoomMemberModal.tsx](../../../frontend/src/components/dashboard/AddRoomMemberModal.tsx) | 3 | 否 |
| [components/dashboard/AgentAvatarPicker.tsx](../../../frontend/src/components/dashboard/AgentAvatarPicker.tsx) | 2 | 否 |
| [components/dashboard/AgentBrowser.tsx](../../../frontend/src/components/dashboard/AgentBrowser.tsx) | 1 | 否 |
| [components/dashboard/AgentCapabilityCard.tsx](../../../frontend/src/components/dashboard/AgentCapabilityCard.tsx) | 1 | 否 |
| [components/dashboard/AgentCardModal.tsx](../../../frontend/src/components/dashboard/AgentCardModal.tsx) | 1 | 否 |
| [components/dashboard/AgentChannelsTab.tsx](../../../frontend/src/components/dashboard/AgentChannelsTab.tsx) | 2 | 否 |
| [components/dashboard/AgentDefaultPermission.tsx](../../../frontend/src/components/dashboard/AgentDefaultPermission.tsx) | 2 | 否 |
| [components/dashboard/AgentGateModal.tsx](../../../frontend/src/components/dashboard/AgentGateModal.tsx) | 1 | 否 |
| [components/dashboard/AgentProfileEditModal.tsx](../../../frontend/src/components/dashboard/AgentProfileEditModal.tsx) | 0 | 否 |
| [components/dashboard/AgentRequiredState.tsx](../../../frontend/src/components/dashboard/AgentRequiredState.tsx) | 0 | 否 |
| [components/dashboard/AgentSchedulesTab.tsx](../../../frontend/src/components/dashboard/AgentSchedulesTab.tsx) | 2 | 否 |
| [components/dashboard/AgentSettingsDrawer.tsx](../../../frontend/src/components/dashboard/AgentSettingsDrawer.tsx) | 1 | 否 |
| [components/dashboard/AgentSkillsTab.tsx](../../../frontend/src/components/dashboard/AgentSkillsTab.tsx) | 2 | 否 |
| [components/dashboard/BotAvatar.tsx](../../../frontend/src/components/dashboard/BotAvatar.tsx) | 14 | 否 |
| [components/dashboard/BotDetailDrawer.tsx](../../../frontend/src/components/dashboard/BotDetailDrawer.tsx) | 1 | 否 |
| [components/dashboard/BotRuntimeCapabilitiesPanel.tsx](../../../frontend/src/components/dashboard/BotRuntimeCapabilitiesPanel.tsx) | 2 | 否 |
| [components/dashboard/BotWalletTab.tsx](../../../frontend/src/components/dashboard/BotWalletTab.tsx) | 1 | 否 |
| [components/dashboard/ChatMarkdown.tsx](../../../frontend/src/components/dashboard/ChatMarkdown.tsx) | 2 | 否 |
| [components/dashboard/ChatPane.tsx](../../../frontend/src/components/dashboard/ChatPane.tsx) | 1 | 否 |
| [components/dashboard/ComposerPopover.tsx](../../../frontend/src/components/dashboard/ComposerPopover.tsx) | 2 | 否 |
| [components/dashboard/CompositeAvatar.tsx](../../../frontend/src/components/dashboard/CompositeAvatar.tsx) | 4 | 否 |
| [components/dashboard/ContactList.tsx](../../../frontend/src/components/dashboard/ContactList.tsx) | 0 | 否 |
| [components/dashboard/ContactRequestsInbox.tsx](../../../frontend/src/components/dashboard/ContactRequestsInbox.tsx) | 2 | 否 |
| [components/dashboard/ContactsDetailPane.tsx](../../../frontend/src/components/dashboard/ContactsDetailPane.tsx) | 1 | 否 |
| [components/dashboard/CreateAgentDialog.tsx](../../../frontend/src/components/dashboard/CreateAgentDialog.tsx) | 2 | 否 |
| [components/dashboard/CreateRoomModal.tsx](../../../frontend/src/components/dashboard/CreateRoomModal.tsx) | 2 | 否 |
| [components/dashboard/CredentialResetDialog.tsx](../../../frontend/src/components/dashboard/CredentialResetDialog.tsx) | 0 | 否 |
| [components/dashboard/DMSettingsModal.tsx](../../../frontend/src/components/dashboard/DMSettingsModal.tsx) | 1 | 否 |
| [components/dashboard/DashboardApp.tsx](../../../frontend/src/components/dashboard/DashboardApp.tsx) | 0 | 否 |
| [components/dashboard/DashboardMessagePaneSkeleton.tsx](../../../frontend/src/components/dashboard/DashboardMessagePaneSkeleton.tsx) | 6 | 否 |
| [components/dashboard/DashboardMultiSelect.tsx](../../../frontend/src/components/dashboard/DashboardMultiSelect.tsx) | 3 | 否 |
| [components/dashboard/DashboardOverlayPortal.tsx](../../../frontend/src/components/dashboard/DashboardOverlayPortal.tsx) | 45 | 是 |
| [components/dashboard/DashboardSelect.tsx](../../../frontend/src/components/dashboard/DashboardSelect.tsx) | 8 | 否 |
| [components/dashboard/DashboardShellSkeleton.tsx](../../../frontend/src/components/dashboard/DashboardShellSkeleton.tsx) | 2 | 否 |
| [components/dashboard/DashboardTabSkeleton.tsx](../../../frontend/src/components/dashboard/DashboardTabSkeleton.tsx) | 5 | 否 |
| [components/dashboard/DeviceDetailDrawer.tsx](../../../frontend/src/components/dashboard/DeviceDetailDrawer.tsx) | 1 | 否 |
| [components/dashboard/DiscoverRoomList.tsx](../../../frontend/src/components/dashboard/DiscoverRoomList.tsx) | 0 | 否 |
| [components/dashboard/DocumentPreviewPane.tsx](../../../frontend/src/components/dashboard/DocumentPreviewPane.tsx) | 2 | 否 |
| [components/dashboard/ExploreEntityCard.tsx](../../../frontend/src/components/dashboard/ExploreEntityCard.tsx) | 2 | 否 |
| [components/dashboard/ForwardModal.tsx](../../../frontend/src/components/dashboard/ForwardModal.tsx) | 4 | 否 |
| [components/dashboard/FriendInviteModal.tsx](../../../frontend/src/components/dashboard/FriendInviteModal.tsx) | 1 | 否 |
| [components/dashboard/HomePanel.tsx](../../../frontend/src/components/dashboard/HomePanel.tsx) | 4 | 否 |
| [components/dashboard/HumanCardModal.tsx](../../../frontend/src/components/dashboard/HumanCardModal.tsx) | 1 | 否 |
| [components/dashboard/HumanProfileEditModal.tsx](../../../frontend/src/components/dashboard/HumanProfileEditModal.tsx) | 1 | 否 |
| [components/dashboard/InstallCommandPanel.tsx](../../../frontend/src/components/dashboard/InstallCommandPanel.tsx) | 1 | 否 |
| [components/dashboard/InviteOthersGuide.tsx](../../../frontend/src/components/dashboard/InviteOthersGuide.tsx) | 0 | 否 |
| [components/dashboard/JoinRequestsPanel.tsx](../../../frontend/src/components/dashboard/JoinRequestsPanel.tsx) | 1 | 否 |
| [components/dashboard/LedgerList.tsx](../../../frontend/src/components/dashboard/LedgerList.tsx) | 0 | 否 |
| [components/dashboard/LoginPanel.tsx](../../../frontend/src/components/dashboard/LoginPanel.tsx) | 0 | 否 |
| [components/dashboard/MemberActionsMenu.tsx](../../../frontend/src/components/dashboard/MemberActionsMenu.tsx) | 2 | 否 |
| [components/dashboard/MentionChip.tsx](../../../frontend/src/components/dashboard/MentionChip.tsx) | 2 | 否 |
| [components/dashboard/MessageBubble.tsx](../../../frontend/src/components/dashboard/MessageBubble.tsx) | 2 | 否 |
| [components/dashboard/MessageComposer.tsx](../../../frontend/src/components/dashboard/MessageComposer.tsx) | 3 | 否 |
| [components/dashboard/MessageHistoryControl.tsx](../../../frontend/src/components/dashboard/MessageHistoryControl.tsx) | 2 | 否 |
| [components/dashboard/MessageList.tsx](../../../frontend/src/components/dashboard/MessageList.tsx) | 2 | 否 |
| [components/dashboard/MyBotsPanel.tsx](../../../frontend/src/components/dashboard/MyBotsPanel.tsx) | 1 | 否 |
| [components/dashboard/MyDevicesView.tsx](../../../frontend/src/components/dashboard/MyDevicesView.tsx) | 1 | 否 |
| [components/dashboard/PaidRoomPreview.tsx](../../../frontend/src/components/dashboard/PaidRoomPreview.tsx) | 1 | 否 |
| [components/dashboard/ParticipantAvatar.tsx](../../../frontend/src/components/dashboard/ParticipantAvatar.tsx) | 2 | 否 |
| [components/dashboard/PeerBotDetailDrawer.tsx](../../../frontend/src/components/dashboard/PeerBotDetailDrawer.tsx) | 1 | 否 |
| [components/dashboard/PendingApprovalsPanel.tsx](../../../frontend/src/components/dashboard/PendingApprovalsPanel.tsx) | 0 | 否 |
| [components/dashboard/PlanChangeConfirmDialog.tsx](../../../frontend/src/components/dashboard/PlanChangeConfirmDialog.tsx) | 1 | 否 |
| [components/dashboard/PresenceDot.tsx](../../../frontend/src/components/dashboard/PresenceDot.tsx) | 6 | 否 |
| [components/dashboard/PromptTemplates.tsx](../../../frontend/src/components/dashboard/PromptTemplates.tsx) | 0 | 否 |
| [components/dashboard/PublicAgentList.tsx](../../../frontend/src/components/dashboard/PublicAgentList.tsx) | 0 | 否 |
| [components/dashboard/PublicRoomList.tsx](../../../frontend/src/components/dashboard/PublicRoomList.tsx) | 0 | 否 |
| [components/dashboard/ReplyQuoteBlock.tsx](../../../frontend/src/components/dashboard/ReplyQuoteBlock.tsx) | 2 | 否 |
| [components/dashboard/RoomHeader.tsx](../../../frontend/src/components/dashboard/RoomHeader.tsx) | 2 | 否 |
| [components/dashboard/RoomHumanComposer.tsx](../../../frontend/src/components/dashboard/RoomHumanComposer.tsx) | 3 | 否 |
| [components/dashboard/RoomList.tsx](../../../frontend/src/components/dashboard/RoomList.tsx) | 2 | 否 |
| [components/dashboard/RoomMemberSettingsModal.tsx](../../../frontend/src/components/dashboard/RoomMemberSettingsModal.tsx) | 0 | 否 |
| [components/dashboard/RoomPolicyModal.tsx](../../../frontend/src/components/dashboard/RoomPolicyModal.tsx) | 1 | 否 |
| [components/dashboard/RoomSettingsModal.tsx](../../../frontend/src/components/dashboard/RoomSettingsModal.tsx) | 1 | 否 |
| [components/dashboard/RoomZeroState.tsx](../../../frontend/src/components/dashboard/RoomZeroState.tsx) | 2 | 否 |
| [components/dashboard/RuntimeErrorDetailsDialog.tsx](../../../frontend/src/components/dashboard/RuntimeErrorDetailsDialog.tsx) | 2 | 否 |
| [components/dashboard/SearchBar.tsx](../../../frontend/src/components/dashboard/SearchBar.tsx) | 3 | 否 |
| [components/dashboard/SettingsModal.tsx](../../../frontend/src/components/dashboard/SettingsModal.tsx) | 0 | 否 |
| [components/dashboard/ShareModal.tsx](../../../frontend/src/components/dashboard/ShareModal.tsx) | 1 | 否 |
| [components/dashboard/StreamBlocksView.tsx](../../../frontend/src/components/dashboard/StreamBlocksView.tsx) | 1 | 否 |
| [components/dashboard/StripeReturnBanner.tsx](../../../frontend/src/components/dashboard/StripeReturnBanner.tsx) | 1 | 否 |
| [components/dashboard/SubscriptionBadge.tsx](../../../frontend/src/components/dashboard/SubscriptionBadge.tsx) | 7 | 否 |
| [components/dashboard/ThemeToggle.tsx](../../../frontend/src/components/dashboard/ThemeToggle.tsx) | 1 | 否 |
| [components/dashboard/ToolResultContent.tsx](../../../frontend/src/components/dashboard/ToolResultContent.tsx) | 1 | 否 |
| [components/dashboard/TopicDrawer.tsx](../../../frontend/src/components/dashboard/TopicDrawer.tsx) | 1 | 否 |
| [components/dashboard/TopupDialog.tsx](../../../frontend/src/components/dashboard/TopupDialog.tsx) | 2 | 否 |
| [components/dashboard/TransferCard.tsx](../../../frontend/src/components/dashboard/TransferCard.tsx) | 2 | 否 |
| [components/dashboard/TransferDialog.tsx](../../../frontend/src/components/dashboard/TransferDialog.tsx) | 2 | 否 |
| [components/dashboard/TransferOwnershipDialog.tsx](../../../frontend/src/components/dashboard/TransferOwnershipDialog.tsx) | 2 | 否 |
| [components/dashboard/UnbindAgentDialog.tsx](../../../frontend/src/components/dashboard/UnbindAgentDialog.tsx) | 2 | 否 |
| [components/dashboard/UserChatPane.tsx](../../../frontend/src/components/dashboard/UserChatPane.tsx) | 1 | 否 |
| [components/dashboard/WalletAccountSelector.tsx](../../../frontend/src/components/dashboard/WalletAccountSelector.tsx) | 2 | 否 |
| [components/dashboard/WalletPanel.tsx](../../../frontend/src/components/dashboard/WalletPanel.tsx) | 1 | 否 |
| [components/dashboard/WithdrawDialog.tsx](../../../frontend/src/components/dashboard/WithdrawDialog.tsx) | 2 | 否 |
| [components/dashboard/WorkspaceModeSwitch.tsx](../../../frontend/src/components/dashboard/WorkspaceModeSwitch.tsx) | 2 | 否 |
| [components/dashboard/sidebar/BotsPanel.tsx](../../../frontend/src/components/dashboard/sidebar/BotsPanel.tsx) | 1 | 否 |
| [components/dashboard/sidebar/ContactsPanel.tsx](../../../frontend/src/components/dashboard/sidebar/ContactsPanel.tsx) | 1 | 否 |
| [components/dashboard/sidebar/DeviceSettingsModal.tsx](../../../frontend/src/components/dashboard/sidebar/DeviceSettingsModal.tsx) | 1 | 否 |
| [components/dashboard/sidebar/MessagesBotScopeDropdown.tsx](../../../frontend/src/components/dashboard/sidebar/MessagesBotScopeDropdown.tsx) | 1 | 否 |
| [components/dashboard/sidebar/MessagesGroupingSidebar.tsx](../../../frontend/src/components/dashboard/sidebar/MessagesGroupingSidebar.tsx) | 2 | 否 |
| [components/dashboard/sidebar/MessagesPanel.tsx](../../../frontend/src/components/dashboard/sidebar/MessagesPanel.tsx) | 1 | 否 |
| [components/dashboard/sidebar/NavButtons.tsx](../../../frontend/src/components/dashboard/sidebar/NavButtons.tsx) | 1 | 否 |
| [components/dashboard/sidebar/index.tsx](../../../frontend/src/components/dashboard/sidebar/index.tsx) | 1 | 否 |
| [components/home/AgentScenariosSection.tsx](../../../frontend/src/components/home/AgentScenariosSection.tsx) | 1 | 否 |
| [components/home/CTASection.tsx](../../../frontend/src/components/home/CTASection.tsx) | 1 | 否 |
| [components/home/ConversationDemo.tsx](../../../frontend/src/components/home/ConversationDemo.tsx) | 0 | 否 |
| [components/home/CoreFeatures.tsx](../../../frontend/src/components/home/CoreFeatures.tsx) | 1 | 否 |
| [components/home/HeroRoomPreview.tsx](../../../frontend/src/components/home/HeroRoomPreview.tsx) | 1 | 否 |
| [components/home/HeroSection.tsx](../../../frontend/src/components/home/HeroSection.tsx) | 1 | 否 |
| [components/home/HomeSectionHeader.tsx](../../../frontend/src/components/home/HomeSectionHeader.tsx) | 4 | 否 |
| [components/home/HowItWorksSection.tsx](../../../frontend/src/components/home/HowItWorksSection.tsx) | 1 | 否 |
| [components/home/PlatformStats.tsx](../../../frontend/src/components/home/PlatformStats.tsx) | 1 | 否 |
| [components/home/ProtocolPreview.tsx](../../../frontend/src/components/home/ProtocolPreview.tsx) | 1 | 否 |
| [components/home/PublicRoomsSection.tsx](../../../frontend/src/components/home/PublicRoomsSection.tsx) | 1 | 否 |
| [components/home/TrustSection.tsx](../../../frontend/src/components/home/TrustSection.tsx) | 1 | 否 |
| [components/invite/InvitePage.tsx](../../../frontend/src/components/invite/InvitePage.tsx) | 0 | 否 |
| [components/layout/Footer.tsx](../../../frontend/src/components/layout/Footer.tsx) | 1 | 否 |
| [components/layout/Navbar.tsx](../../../frontend/src/components/layout/Navbar.tsx) | 1 | 否 |
| [components/protocol/DeliveryFlow.tsx](../../../frontend/src/components/protocol/DeliveryFlow.tsx) | 1 | 否 |
| [components/protocol/EnvelopeStructure.tsx](../../../frontend/src/components/protocol/EnvelopeStructure.tsx) | 1 | 否 |
| [components/protocol/PrimitivesGrid.tsx](../../../frontend/src/components/protocol/PrimitivesGrid.tsx) | 1 | 否 |
| [components/security/IdentityDerivation.tsx](../../../frontend/src/components/security/IdentityDerivation.tsx) | 1 | 否 |
| [components/security/SecurityFeatures.tsx](../../../frontend/src/components/security/SecurityFeatures.tsx) | 1 | 否 |
| [components/security/SigningViz.tsx](../../../frontend/src/components/security/SigningViz.tsx) | 1 | 否 |
| [components/security/VerificationPipeline.tsx](../../../frontend/src/components/security/VerificationPipeline.tsx) | 1 | 否 |
| [components/share/InviteLinkView.tsx](../../../frontend/src/components/share/InviteLinkView.tsx) | 1 | 否 |
| [components/share/SharedMessageBubble.tsx](../../../frontend/src/components/share/SharedMessageBubble.tsx) | 0 | 否 |
| [components/share/SharedRoomView.tsx](../../../frontend/src/components/share/SharedRoomView.tsx) | 1 | 否 |
| [components/team/AccessBadge.tsx](../../../frontend/src/components/team/AccessBadge.tsx) | 4 | 否 |
| [components/team/AccessOverviewSection.tsx](../../../frontend/src/components/team/AccessOverviewSection.tsx) | 1 | 否 |
| [components/team/AccessRequestDialog.tsx](../../../frontend/src/components/team/AccessRequestDialog.tsx) | 1 | 否 |
| [components/team/AccessRequestsInbox.tsx](../../../frontend/src/components/team/AccessRequestsInbox.tsx) | 2 | 否 |
| [components/team/AddAgentDialog.tsx](../../../frontend/src/components/team/AddAgentDialog.tsx) | 1 | 否 |
| [components/team/AgentAccessGrants.tsx](../../../frontend/src/components/team/AgentAccessGrants.tsx) | 1 | 否 |
| [components/team/AgentIdentity.tsx](../../../frontend/src/components/team/AgentIdentity.tsx) | 3 | 否 |
| [components/team/AgentManageDrawer.tsx](../../../frontend/src/components/team/AgentManageDrawer.tsx) | 1 | 否 |
| [components/team/AgentMessageReactions.tsx](../../../frontend/src/components/team/AgentMessageReactions.tsx) | 2 | 是 |
| [components/team/OrgInviteLanding.tsx](../../../frontend/src/components/team/OrgInviteLanding.tsx) | 1 | 否 |
| [components/team/OrgInviteLinks.tsx](../../../frontend/src/components/team/OrgInviteLinks.tsx) | 1 | 否 |
| [components/team/RoomReplyModeControl.tsx](../../../frontend/src/components/team/RoomReplyModeControl.tsx) | 2 | 否 |
| [components/team/TeamAgentsPage.tsx](../../../frontend/src/components/team/TeamAgentsPage.tsx) | 1 | 否 |
| [components/team/TeamConversationDialog.tsx](../../../frontend/src/components/team/TeamConversationDialog.tsx) | 1 | 否 |
| [components/team/TeamKnowledgePage.tsx](../../../frontend/src/components/team/TeamKnowledgePage.tsx) | 1 | 否 |
| [components/team/TeamMessageFeedback.tsx](../../../frontend/src/components/team/TeamMessageFeedback.tsx) | 3 | 是 |
| [components/team/TeamRoomAgentAccess.tsx](../../../frontend/src/components/team/TeamRoomAgentAccess.tsx) | 1 | 否 |
| [components/team/TeamRoomMembersDialog.tsx](../../../frontend/src/components/team/TeamRoomMembersDialog.tsx) | 1 | 否 |
| [components/team/TeamRoomPane.tsx](../../../frontend/src/components/team/TeamRoomPane.tsx) | 1 | 否 |
| [components/team/TeamSpacesPage.tsx](../../../frontend/src/components/team/TeamSpacesPage.tsx) | 2 | 否 |
| [components/team/TeamWorkspacePage.tsx](../../../frontend/src/components/team/TeamWorkspacePage.tsx) | 1 | 否 |
| [components/team/TeamWorkspaceSkeleton.tsx](../../../frontend/src/components/team/TeamWorkspaceSkeleton.tsx) | 3 | 否 |
| [components/vision/PhilosophySection.tsx](../../../frontend/src/components/vision/PhilosophySection.tsx) | 1 | 否 |
| [components/vision/RoadmapTimeline.tsx](../../../frontend/src/components/vision/RoadmapTimeline.tsx) | 1 | 否 |
| [components/vision/VisionCTA.tsx](../../../frontend/src/components/vision/VisionCTA.tsx) | 1 | 否 |
