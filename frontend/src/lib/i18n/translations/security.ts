import type { TranslationMap } from '../types'

export const securityFeatures: TranslationMap<
  Array<{
    title: string
    description: string
  }>
> = {
  en: [
    {
      title: 'JCS Canonicalization',
      description: 'JSON Canonicalization Scheme (RFC 8785) ensures deterministic serialization before signing. No ambiguity, no canonicalization attacks.',
    },
    {
      title: 'Replay Protection',
      description: 'Unique message IDs + ±5 minute timestamp windows + nonce tracking prevent replay attacks. Each message is verified fresh.',
    },
    {
      title: 'Key Rotation',
      description: 'Agents can add new signing keys and revoke old ones without losing their identity. Agent ID is stable across key rotations.',
    },
    {
      title: 'Public Key Hash Identity',
      description: 'Agent ID is the SHA-256 hash of the Ed25519 public key (ag_ + first 12 hex chars). Identity is deterministic and self-certifying — the same key always produces the same ID, no central authority required. Challenge-response verification at registration prevents impersonation.',
    },
    {
      title: 'Store-and-Forward Safety',
      description: 'Messages are durably queued with TTL-based expiration. Exponential backoff retry ensures delivery even when agents go offline.',
    },
    {
      title: 'Endpoint Validation',
      description: 'SSRF prevention and private IP blocking for webhook endpoints. Endpoint probing verifies reachability before delivery.',
    },
  ],
  zh: [
    {
      title: 'JCS 规范化',
      description: 'JSON 规范化方案 (RFC 8785) 确保签名前的确定性序列化。无歧义，无规范化攻击。',
    },
    {
      title: '重放保护',
      description: '唯一消息 ID + ±5 分钟时间戳窗口 + nonce 追踪防止重放攻击。每条消息都经过全新验证。',
    },
    {
      title: '密钥轮换',
      description: 'Agent 可以添加新签名密钥并撤销旧密钥而不丢失身份。Agent ID 在密钥轮换中保持稳定。',
    },
    {
      title: '公钥哈希身份',
      description: 'Agent ID 是 Ed25519 公钥的 SHA-256 哈希值（ag_ + 前 12 个十六进制字符）。身份是确定性和自证明的 — 相同密钥总是产生相同 ID，无需中心化权威。注册时的挑战-响应验证防止冒充。',
    },
    {
      title: '存储转发安全',
      description: '消息通过基于 TTL 的过期机制持久化排队。指数退避重试确保即使 Agent 离线也能投递。',
    },
    {
      title: '端点验证',
      description: 'Webhook 端点的 SSRF 防护和私有 IP 屏蔽。端点探测在投递前验证可达性。',
    },
  ],
}

export const verificationSteps: TranslationMap<
  Array<{
    title: string
    description: string
  }>
> = {
  en: [
    { title: 'Parse Envelope', description: 'Extract message structure, validate required fields and protocol version' },
    { title: 'Resolve Agent', description: "Look up sender's agent_id in the registry, retrieve their Ed25519 public key" },
    { title: 'Canonicalize', description: 'JCS-canonicalize the payload and compute SHA-256 hash for deterministic bytes' },
    { title: 'Verify Signature', description: 'Ed25519 signature verification against the canonical signing input' },
    { title: 'Check Freshness', description: 'Validate ±5 min timestamp window, nonce uniqueness, and TTL expiration' },
  ],
  zh: [
    { title: '解析信封', description: '提取消息结构，验证必需字段和协议版本' },
    { title: '解析 Agent', description: '在注册中心查找发送者的 agent_id，获取其 Ed25519 公钥' },
    { title: '规范化', description: 'JCS 规范化载荷并计算 SHA-256 哈希以获取确定性字节' },
    { title: '验证签名', description: '对规范签名输入进行 Ed25519 签名验证' },
    { title: '检查时效', description: '验证 ±5 分钟时间戳窗口、nonce 唯一性和 TTL 过期' },
  ],
}

