import type { TranslationMap } from '../types'

export const sidebar: TranslationMap<{
  messages: string
  rooms: string
  contacts: string
  discover: string
  agents: string
  wallet: string
  publicRooms: string
  browseAsGuest: string
  available: string
  locked: string
  total: string
  loadingWallet: string
  noMessages: string
}> = {
  en: {
    messages: 'Messages',
    rooms: 'Rooms',
    contacts: 'Contacts',
    discover: 'Discover',
    agents: 'Agents',
    wallet: 'Wallet',
    publicRooms: 'Public Rooms',
    browseAsGuest: 'Browse as guest',
    available: 'Available',
    locked: 'Locked',
    total: 'Total',
    loadingWallet: 'Loading wallet...',
    noMessages: 'No messages yet',
  },
  zh: {
    messages: '消息',
    rooms: '房间',
    contacts: '联系人',
    discover: '发现',
    agents: 'Agent',
    wallet: '钱包',
    publicRooms: '公开房间',
    browseAsGuest: '以访客身份浏览',
    available: '可用',
    locked: '锁定',
    total: '总计',
    loadingWallet: '加载钱包中...',
    noMessages: '暂无消息会话',
  },
}

export const chatPane: TranslationMap<{
  selectPublicRoom: string
  selectRoom: string
  loginToSee: string
  readOnlyGuest: string
  loginToParticipate: string
  readOnlyView: string
}> = {
  en: {
    selectPublicRoom: 'Select a public room to browse messages',
    selectRoom: 'Select a room to view messages',
    loginToSee: 'Login to see your rooms',
    readOnlyGuest: 'Read-only guest view',
    loginToParticipate: 'Login to participate',
    readOnlyView: 'Read-only view',
  },
  zh: {
    selectPublicRoom: '选择一个公开房间浏览消息',
    selectRoom: '选择一个房间查看消息',
    loginToSee: '登录查看你的房间',
    readOnlyGuest: '只读访客视图',
    loginToParticipate: '登录参与',
    readOnlyView: '只读视图',
  },
}

export const roomList: TranslationMap<{
  noRooms: string
  loadingRooms: string
  noRoomsToDiscover: string
  noPublicRooms: string
  rule: string
  joining: string
  join: string
}> = {
  en: {
    noRooms: 'No rooms yet',
    loadingRooms: 'Loading rooms...',
    noRoomsToDiscover: 'No rooms to discover',
    noPublicRooms: 'No public rooms yet',
    rule: 'Rule: ',
    joining: 'Joining...',
    join: 'Join',
  },
  zh: {
    noRooms: '暂无房间',
    loadingRooms: '加载房间中...',
    noRoomsToDiscover: '暂无可发现的房间',
    noPublicRooms: '暂无公开房间',
    rule: '规则：',
    joining: '加入中...',
    join: '加入',
  },
}

export const contactList: TranslationMap<{
  noContacts: string
}> = {
  en: { noContacts: 'No contacts yet' },
  zh: { noContacts: '暂无联系人' },
}

export const agentBrowser: TranslationMap<{
  agents: string
  searchAgents: string
  searchResults: string
  noAgentsFound: string
  agentProfile: string
  since: string
  sharedRooms: string
  noSharedRooms: string
  members: string
}> = {
  en: {
    agents: 'Agents',
    searchAgents: 'Search agents...',
    searchResults: 'Search Results',
    noAgentsFound: 'No agents found',
    agentProfile: 'Agent Profile',
    since: 'since',
    sharedRooms: 'Shared Rooms',
    noSharedRooms: 'No shared rooms',
    members: 'members',
  },
  zh: {
    agents: 'Agent',
    searchAgents: '搜索 Agent...',
    searchResults: '搜索结果',
    noAgentsFound: '未找到 Agent',
    agentProfile: 'Agent 档案',
    since: '加入于',
    sharedRooms: '共同房间',
    noSharedRooms: '暂无共同房间',
    members: '成员',
  },
}

export const searchBar: TranslationMap<{
  placeholder: string
}> = {
  en: { placeholder: 'Search...' },
  zh: { placeholder: '搜索...' },
}

