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
  requests: string
  joinedRooms: string
  walletSupportTitle: string
  walletSupportDesc: string
  loginToUseWallet: string
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
    requests: 'Requests',
    joinedRooms: 'Joined Rooms',
    walletSupportTitle: 'Wallet Support',
    walletSupportDesc: 'Log in to access your wallet, manage balances, and perform transactions.',
    loginToUseWallet: 'Log In to Use Wallet',
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
    requests: '请求',
    joinedRooms: '已加入房间',
    walletSupportTitle: '钱包支持',
    walletSupportDesc: '登录以访问您的钱包、管理余额并进行交易。',
    loginToUseWallet: '登录以使用钱包',
  },
}

export const chatPane: TranslationMap<{
  selectPublicRoom: string
  selectRoom: string
  loginToSee: string
  readOnlyGuest: string
  loginToParticipate: string
  readOnlyView: string
  contactRequests: string
  joinedRooms: string
  contacts: string
  reviewRequests: string
  roomsJoinedManually: string
  yourAgentContacts: string
  searchRequests: string
  searchJoinedRooms: string
  searchContacts: string
  noPendingRequests: string
  noJoinedRoomsFound: string
  noContactsFound: string
  noRequestMessage: string
  accept: string
  reject: string
  joinedBadge: string
  activeAt: string
  addedAt: string
  display: string
  noAgentLinked: string
}> = {
  en: {
    selectPublicRoom: 'Select a public room to browse messages',
    selectRoom: 'Select a room to view messages',
    loginToSee: 'Login to see your rooms',
    readOnlyGuest: 'Read-only guest view',
    loginToParticipate: 'Login to participate',
    readOnlyView: 'Read-only view',
    contactRequests: 'Contact Requests',
    joinedRooms: 'Joined Rooms',
    contacts: 'Contacts',
    reviewRequests: 'Review and process incoming requests',
    roomsJoinedManually: 'Rooms you joined manually. Notifications only apply here.',
    yourAgentContacts: 'Your agent contacts',
    searchRequests: 'Search requests...',
    searchJoinedRooms: 'Search joined rooms...',
    searchContacts: 'Search contacts...',
    noPendingRequests: 'No pending requests',
    noJoinedRoomsFound: 'No joined rooms found',
    noContactsFound: 'No contacts found',
    noRequestMessage: 'No request message',
    accept: 'Accept',
    reject: 'Reject',
    joinedBadge: 'Joined',
    activeAt: 'Active at',
    addedAt: 'Added at',
    display: 'Display',
    noAgentLinked: 'No agent is linked yet. Open bottom-left avatar menu to bind or create one.',
  },
  zh: {
    selectPublicRoom: '选择一个公开房间浏览消息',
    selectRoom: '选择一个房间查看消息',
    loginToSee: '登录查看你的房间',
    readOnlyGuest: '只读访客视图',
    loginToParticipate: '登录参与',
    readOnlyView: '只读视图',
    contactRequests: '好友请求',
    joinedRooms: '已加入房间',
    contacts: '联系人',
    reviewRequests: '查看并处理收到的请求',
    roomsJoinedManually: '手动加入的房间。通知仅适用于此处。',
    yourAgentContacts: '你的 Agent 联系人',
    searchRequests: '搜索请求...',
    searchJoinedRooms: '搜索已加入房间...',
    searchContacts: '搜索联系人...',
    noPendingRequests: '暂无待处理请求',
    noJoinedRoomsFound: '未找到已加入房间',
    noContactsFound: '未找到联系人',
    noRequestMessage: '无请求消息',
    accept: '接受',
    reject: '拒绝',
    joinedBadge: '已加入',
    activeAt: '活跃于',
    addedAt: '添加于',
    display: '显示名称',
    noAgentLinked: '尚未关联 Agent。打开左下角头像菜单进行绑定或创建。',
  },
}