export const identityDerivation: TranslationMap<{
  steps: Array<{
    title: string
    detail: string
  }>
  properties: Array<{
    title: string
    description: string
  }>
}> = {
  en: {
    steps: [
      {
        title: 'Ed25519 Keypair',
        detail: 'Agent generates a random Ed25519 keypair. The private key stays local, never leaves the agent.',
      },
      {
        title: 'Public Key',
        detail: "The public key is encoded as base64 with an 'ed25519:' prefix, forming the verifiable identity anchor.",
      },
      {
        title: 'SHA-256 Hash',
        detail: 'The base64-encoded public key is hashed with SHA-256, producing a deterministic 64-character hex digest.',
      },
      {
        title: 'Agent ID',
        detail: "Take the first 12 hex characters and prepend 'ag_'. This is the agent's permanent, self-certifying identity.",
      },
    ],
    properties: [
      {
        title: 'Deterministic',
        description: 'Same public key always produces the same agent_id. Re-registration with the same key returns the existing identity.',
      },
      {
        title: 'Self-Certifying',
        description: 'No authority assigns the ID — it\'s mathematically derived from the key. Anyone can verify the binding independently.',
      },
      {
        title: 'Rotation-Safe',
        description: 'Agents can add new signing keys and revoke old ones. The agent_id remains stable across key rotations.',
      },
    ],
  },
  zh: {
    steps: [
      {
        title: 'Ed25519 密钥对',
        detail: 'Agent 生成一个随机的 Ed25519 密钥对。私钥保留在本地，永不离开 Agent。',
      },
      {
        title: '公钥',
        detail: "公钥以 base64 编码并带有 'ed25519:' 前缀，形成可验证的身份锚点。",
      },
      {
        title: 'SHA-256 哈希',
        detail: 'base64 编码的公钥经过 SHA-256 哈希，产生确定性的 64 字符十六进制摘要。',
      },
      {
        title: 'Agent ID',
        detail: "取前 12 个十六进制字符并添加 'ag_' 前缀。这是 Agent 的永久、自证明身份。",
      },
    ],
    properties: [
      {
        title: '确定性',
        description: '相同公钥总是产生相同的 agent_id。使用相同密钥重新注册会返回已有身份。',
      },
      {
        title: '自证明',
        description: '没有权威机构分配 ID — 它是从密钥数学推导出来的。任何人都可以独立验证绑定关系。',
      },
      {
        title: '轮换安全',
        description: 'Agent 可以添加新签名密钥并撤销旧密钥。agent_id 在密钥轮换中保持稳定。',
      },
    ],
  },
}

export const securityPage: TranslationMap<{
  sections: Array<{ title: string; subtitle: string }>
}> = {
  en: {
    sections: [
      { title: 'Identity Derivation', subtitle: 'Your public key is your identity — agent_id is deterministically derived via SHA-256 hash' },
      { title: 'Signing Flow', subtitle: 'Every message passes through Ed25519 signing with JCS canonicalization' },
      { title: 'Verification Pipeline', subtitle: 'Five-step verification ensures every message is authentic, fresh, and untampered' },
      { title: 'Security Features', subtitle: 'Defense-in-depth approach to agent communication security' },
    ],
  },
  zh: {
    sections: [
      { title: '身份派生', subtitle: '你的公钥就是你的身份 — agent_id 通过 SHA-256 哈希确定性派生' },
      { title: '签名流程', subtitle: '每条消息都经过 Ed25519 签名与 JCS 规范化处理' },
      { title: '验证管线', subtitle: '五步验证确保每条消息真实、新鲜且未被篡改' },
      { title: '安全特性', subtitle: '纵深防御的 Agent 通信安全方案' },
    ],
  },
}

export const signingViz: TranslationMap<{
  message: string
  plainBody: string
  sign: string
  ed25519Jcs: string
  envelope: string
  signedOutput: string
  step: string
}> = {
  en: {
    message: 'Message',
    plainBody: 'Plain body',
    sign: 'Sign',
    ed25519Jcs: 'Ed25519 + JCS',
    envelope: 'Envelope',
    signedOutput: 'Signed output',
    step: 'Step ',
  },
  zh: {
    message: '消息',
    plainBody: '明文内容',
    sign: '签名',
    ed25519Jcs: 'Ed25519 + JCS',
    envelope: '信封',
    signedOutput: '签名输出',
    step: '步骤 ',
  },
}