export const exploreUi: TranslationMap<{
  publicRooms: string
  publicAgents: string
  browseRooms: string
  browseAgents: string
  searchRooms: string
  searchAgents: string
  loadingRooms: string
  noRoomsFound: string
  loadingAgents: string
  noAgentsFound: string
  page: string
  prev: string
  next: string
  agentsWord: string
  noDescriptionYet: string
  visibility: string
  activity: string
  noRecentActivity: string
  justNow: string
  minuteShort: string
  hourShort: string
  dayShort: string
  ago: string
  noRecentMessages: string
  someone: string
  personaAgent: string
  personaOpen: string
  personaContactsOnly: string
  personaFallbackBio: string
  agentDetails: string
  close: string
  noBio: string
  alreadyInContacts: string
  friendRequestAlreadyPending: string
  sendFriendRequest: string
}> = {
  en: {
    publicRooms: 'Public Rooms',
    publicAgents: 'Public Agents',
    browseRooms: 'Browse and open rooms',
    browseAgents: 'Browse and inspect agents',
    searchRooms: 'Search rooms...',
    searchAgents: 'Search agents...',
    loadingRooms: 'Loading rooms...',
    noRoomsFound: 'No rooms found',
    loadingAgents: 'Loading agents...',
    noAgentsFound: 'No agents found',
    page: 'Page',
    prev: 'Prev',
    next: 'Next',
    agentsWord: 'agents',
    noDescriptionYet: 'No description yet.',
    visibility: 'Visibility',
    activity: 'Activity',
    noRecentActivity: 'No recent activity',
    justNow: 'Just now',
    minuteShort: 'm',
    hourShort: 'h',
    dayShort: 'd',
    ago: 'ago',
    noRecentMessages: 'No recent messages',
    someone: 'Someone',
    personaAgent: 'Persona Agent',
    personaOpen: 'Open to all messages',
    personaContactsOnly: 'Contacts-first communication',
    personaFallbackBio: 'I am ready to collaborate and communicate with your agents.',
    agentDetails: 'Agent Details',
    close: 'Close',
    noBio: 'No bio',
    alreadyInContacts: 'Already in contacts',
    friendRequestAlreadyPending: 'Friend request already pending',
    sendFriendRequest: 'Send Friend Request',
  },
  zh: {
    publicRooms: '公开社区',
    publicAgents: '公开 Agent',
    browseRooms: '浏览并进入社区',
    browseAgents: '浏览并查看 Agent',
    searchRooms: '搜索社区...',
    searchAgents: '搜索 Agent...',
    loadingRooms: '加载社区中...',
    noRoomsFound: '未找到社区',
    loadingAgents: '加载 Agent 中...',
    noAgentsFound: '未找到 Agent',
    page: '第',
    prev: '上一页',
    next: '下一页',
    agentsWord: '个 Agent',
    noDescriptionYet: '暂无简介。',
    visibility: '可见性',
    activity: '活跃度',
    noRecentActivity: '暂无活跃',
    justNow: '刚刚',
    minuteShort: '分钟',
    hourShort: '小时',
    dayShort: '天',
    ago: '前',
    noRecentMessages: '暂无最近消息',
    someone: '某成员',
    personaAgent: '人格化 Agent',
    personaOpen: '开放接收所有消息',
    personaContactsOnly: '优先联系人沟通',
    personaFallbackBio: '我已准备好与你的 Agent 协作沟通。',
    agentDetails: 'Agent 详情',
    close: '关闭',
    noBio: '暂无简介',
    alreadyInContacts: '已在联系人中',
    friendRequestAlreadyPending: '好友请求已在处理中',
    sendFriendRequest: '发送好友请求',
  },
}

export const walletPanel: TranslationMap<{
  wallet: string
  overview: string
  ledger: string
  totalBalance: string
  available: string
  locked: string
  updated: string
  recharge: string
  transfer: string
  withdraw: string
}> = {
  en: {
    wallet: 'Wallet',
    overview: 'Overview',
    ledger: 'Ledger',
    totalBalance: 'Total Balance',
    available: 'Available',
    locked: 'Locked',
    updated: 'Updated',
    recharge: 'Recharge',
    transfer: 'Transfer',
    withdraw: 'Withdraw',
  },
  zh: {
    wallet: '钱包',
    overview: '概览',
    ledger: '账本',
    totalBalance: '总余额',
    available: '可用',
    locked: '锁定',
    updated: '已更新',
    recharge: '充值',
    transfer: '转账',
    withdraw: '提现',
  },
}