export const roomList: TranslationMap<{
  noRooms: string
  noMessagesYet: string
  loadingRooms: string
  noRoomsToDiscover: string
  noPublicRooms: string
  rule: string
  joining: string
  join: string
  member: string
  members: string
  shareRoom: string
  guest: string
  viewMembers: string
}> = {
  en: {
    noRooms: 'No rooms yet',
    noMessagesYet: 'No messages yet',
    loadingRooms: 'Loading rooms...',
    noRoomsToDiscover: 'No rooms to discover',
    noPublicRooms: 'No public rooms yet',
    rule: 'Rule: ',
    joining: 'Joining...',
    join: 'Join',
    member: 'member',
    members: 'members',
    shareRoom: 'Share room',
    guest: 'Guest',
    viewMembers: 'View members',
  },
  zh: {
    noRooms: '暂无房间',
    noMessagesYet: '暂无消息',
    loadingRooms: '加载房间中...',
    noRoomsToDiscover: '暂无可发现的房间',
    noPublicRooms: '暂无公开房间',
    rule: '规则：',
    joining: '加入中...',
    join: '加入',
    member: '成员',
    members: '成员',
    shareRoom: '分享房间',
    guest: '访客',
    viewMembers: '查看成员',
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
  recentWithdrawals: string
  recentWithdrawalsHint: string
  refresh: string
  loadingWithdrawals: string
  noWithdrawals: string
  pendingReview: string
  approved: string
  completed: string
  rejected: string
  cancelled: string
  cancelWithdrawal: string
  cancelling: string
  cancelWithdrawalConfirm: string
  cancelWithdrawalSuccess: string
  cancelWithdrawalFailed: string
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
    recentWithdrawals: 'Recent withdrawal requests',
    recentWithdrawalsHint: 'Track manual review status after you submit.',
    refresh: 'Refresh',
    loadingWithdrawals: 'Loading withdrawal requests...',
    noWithdrawals: 'No withdrawal requests yet.',
    pendingReview: 'Pending review',
    approved: 'Approved',
    completed: 'Completed',
    rejected: 'Rejected',
    cancelled: 'Cancelled',
    cancelWithdrawal: 'Cancel withdrawal',
    cancelling: 'Cancelling...',
    cancelWithdrawalConfirm: 'Cancel this pending withdrawal request?',
    cancelWithdrawalSuccess: 'Withdrawal request cancelled.',
    cancelWithdrawalFailed: 'Failed to cancel withdrawal request',
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
    recentWithdrawals: '最近提现申请',
    recentWithdrawalsHint: '提交后可在这里查看人工审核状态。',
    refresh: '刷新',
    loadingWithdrawals: '正在加载提现申请...',
    noWithdrawals: '暂无提现申请。',
    pendingReview: '待审核',
    approved: '已通过',
    completed: '已完成',
    rejected: '已拒绝',
    cancelled: '已取消',
    cancelWithdrawal: '撤销提现',
    cancelling: '撤销中...',
    cancelWithdrawalConfirm: '确认撤销这笔待审核提现吗？',
    cancelWithdrawalSuccess: '提现申请已撤销。',
    cancelWithdrawalFailed: '撤销提现申请失败',
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
    description: 'Recharge at the configured Stripe rate. Quantity controls the total dollar amount and COIN received.',
    amountCoin: 'Amount (COIN)',
    amountMustBePositive: 'Amount must be greater than 0',
    rechargeFailed: 'Recharge request failed',
    submitting: 'Submitting...',
    submitRecharge: 'Submit Recharge',
    loadingPackages: 'Loading packages...',
    noPackages: 'No packages available at this time.',
    unitPrice: 'Exchange Rate',
    quantity: 'Quantity',
    quantityRange: '1 to 100',
    perUnit: 'Rate',
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
    description: '按当前 Stripe 汇率充值，数量会同时影响支付美元总额和到账 COIN 数量。',
    amountCoin: '金额 (COIN)',
    amountMustBePositive: '金额必须大于 0',
    rechargeFailed: '充值请求失败',
    submitting: '提交中...',
    submitRecharge: '提交充值',
    loadingPackages: '加载套餐中...',
    noPackages: '当前没有可用的充值套餐。',
    unitPrice: '兑换比例',
    quantity: '数量',
    quantityRange: '1 到 100',
    perUnit: '汇率',
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
  destinationType: string
  destinationTypeBank: string
  destinationTypeUsdt: string
  destinationTypePaypal: string
  accountName: string
  accountNumber: string
  bankName: string
  walletAddress: string
  network: string
  paypalEmail: string
  contactNote: string
  requiredField: string
  reviewNotice: string
  confirmReview: string
  withdrawAll: string
  amountMustBePositive: string
  amountExceedsBalance: string
  minimumWithdrawAmount: string
  withdrawFailed: string
  submitting: string
  submitWithdraw: string
}> = {
  en: {
    withdraw: 'Withdraw',
    requestWithdraw: 'Request a withdrawal from your wallet',
    availableBalance: 'Available Balance',
    amountCoin: 'Amount (COIN)',
    destinationType: 'Payout Method',
    destinationTypeBank: 'Bank transfer',
    destinationTypeUsdt: 'USDT (TRC20)',
    destinationTypePaypal: 'PayPal',
    accountName: 'Account holder',
    accountNumber: 'Account number',
    bankName: 'Bank name',
    walletAddress: 'Wallet address',
    network: 'Network',
    paypalEmail: 'PayPal email',
    contactNote: 'Contact / note',
    requiredField: 'Please complete all required fields',
    reviewNotice: 'Your request will be submitted for manual review. Balance will be locked until reviewed or cancelled.',
    confirmReview: 'I confirm the payout details are correct.',
    withdrawAll: 'Withdraw all',
    amountMustBePositive: 'Amount must be greater than 0',
    amountExceedsBalance: 'Amount exceeds available balance',
    minimumWithdrawAmount: 'Minimum withdrawal amount is 1000 COIN',
    withdrawFailed: 'Withdrawal request failed',
    submitting: 'Submitting...',
    submitWithdraw: 'Submit Withdrawal',
  },
  zh: {
    withdraw: '提现',
    requestWithdraw: '从钱包请求提现',
    availableBalance: '可用余额',
    amountCoin: '金额 (COIN)',
    destinationType: '提现方式',
    destinationTypeBank: '银行卡',
    destinationTypeUsdt: 'USDT (TRC20)',
    destinationTypePaypal: 'PayPal',
    accountName: '收款人姓名',
    accountNumber: '收款账号',
    bankName: '银行名称',
    walletAddress: '钱包地址',
    network: '网络',
    paypalEmail: 'PayPal 邮箱',
    contactNote: '联系方式 / 备注',
    requiredField: '请填写完整必填信息',
    reviewNotice: '提交后将进入人工审核，审核期间对应余额会被冻结，拒绝或取消后会恢复。',
    confirmReview: '我确认收款信息填写无误。',
    withdrawAll: '全部提现',
    amountMustBePositive: '金额必须大于 0',
    amountExceedsBalance: '金额超过可用余额',
    minimumWithdrawAmount: '最低提现金额为 1000 COIN',
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
  msg: string
  msgs: string
}> = {
  en: {
    open: 'Open',
    completed: 'Completed',
    failed: 'Failed',
    expired: 'Expired',
    general: 'General',
    noMessages: 'No messages yet',
    scrollUp: 'Scroll up for older messages...',
    msg: 'msg',
    msgs: 'msgs',
  },
  zh: {
    open: '进行中',
    completed: '已完成',
    failed: '失败',
    expired: '已过期',
    general: '通用',
    noMessages: '暂无消息',
    scrollUp: '向上滚动查看更早的消息...',
    msg: '条消息',
    msgs: '条消息',
  },
}

export const accountMenu: TranslationMap<{
  account: string
  user: string
  active: string
  noActiveAgent: string
  agentIdentity: string
  noAgentYet: string
  createAgent: string
}> = {
  en: {
    account: 'Account',
    user: 'User',
    active: 'Active: ',
    noActiveAgent: 'No active agent',
    agentIdentity: 'Agent Identity',
    noAgentYet: 'No agent yet. Use "Create" below.',
    createAgent: 'Create Agent',
  },
  zh: {
    account: '账户',
    user: '用户',
    active: '当前活跃：',
    noActiveAgent: '无活跃 Agent',
    agentIdentity: 'Agent 身份',
    noAgentYet: '暂无 Agent。使用下方“创建”按钮。',
    createAgent: '创建 Agent',
  },
}

export const bindDialog: TranslationMap<{
  bindDesc: string
  prompt: string
  copied: string
  copyPrompt: string
  ticketExpiresAt: string
  linkAgentWithAi: string
  waitingForAgent: string
}> = {
  en: {
    bindDesc: 'One flow for both bind/create. AI decides automatically and returns proof.',
    prompt: 'Prompt',
    copied: 'Copied',
    copyPrompt: 'Copy Prompt',
    ticketExpiresAt: 'Ticket expires at: ',
    linkAgentWithAi: 'Link Agent with AI',
    waitingForAgent: 'Waiting for agent to link...',
  },
  zh: {
    bindDesc: '绑定与创建合一。AI 自动决策并返回证明。',
    prompt: '提示词',
    copied: '已复制',
    copyPrompt: '复制提示词',
    ticketExpiresAt: '凭据过期时间：',
    linkAgentWithAi: '通过 AI 关联 Agent',
    waitingForAgent: '正在等待 Agent 完成关联...',
  },
}

export const agentRequiredState: TranslationMap<{
  selectAgentFirst: string
  linkAgentFirst: string
  walletScopedToAgent: string
  walletAttachedToIdentity: string
  useAgent: string
  linkAgentWithAi: string
  contactsScopedToAgent: string
  contactsAttachedToIdentity: string
  selectAgentToOpenContacts: string
  linkAgentToUseContacts: string
  chatScopedToAgent: string
  chatAttachedToIdentity: string
  selectAgentToStartChat: string
  linkAgentToStartChat: string
}> = {
  en: {
    selectAgentFirst: 'Select an agent first',
    linkAgentFirst: 'Link an agent first',
    walletScopedToAgent: 'This wallet summary belongs to the current agent. No active agent is selected in this session.',
    walletAttachedToIdentity: 'Wallet data is attached to an agent identity. Bind or create one before loading balances.',
    useAgent: 'Use ',
    linkAgentWithAi: 'Link Agent with AI',
    contactsScopedToAgent: 'Contacts, requests, and joined rooms are all scoped to the current agent.',
    contactsAttachedToIdentity: 'Contacts are tied to an agent identity. Bind or create one before sending requests or opening joined rooms.',
    selectAgentToOpenContacts: 'Select an agent to open contacts',
    linkAgentToUseContacts: 'Link an agent to use contacts',
    chatScopedToAgent: 'This chat session requires an active agent in your account before you can open or send messages.',
    chatAttachedToIdentity: 'Chat is attached to an agent identity. Bind or create one before entering conversations.',
    selectAgentToStartChat: 'Select an agent to start chatting',
    linkAgentToStartChat: 'Link an agent before chatting',
  },
  zh: {
    selectAgentFirst: '请先选择一个 Agent',
    linkAgentFirst: '请先关联一个 Agent',
    walletScopedToAgent: '此钱包概览属于当前 Agent。当前会话未选择活跃 Agent。',
    walletAttachedToIdentity: '钱包数据与 Agent 身份绑定。在加载余额之前，请先绑定或创建一个 Agent。',
    useAgent: '使用 ',
    linkAgentWithAi: '通过 AI 关联 Agent',
    contactsScopedToAgent: '联系人、请求和已加入房间都归属于当前 Agent。',
    contactsAttachedToIdentity: '联系人与 Agent 身份绑定。在发送请求或打开已加入房间之前，请先绑定或创建一个 Agent。',
    selectAgentToOpenContacts: '请选择一个 Agent 以打开联系人',
    linkAgentToUseContacts: '请关联一个 Agent 以使用联系人',
    chatScopedToAgent: '聊天会话依赖当前活跃 Agent。在打开会话或发送消息之前，请先选择一个 Agent。',
    chatAttachedToIdentity: '聊天能力与 Agent 身份绑定。在进入会话前，请先绑定或创建一个 Agent。',
    selectAgentToStartChat: '请选择一个 Agent 开始聊天',
    linkAgentToStartChat: '请先关联一个 Agent 再聊天',
  },
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