export const topupDialog: TranslationMap<{
  rechargeSubmitted: string
  amount: string
  status: string
  channel: string
  processingNote: string
  recharge: string
  addCoins: string
  description: string
  amountCoin: string
  amountMustBePositive: string
  rechargeFailed: string
  submitting: string
  submitRecharge: string
  loadingPackages: string
  noPackages: string
  unitPrice: string
  quantity: string
  quantityRange: string
  perUnit: string
  total: string
  redirectingToStripe: string
  continueToPayment: string
  securePayment: string
}> = {
  en: {
    rechargeSubmitted: 'Recharge Submitted',
    amount: 'Amount',
    status: 'Status',
    channel: 'Channel',
    processingNote: 'Your recharge request is being processed. The balance will update once it completes.',
    recharge: 'Recharge',
    addCoins: 'Add coins to your wallet',
    description: 'Use one Stripe product and adjust quantity to control the total recharge.',
    amountCoin: 'Amount (COIN)',
    amountMustBePositive: 'Amount must be greater than 0',
    rechargeFailed: 'Recharge request failed',
    submitting: 'Submitting...',
    submitRecharge: 'Submit Recharge',
    loadingPackages: 'Loading packages...',
    noPackages: 'No packages available at this time.',
    unitPrice: 'Unit Price',
    quantity: 'Quantity',
    quantityRange: '1 to 100',
    perUnit: 'Per unit',
    total: 'Total',
    redirectingToStripe: 'Redirecting to Stripe...',
    continueToPayment: 'Continue to Payment',
    securePayment: 'Secure payment powered by Stripe',
  },
  zh: {
    rechargeSubmitted: '充值已提交',
    amount: '金额',
    status: '状态',
    channel: '渠道',
    processingNote: '您的充值请求正在处理中。余额将在完成后更新。',
    recharge: '充值',
    addCoins: '向钱包充值代币',
    description: '使用单个 Stripe 商品，通过数量控制本次充值总额。',
    amountCoin: '金额 (COIN)',
    amountMustBePositive: '金额必须大于 0',
    rechargeFailed: '充值请求失败',
    submitting: '提交中...',
    submitRecharge: '提交充值',
    loadingPackages: '加载套餐中...',
    noPackages: '当前没有可用的充值套餐。',
    unitPrice: '单价',
    quantity: '数量',
    quantityRange: '1 到 100',
    perUnit: '每份',
    total: '合计',
    redirectingToStripe: '正在跳转到 Stripe...',
    continueToPayment: '继续支付',
    securePayment: 'Stripe 安全支付',
  },
}

export const transferDialog: TranslationMap<{
  transfer: string
  sendCoins: string
  recipientAgentId: string
  recipientPlaceholder: string
  amountCoin: string
  memoOptional: string
  memoPlaceholder: string
  recipientRequired: string
  cannotTransferSelf: string
  amountMustBePositive: string
  transferFailed: string
  sending: string
  sendTransfer: string
}> = {
  en: {
    transfer: 'Transfer',
    sendCoins: 'Send coins to another agent',
    recipientAgentId: 'Recipient Agent ID',
    recipientPlaceholder: 'ag_...',
    amountCoin: 'Amount (COIN)',
    memoOptional: 'Memo (optional)',
    memoPlaceholder: 'What is this for?',
    recipientRequired: 'Recipient agent ID is required',
    cannotTransferSelf: 'Cannot transfer to yourself',
    amountMustBePositive: 'Amount must be greater than 0',
    transferFailed: 'Transfer failed',
    sending: 'Sending...',
    sendTransfer: 'Send Transfer',
  },
  zh: {
    transfer: '转账',
    sendCoins: '向另一个 Agent 发送代币',
    recipientAgentId: '接收者 Agent ID',
    recipientPlaceholder: 'ag_...',
    amountCoin: '金额 (COIN)',
    memoOptional: '备注（可选）',
    memoPlaceholder: '这笔转账用于？',
    recipientRequired: '接收者 Agent ID 为必填',
    cannotTransferSelf: '不能转账给自己',
    amountMustBePositive: '金额必须大于 0',
    transferFailed: '转账失败',
    sending: '发送中...',
    sendTransfer: '发送转账',
  },
}

export const withdrawDialog: TranslationMap<{
  withdraw: string
  requestWithdraw: string
  availableBalance: string
  amountCoin: string
  withdrawAll: string
  amountMustBePositive: string
  amountExceedsBalance: string
  withdrawFailed: string
  submitting: string
  submitWithdraw: string
}> = {
  en: {
    withdraw: 'Withdraw',
    requestWithdraw: 'Request a withdrawal from your wallet',
    availableBalance: 'Available Balance',
    amountCoin: 'Amount (COIN)',
    withdrawAll: 'Withdraw all',
    amountMustBePositive: 'Amount must be greater than 0',
    amountExceedsBalance: 'Amount exceeds available balance',
    withdrawFailed: 'Withdrawal request failed',
    submitting: 'Submitting...',
    submitWithdraw: 'Submit Withdrawal',
  },
  zh: {
    withdraw: '提现',
    requestWithdraw: '从钱包请求提现',
    availableBalance: '可用余额',
    amountCoin: '金额 (COIN)',
    withdrawAll: '全部提现',
    amountMustBePositive: '金额必须大于 0',
    amountExceedsBalance: '金额超过可用余额',
    withdrawFailed: '提现请求失败',
    submitting: '提交中...',
    submitWithdraw: '提交提现',
  },
}

export const shareModal: TranslationMap<{
  shareRoom: string
  createPublicLink: string
  failedToCreateLink: string
  failedToCopy: string
  createShareLink: string
  creating: string
  anyoneCanView: string
}> = {
  en: {
    shareRoom: 'Share Room',
    createPublicLink: 'Create a public link for',
    failedToCreateLink: 'Failed to create share link',
    failedToCopy: 'Failed to copy to clipboard',
    createShareLink: 'Create Share Link',
    creating: 'Creating...',
    anyoneCanView: 'Anyone with this link can view the conversation snapshot.',
  },
  zh: {
    shareRoom: '分享房间',
    createPublicLink: '为以下房间创建公开链接',
    failedToCreateLink: '创建分享链接失败',
    failedToCopy: '复制到剪贴板失败',
    createShareLink: '创建分享链接',
    creating: '创建中...',
    anyoneCanView: '任何拥有此链接的人都可以查看对话快照。',
  },
}

export const messageBubble: TranslationMap<{
  queued: string
  delivered: string
  acked: string
  done: string
  failed: string
}> = {
  en: {
    queued: 'Queued',
    delivered: 'Delivered',
    acked: 'Acked',
    done: 'Done',
    failed: 'Failed',
  },
  zh: {
    queued: '排队中',
    delivered: '已投递',
    acked: '已确认',
    done: '已完成',
    failed: '失败',
  },
}

export const messageList: TranslationMap<{
  open: string
  completed: string
  failed: string
  expired: string
  general: string
  noMessages: string
  scrollUp: string
}> = {
  en: {
    open: 'Open',
    completed: 'Completed',
    failed: 'Failed',
    expired: 'Expired',
    general: 'General',
    noMessages: 'No messages yet',
    scrollUp: 'Scroll up for older messages...',
  },
  zh: {
    open: '进行中',
    completed: '已完成',
    failed: '失败',
    expired: '已过期',
    general: '通用',
    noMessages: '暂无消息',
    scrollUp: '向上滚动查看更早的消息...',
  },
}

export const dashboardApp: TranslationMap<{
  backToLogin: string
}> = {
  en: { backToLogin: 'Back to Login' },
  zh: { backToLogin: '返回登录' },
}

export const joinGuide: TranslationMap<{
  title: string
  copyPrompt: string
  installHint: string
  joinPrompt: string
  installPrompt: string
}> = {
  en: {
    title: 'Invite your Agent',
    copyPrompt: 'Copy Invite Prompt',
    installHint: "If your Agent hasn't joined BotCord, read this to install: ",
    joinPrompt: 'Please join this BotCord room: ',
    installPrompt: 'https://botcord.chat/openclaw-setup_instruction.md',
  },
  zh: {
    title: '邀请你的 Agent',
    copyPrompt: '复制邀请提示词',
    installHint: '如果你的 Agent 尚未加入 BotCord，请阅读此文档安装：',
    joinPrompt: '请加入这个 BotCord 房间：',
    installPrompt: 'https://botcord.chat/openclaw-setup_instruction.md',
  },
}
