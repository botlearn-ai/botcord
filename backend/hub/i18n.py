"""Internationalization (i18n) module for BotCord Hub error messages."""

from __future__ import annotations

import enum

from fastapi import HTTPException


class Locale(str, enum.Enum):
    EN = "en"
    ZH = "zh"


# ---------------------------------------------------------------------------
# Error message catalog
# ---------------------------------------------------------------------------
# Each key maps to {Locale.EN: "...", Locale.ZH: "..."}.
# Keys support Python str.format() placeholders for dynamic values.
# ---------------------------------------------------------------------------

ERROR_MESSAGES: dict[str, dict[Locale, str]] = {
    # -----------------------------------------------------------------------
    # Registry (registry.py)
    # -----------------------------------------------------------------------
    "agent_id_collision": {
        Locale.EN: "Agent ID collision: a different pubkey already occupies this agent_id",
        Locale.ZH: "Agent ID 冲突：不同的公钥已占用此 agent_id",
    },
    "challenge_not_found": {
        Locale.EN: "Challenge not found",
        Locale.ZH: "未找到 Challenge",
    },
    "challenge_already_used": {
        Locale.EN: "Challenge already used",
        Locale.ZH: "Challenge 已使用",
    },
    "challenge_expired": {
        Locale.EN: "Challenge expired",
        Locale.ZH: "Challenge 已过期",
    },
    "key_not_found": {
        Locale.EN: "Key not found",
        Locale.ZH: "未找到密钥",
    },
    "signature_verification_failed": {
        Locale.EN: "Signature verification failed",
        Locale.ZH: "签名验证失败",
    },
    "agent_not_found": {
        Locale.EN: "Agent not found",
        Locale.ZH: "未找到 Agent",
    },
    "agent_not_claimed": {
        Locale.EN: "Agent is not claimed yet. Please claim this agent first: {claim_url}",
        Locale.ZH: "该 Agent 尚未认领，请先完成认领：{claim_url}",
    },
    "agent_not_claimed_generic": {
        Locale.EN: "Agent is not claimed yet. Please claim this agent first before using BotCord features.",
        Locale.ZH: "该 Agent 尚未认领。请先完成 claim，再使用 BotCord 功能。",
    },
    "agent_not_owned_by_user": {
        Locale.EN: "This agent does not belong to the current user",
        Locale.ZH: "该 Agent 不属于当前用户",
    },
    "no_endpoint_registered": {
        Locale.EN: "No endpoint registered",
        Locale.ZH: "未注册 Endpoint",
    },
    "agent_discovery_disabled": {
        Locale.EN: "Agent discovery is currently disabled",
        Locale.ZH: "Agent 发现功能当前已禁用",
    },
    "key_already_revoked": {
        Locale.EN: "Key is already revoked",
        Locale.ZH: "密钥已被撤销",
    },
    "cannot_revoke_last_active_key": {
        Locale.EN: "Cannot revoke the last active key",
        Locale.ZH: "无法撤销最后一个活跃密钥",
    },
    "key_not_active": {
        Locale.EN: "Key is not active",
        Locale.ZH: "密钥未激活",
    },
    "nonce_already_used": {
        Locale.EN: "Nonce already used",
        Locale.ZH: "Nonce 已使用",
    },

    # -----------------------------------------------------------------------
    # Validators (validators.py)
    # -----------------------------------------------------------------------
    "agent_id_mismatch": {
        Locale.EN: "Agent ID mismatch",
        Locale.ZH: "Agent ID 不匹配",
    },
    "pubkey_must_start_with_ed25519": {
        Locale.EN: "pubkey must start with 'ed25519:'",
        Locale.ZH: "公钥必须以 'ed25519:' 开头",
    },
    "pubkey_base64_invalid": {
        Locale.EN: "pubkey base64 is invalid",
        Locale.ZH: "公钥 base64 格式无效",
    },
    "pubkey_must_be_32_bytes": {
        Locale.EN: "Ed25519 public key must be 32 bytes",
        Locale.ZH: "Ed25519 公钥必须为 32 字节",
    },
    "url_must_use_http_or_https": {
        Locale.EN: "URL must use http or https scheme",
        Locale.ZH: "URL 必须使用 http 或 https 协议",
    },
    "url_must_have_hostname": {
        Locale.EN: "URL must have a hostname",
        Locale.ZH: "URL 必须包含主机名",
    },
    "private_hostnames_not_allowed": {
        Locale.EN: "Private/internal hostnames are not allowed",
        Locale.ZH: "不允许使用私有/内部主机名",
    },
    "private_ips_not_allowed": {
        Locale.EN: "Private/internal IP addresses are not allowed",
        Locale.ZH: "不允许使用私有/内部 IP 地址",
    },
    "endpoint_probe_failed": {
        Locale.EN: "Endpoint probe failed",
        Locale.ZH: "Endpoint 探测失败",
    },

    # -----------------------------------------------------------------------
    # Hub / messaging (hub.py)
    # -----------------------------------------------------------------------
    "rate_limit_exceeded": {
        Locale.EN: "Rate limit exceeded",
        Locale.ZH: "超过速率限制",
    },
    "conversation_rate_limit_exceeded": {
        Locale.EN: "Conversation rate limit exceeded ({limit} msg/min per conversation)",
        Locale.ZH: "会话速率限制已超过（每分钟 {limit} 条消息）",
    },
    "timestamp_out_of_range": {
        Locale.EN: "Timestamp out of range",
        Locale.ZH: "时间戳超出范围",
    },
    "payload_hash_mismatch": {
        Locale.EN: "Payload hash mismatch",
        Locale.ZH: "Payload 哈希不匹配",
    },
    "signing_key_not_found_or_inactive": {
        Locale.EN: "Signing key not found or not active",
        Locale.ZH: "未找到签名密钥或密钥未激活",
    },
    "key_does_not_belong_to_sender": {
        Locale.EN: "Key does not belong to sender",
        Locale.ZH: "密钥不属于发送者",
    },
    "unknown_agent": {
        Locale.EN: "UNKNOWN_AGENT",
        Locale.ZH: "未知 Agent",
    },
    "blocked": {
        Locale.EN: "BLOCKED",
        Locale.ZH: "已被屏蔽",
    },
    "not_in_contacts": {
        Locale.EN: "NOT_IN_CONTACTS",
        Locale.ZH: "不在联系人列表中",
    },
    "cannot_send_contact_request_to_self": {
        Locale.EN: "Cannot send contact request to yourself",
        Locale.ZH: "不能向自己发送联系人请求",
    },
    "already_in_contacts": {
        Locale.EN: "Already in contacts",
        Locale.ZH: "已在联系人列表中",
    },
    "contact_request_already_pending": {
        Locale.EN: "Contact request already pending",
        Locale.ZH: "联系人请求已在等待中",
    },
    "contact_request_already_accepted": {
        Locale.EN: "Contact request already accepted",
        Locale.ZH: "联系人请求已被接受",
    },
    "slow_mode_wait": {
        Locale.EN: "Slow mode: wait {remaining}s before sending again",
        Locale.ZH: "慢速模式：请等待 {remaining} 秒后再发送",
    },
    "duplicate_content": {
        Locale.EN: "Duplicate content: consecutive identical messages are not allowed",
        Locale.ZH: "重复内容：不允许连续发送相同的消息",
    },
    "sender_does_not_match_token": {
        Locale.EN: "Sender does not match token",
        Locale.ZH: "发送者与令牌不匹配",
    },
    "send_invalid_type": {
        Locale.EN: "Only type 'message', 'contact_request', 'result', or 'error' accepted on /hub/send",
        Locale.ZH: "/hub/send 仅接受类型为 'message'、'contact_request'、'result' 或 'error' 的消息",
    },
    "receipt_invalid_type": {
        Locale.EN: "Only ack/result/error accepted on /hub/receipt",
        Locale.ZH: "/hub/receipt 仅接受 ack/result/error 类型",
    },
    "receipt_must_have_reply_to": {
        Locale.EN: "Receipt must have reply_to",
        Locale.ZH: "回执必须包含 reply_to",
    },
    "original_message_not_found": {
        Locale.EN: "Original message not found",
        Locale.ZH: "未找到原始消息",
    },
    "message_not_found": {
        Locale.EN: "Message not found",
        Locale.ZH: "未找到消息",
    },
    "not_the_sender": {
        Locale.EN: "Not the sender of this message",
        Locale.ZH: "您不是此消息的发送者",
    },
    "invalid_cursor": {
        Locale.EN: "Invalid cursor: message not found",
        Locale.ZH: "无效的游标：未找到消息",
    },

    # -----------------------------------------------------------------------
    # Room (room.py)
    # -----------------------------------------------------------------------
    "room_not_found": {
        Locale.EN: "Room not found",
        Locale.ZH: "未找到房间",
    },
    "not_a_member": {
        Locale.EN: "Not a member of this room",
        Locale.ZH: "您不是此房间的成员",
    },
    "admin_or_owner_required": {
        Locale.EN: "Admin or owner role required",
        Locale.ZH: "需要管理员或所有者角色",
    },
    "member_ids_not_found": {
        Locale.EN: "One or more member_ids not found",
        Locale.ZH: "一个或多个 member_id 未找到",
    },
    "admission_denied_contacts_only": {
        Locale.EN: "Admission denied: agents {denied} have contacts_only policy and you are not in their contacts",
        Locale.ZH: "准入被拒绝：Agent {denied} 设置了仅联系人策略，而您不在其联系人列表中",
    },
    "initial_members_exceed_max": {
        Locale.EN: "Initial members exceed max_members",
        Locale.ZH: "初始成员数超过最大成员限制",
    },
    "join_rate_limit_exceeded": {
        Locale.EN: "Join rate limit exceeded for this room",
        Locale.ZH: "该房间的加入速率限制已超过",
    },
    "self_join_public_open_only": {
        Locale.EN: "Self-join only allowed for public rooms with open join policy",
        Locale.ZH: "仅允许自行加入公开且开放加入策略的房间",
    },
    "no_invite_permission": {
        Locale.EN: "You do not have invite permission",
        Locale.ZH: "您没有邀请权限",
    },
    "admission_denied_target_contacts_only": {
        Locale.EN: "Admission denied: target agent has contacts_only policy and you are not in their contacts",
        Locale.ZH: "准入被拒绝：目标 Agent 设置了仅联系人策略，而您不在其联系人列表中",
    },
    "agent_senders_disabled": {
        Locale.EN: "Target agent does not accept messages from other agents",
        Locale.ZH: "目标 Agent 不接受其他 Agent 的消息",
    },
    "human_senders_disabled": {
        Locale.EN: "Target agent does not accept messages from human users",
        Locale.ZH: "目标 Agent 不接受人类用户的消息",
    },
    "not_in_whitelist": {
        Locale.EN: "Sender is not on the agent's whitelist",
        Locale.ZH: "发送者不在该 Agent 的白名单中",
    },
    "agent_closed_to_new_contacts": {
        Locale.EN: "Target agent is closed to new contacts",
        Locale.ZH: "目标 Agent 已关闭新联系人",
    },
    "room_invite_requires_contact": {
        Locale.EN: "Target agent only accepts room invites from contacts",
        Locale.ZH: "目标 Agent 仅接受联系人发出的入群邀请",
    },
    "agent_closed_to_room_invites": {
        Locale.EN: "Target agent is closed to room invites",
        Locale.ZH: "目标 Agent 已关闭入群邀请",
    },
    "room_is_full": {
        Locale.EN: "Room is full",
        Locale.ZH: "房间已满",
    },
    "agent_already_member_or_not_exist": {
        Locale.EN: "Agent is already a member or does not exist",
        Locale.ZH: "Agent 已是成员或不存在",
    },
    "member_not_found_in_room": {
        Locale.EN: "Member not found in room",
        Locale.ZH: "在房间中未找到该成员",
    },
    "cannot_remove_room_owner": {
        Locale.EN: "Cannot remove the room owner",
        Locale.ZH: "无法移除房间所有者",
    },
    "only_owner_can_remove_admins": {
        Locale.EN: "Only the owner can remove admins",
        Locale.ZH: "只有所有者可以移除管理员",
    },
    "owner_cannot_leave": {
        Locale.EN: "Owner cannot leave the room",
        Locale.ZH: "所有者不能离开房间",
    },
    "only_owner_can_dissolve": {
        Locale.EN: "Only the owner can dissolve the room",
        Locale.ZH: "只有所有者可以解散房间",
    },
    "only_owner_can_transfer": {
        Locale.EN: "Only the owner can transfer ownership",
        Locale.ZH: "只有所有者可以转让所有权",
    },
    "cannot_transfer_to_self": {
        Locale.EN: "Cannot transfer ownership to yourself",
        Locale.ZH: "不能将所有权转让给自己",
    },
    "new_owner_not_member": {
        Locale.EN: "New owner is not a member of this room",
        Locale.ZH: "新所有者不是此房间的成员",
    },
    "only_owner_can_promote": {
        Locale.EN: "Only the owner can promote/demote",
        Locale.ZH: "只有所有者可以提升/降级成员",
    },
    "cannot_change_owner_role": {
        Locale.EN: "Cannot change owner role via promote/demote",
        Locale.ZH: "无法通过提升/降级更改所有者角色",
    },
    "cannot_modify_owner_permissions": {
        Locale.EN: "Cannot modify owner permissions",
        Locale.ZH: "无法修改所有者权限",
    },
    "only_owner_can_modify_admin_permissions": {
        Locale.EN: "Only the owner can modify admin permissions",
        Locale.ZH: "只有所有者可以修改管理员权限",
    },
    "only_owner_admin_can_post": {
        Locale.EN: "Only owner/admin can post to this room",
        Locale.ZH: "只有所有者/管理员可以在此房间发送消息",
    },

    # -----------------------------------------------------------------------
    # Topics (topics.py)
    # -----------------------------------------------------------------------
    "topic_not_found": {
        Locale.EN: "Topic not found",
        Locale.ZH: "未找到 Topic",
    },
    "topic_title_duplicate": {
        Locale.EN: "A topic with this title already exists in this room",
        Locale.ZH: "该房间中已存在同名 Topic",
    },
    "topic_update_title_desc_forbidden": {
        Locale.EN: "Only the creator, admin, or owner can update title/description",
        Locale.ZH: "只有创建者、管理员或所有者可以更新标题/描述",
    },
    "topic_reactivation_requires_goal": {
        Locale.EN: "Reactivating a terminated topic requires a new goal",
        Locale.ZH: "重新激活已终止的 Topic 需要设置新目标",
    },
    "only_owner_admin_can_delete_topics": {
        Locale.EN: "Only owner or admin can delete topics",
        Locale.ZH: "只有所有者或管理员可以删除 Topic",
    },

    # -----------------------------------------------------------------------
    # Files (files.py)
    # -----------------------------------------------------------------------
    "mime_type_not_allowed": {
        Locale.EN: "MIME type not allowed: {content_type}",
        Locale.ZH: "不允许的 MIME 类型：{content_type}",
    },
    "file_too_large": {
        Locale.EN: "File too large. Max size: {max_size} bytes",
        Locale.ZH: "文件过大。最大大小：{max_size} 字节",
    },
    "empty_file": {
        Locale.EN: "Empty file",
        Locale.ZH: "文件为空",
    },
    "file_not_found": {
        Locale.EN: "File not found",
        Locale.ZH: "未找到文件",
    },
    "file_expired": {
        Locale.EN: "File expired",
        Locale.ZH: "文件已过期",
    },
    "file_not_found_on_disk": {
        Locale.EN: "File not found on disk",
        Locale.ZH: "磁盘上未找到文件",
    },

    # -----------------------------------------------------------------------
    # Wallet (wallet.py)
    # -----------------------------------------------------------------------
    "subscription_product_creation_not_allowed": {
        Locale.EN: "Agent is not allowed to create subscription products",
        Locale.ZH: "该 Agent 没有创建订阅产品的权限",
    },
    "amount_minor_must_be_numeric": {
        Locale.EN: "amount_minor must be a numeric string",
        Locale.ZH: "amount_minor 必须为数字字符串",
    },
    "amount_fee_must_be_numeric": {
        Locale.EN: "amount/fee must be numeric strings",
        Locale.ZH: "amount/fee 必须为数字字符串",
    },
    "fee_must_be_non_negative": {
        Locale.EN: "fee_minor must be >= 0",
        Locale.ZH: "fee_minor 必须 >= 0",
    },
    "transaction_not_found": {
        Locale.EN: "Transaction not found",
        Locale.ZH: "未找到交易",
    },
    "not_authorized": {
        Locale.EN: "Not authorized",
        Locale.ZH: "未授权",
    },
    "internal_endpoints_disabled": {
        Locale.EN: "Internal endpoints are disabled",
        Locale.ZH: "内部端点已禁用",
    },
    "missing_internal_api_secret": {
        Locale.EN: "Missing internal API secret",
        Locale.ZH: "缺少内部 API 密钥",
    },
    "invalid_internal_api_secret": {
        Locale.EN: "Invalid internal API secret",
        Locale.ZH: "内部 API 密钥无效",
    },

    # -----------------------------------------------------------------------
    # Contacts (contacts.py)
    # -----------------------------------------------------------------------
    "contact_not_found": {
        Locale.EN: "Contact not found",
        Locale.ZH: "未找到联系人",
    },
    "cannot_block_yourself": {
        Locale.EN: "Cannot block yourself",
        Locale.ZH: "不能屏蔽自己",
    },
    "target_agent_not_found": {
        Locale.EN: "Target agent not found",
        Locale.ZH: "未找到目标 Agent",
    },
    "agent_already_blocked": {
        Locale.EN: "Agent already blocked",
        Locale.ZH: "Agent 已被屏蔽",
    },
    "block_not_found": {
        Locale.EN: "Block not found",
        Locale.ZH: "未找到屏蔽记录",
    },

    # -----------------------------------------------------------------------
    # Contact Requests (contact_requests.py)
    # -----------------------------------------------------------------------
    "contact_request_not_found": {
        Locale.EN: "Contact request not found",
        Locale.ZH: "未找到联系人请求",
    },
    "contact_request_already_resolved": {
        Locale.EN: "Contact request is already {state}",
        Locale.ZH: "联系人请求已{state}",
    },

    # -----------------------------------------------------------------------
    # Subscriptions (subscriptions.py)
    # -----------------------------------------------------------------------
    "billing_interval_invalid": {
        Locale.EN: "billing_interval must be week, month, or once",
        Locale.ZH: "billing_interval 必须为 week、month 或 once",
    },
    "subscription_product_not_found": {
        Locale.EN: "Subscription product not found",
        Locale.ZH: "未找到订阅产品",
    },
    # -----------------------------------------------------------------------
    # Dashboard (dashboard.py)
    # -----------------------------------------------------------------------
    "before_after_exclusive": {
        Locale.EN: "before and after cannot be used together",
        Locale.ZH: "before 和 after 不能同时使用",
    },
    "share_not_found": {
        Locale.EN: "Share not found",
        Locale.ZH: "未找到分享",
    },
    "share_expired": {
        Locale.EN: "Share has expired",
        Locale.ZH: "分享已过期",
    },
    "already_a_member": {
        Locale.EN: "Already a member of this room",
        Locale.ZH: "已是此房间的成员",
    },

    # -----------------------------------------------------------------------
    # Auth (auth.py)
    # -----------------------------------------------------------------------
    "invalid_authorization_header": {
        Locale.EN: "Invalid authorization header",
        Locale.ZH: "无效的授权头",
    },
    "token_expired": {
        Locale.EN: "Token expired",
        Locale.ZH: "令牌已过期",
    },
    "invalid_token": {
        Locale.EN: "Invalid token",
        Locale.ZH: "无效的令牌",
    },
    "user_auth_not_configured": {
        Locale.EN: "User auth not configured",
        Locale.ZH: "用户认证未配置",
    },
    "active_agent_header_required": {
        Locale.EN: "X-Active-Agent header required for user tokens",
        Locale.ZH: "用户令牌需要 X-Active-Agent 请求头",
    },

    # -----------------------------------------------------------------------
    # Endpoint probe (validators.py)
    # -----------------------------------------------------------------------
    "endpoint_probe_failed_detail": {
        Locale.EN: "Endpoint probe failed: {detail}",
        Locale.ZH: "Endpoint 探测失败：{detail}",
    },

    # -----------------------------------------------------------------------
    # Wallet / Subscriptions — service-layer errors
    # -----------------------------------------------------------------------
    "wallet_service_error": {
        Locale.EN: "{detail}",
        Locale.ZH: "{detail}",
    },

    # -----------------------------------------------------------------------
    # Dashboard chat
    # -----------------------------------------------------------------------
    "user_id_required_for_chat": {
        Locale.EN: "User authentication is required for dashboard chat",
        Locale.ZH: "Dashboard 聊天需要用户登录",
    },
    "duplicate_message": {
        Locale.EN: "Duplicate message",
        Locale.ZH: "重复消息",
    },
}


# ---------------------------------------------------------------------------
# Hint message catalog
# ---------------------------------------------------------------------------
# Each key maps to {Locale.EN: "...", Locale.ZH: "..."}.
# Hints explain *why* the error happened and *how* to fix or avoid it.
# Keys match ERROR_MESSAGES where possible; extra keys (prefixed ``hint_``)
# are used for dynamic-detail errors like ``wallet_service_error``.
# ---------------------------------------------------------------------------

HINT_MESSAGES: dict[str, dict[Locale, str]] = {
    # -----------------------------------------------------------------------
    # Registry
    # -----------------------------------------------------------------------
    "agent_id_collision": {
        Locale.EN: "Use your existing agent or generate a new keypair to register a different agent.",
        Locale.ZH: "请使用已有的 Agent，或生成新的密钥对来注册一个新 Agent。",
    },
    "challenge_not_found": {
        Locale.EN: "Start the registration flow again to obtain a new challenge.",
        Locale.ZH: "请重新开始注册流程以获取新的 Challenge。",
    },
    "challenge_already_used": {
        Locale.EN: "Each challenge can only be used once. Register again to get a fresh challenge.",
        Locale.ZH: "每个 Challenge 仅可使用一次，请重新注册以获取新的 Challenge。",
    },
    "challenge_expired": {
        Locale.EN: "Challenges expire after a short time. Register again to get a fresh challenge.",
        Locale.ZH: "Challenge 已超时，请重新注册以获取新的 Challenge。",
    },
    "key_not_found": {
        Locale.EN: "Check the key_id. It should start with 'k_'.",
        Locale.ZH: "请检查 key_id 是否正确，key_id 以 'k_' 开头。",
    },
    "signature_verification_failed": {
        Locale.EN: "Ensure you are signing with the correct private key matching the registered public key.",
        Locale.ZH: "请确认使用了与已注册公钥对应的正确私钥进行签名。",
    },
    "agent_not_found": {
        Locale.EN: "Check the agent_id. Agent IDs start with 'ag_'.",
        Locale.ZH: "请检查 agent_id 是否正确，Agent ID 以 'ag_' 开头。",
    },
    "agent_not_claimed": {
        Locale.EN: "Visit the claim URL to bind this agent to your account before using it.",
        Locale.ZH: "请访问 claim 链接将该 Agent 绑定到您的账号后再使用。",
    },
    "agent_not_claimed_generic": {
        Locale.EN: "Claim this agent via the dashboard or the /botcord_bind command first.",
        Locale.ZH: "请先通过 Dashboard 或 /botcord_bind 命令完成 Agent 认领。",
    },
    "agent_not_owned_by_user": {
        Locale.EN: "Switch to an agent you own, or claim this agent first.",
        Locale.ZH: "请切换到您拥有的 Agent，或先认领该 Agent。",
    },
    "no_endpoint_registered": {
        Locale.EN: "Register an endpoint URL via POST /registry/agents/{{agent_id}}/endpoints.",
        Locale.ZH: "请通过 POST /registry/agents/{{agent_id}}/endpoints 注册 Endpoint URL。",
    },
    "agent_discovery_disabled": {
        Locale.EN: "Agent discovery is turned off on this hub. Use /registry/resolve/{{agent_id}} to look up specific agents.",
        Locale.ZH: "此 Hub 已关闭 Agent 发现功能，请使用 /registry/resolve/{{agent_id}} 查询特定 Agent。",
    },
    "key_already_revoked": {
        Locale.EN: "This key is already revoked. No further action needed.",
        Locale.ZH: "该密钥已被撤销，无需再次操作。",
    },
    "cannot_revoke_last_active_key": {
        Locale.EN: "Add a new signing key before revoking the last one.",
        Locale.ZH: "请先添加新的签名密钥，再撤销最后一个活跃密钥。",
    },
    "key_not_active": {
        Locale.EN: "This key must be verified and active before it can be used. Complete the challenge-response flow.",
        Locale.ZH: "该密钥需要完成验证才能使用，请完成 Challenge-Response 流程。",
    },
    "nonce_already_used": {
        Locale.EN: "Generate a new random nonce for each token refresh request.",
        Locale.ZH: "请为每次 token 刷新请求生成一个新的随机 nonce。",
    },

    # -----------------------------------------------------------------------
    # Validators
    # -----------------------------------------------------------------------
    "agent_id_mismatch": {
        Locale.EN: "The agent_id in the URL must match the agent_id in the JWT token.",
        Locale.ZH: "URL 中的 agent_id 必须与 JWT 令牌中的 agent_id 一致。",
    },
    "pubkey_must_start_with_ed25519": {
        Locale.EN: "Format the public key as 'ed25519:<base64-encoded-key>'.",
        Locale.ZH: "请将公钥格式化为 'ed25519:<base64编码的密钥>'。",
    },
    "pubkey_base64_invalid": {
        Locale.EN: "Re-encode the public key using standard base64.",
        Locale.ZH: "请使用标准 base64 重新编码公钥。",
    },
    "pubkey_must_be_32_bytes": {
        Locale.EN: "Ensure you are using an Ed25519 public key (exactly 32 bytes after decoding).",
        Locale.ZH: "请确认使用的是 Ed25519 公钥（解码后恰好 32 字节）。",
    },
    "url_must_use_http_or_https": {
        Locale.EN: "Provide a URL starting with http:// or https://.",
        Locale.ZH: "请提供以 http:// 或 https:// 开头的 URL。",
    },
    "url_must_have_hostname": {
        Locale.EN: "Include a valid hostname in the URL (e.g. https://example.com/webhook).",
        Locale.ZH: "请在 URL 中包含有效的主机名（如 https://example.com/webhook）。",
    },
    "private_hostnames_not_allowed": {
        Locale.EN: "Use a publicly reachable hostname. localhost, .local, and .internal are not allowed.",
        Locale.ZH: "请使用可公开访问的主机名，不允许 localhost、.local 和 .internal。",
    },
    "private_ips_not_allowed": {
        Locale.EN: "Use a public IP address. Private ranges (10.x, 172.16-31.x, 192.168.x) are not allowed.",
        Locale.ZH: "请使用公网 IP 地址，不允许私有地址段（10.x、172.16-31.x、192.168.x）。",
    },
    "endpoint_probe_failed": {
        Locale.EN: "Ensure your endpoint is reachable and responds to POST requests with 2xx.",
        Locale.ZH: "请确保您的 Endpoint 可达并对 POST 请求返回 2xx 状态码。",
    },
    "endpoint_probe_failed_detail": {
        Locale.EN: "Check that the endpoint URL is correct and the server is running.",
        Locale.ZH: "请确认 Endpoint URL 正确且服务已启动。",
    },

    # -----------------------------------------------------------------------
    # Hub / messaging
    # -----------------------------------------------------------------------
    "rate_limit_exceeded": {
        Locale.EN: "Wait a moment and retry. The limit resets every minute.",
        Locale.ZH: "请稍后重试，速率限制每分钟重置。",
    },
    "conversation_rate_limit_exceeded": {
        Locale.EN: "Slow down messages to this recipient. The per-conversation limit resets every minute.",
        Locale.ZH: "请降低向该对话发送消息的频率，每分钟限制会重置。",
    },
    "timestamp_out_of_range": {
        Locale.EN: "Sync your system clock. The message timestamp must be within ±5 minutes of the server time.",
        Locale.ZH: "请同步系统时钟，消息时间戳必须在服务器时间 ±5 分钟以内。",
    },
    "payload_hash_mismatch": {
        Locale.EN: "Recompute the payload_hash using JCS canonicalization + SHA-256.",
        Locale.ZH: "请使用 JCS 规范化 + SHA-256 重新计算 payload_hash。",
    },
    "signing_key_not_found_or_inactive": {
        Locale.EN: "Check the key_id in the envelope. The key must be verified and active.",
        Locale.ZH: "请检查信封中的 key_id，密钥必须已验证且处于活跃状态。",
    },
    "key_does_not_belong_to_sender": {
        Locale.EN: "Use a signing key that belongs to the 'from' agent in the envelope.",
        Locale.ZH: "请使用属于信封中 'from' Agent 的签名密钥。",
    },
    "unknown_agent": {
        Locale.EN: "The recipient agent_id does not exist. Verify the ID or register the agent first.",
        Locale.ZH: "收件人 agent_id 不存在，请确认 ID 或先注册该 Agent。",
    },
    "blocked": {
        Locale.EN: "The recipient has blocked you. You cannot send messages to this agent.",
        Locale.ZH: "对方已将您屏蔽，无法向该 Agent 发送消息。",
    },
    "not_in_contacts": {
        Locale.EN: "The recipient's policy requires you to be in their contacts. Send a contact request first.",
        Locale.ZH: "对方设置了仅联系人策略，请先发送联系人请求。",
    },
    "cannot_send_contact_request_to_self": {
        Locale.EN: "You cannot add yourself as a contact.",
        Locale.ZH: "不能将自己添加为联系人。",
    },
    "already_in_contacts": {
        Locale.EN: "This agent is already in your contacts. No action needed.",
        Locale.ZH: "该 Agent 已在您的联系人列表中，无需操作。",
    },
    "contact_request_already_pending": {
        Locale.EN: "A contact request is already waiting for the recipient's response.",
        Locale.ZH: "已有一个联系人请求等待对方回应。",
    },
    "contact_request_already_accepted": {
        Locale.EN: "The contact request was already accepted. You are already contacts.",
        Locale.ZH: "该联系人请求已被接受，你们已经是联系人。",
    },
    "slow_mode_wait": {
        Locale.EN: "This room has slow mode enabled. Wait for the cooldown period to pass.",
        Locale.ZH: "该房间启用了慢速模式，请等待冷却时间结束。",
    },
    "duplicate_content": {
        Locale.EN: "Modify your message before resending — consecutive identical messages are blocked.",
        Locale.ZH: "请修改消息内容后再发送——不允许连续发送完全相同的消息。",
    },
    "sender_does_not_match_token": {
        Locale.EN: "The 'from' field in the envelope must match the agent_id in your JWT token.",
        Locale.ZH: "信封中的 'from' 字段必须与 JWT 令牌中的 agent_id 一致。",
    },
    "send_invalid_type": {
        Locale.EN: "Use /hub/send for 'message', 'contact_request', 'result', or 'error' types. Use /hub/receipt for ack/result/error.",
        Locale.ZH: "请通过 /hub/send 发送 'message'、'contact_request'、'result' 或 'error' 类型，使用 /hub/receipt 发送 ack/result/error。",
    },
    "receipt_invalid_type": {
        Locale.EN: "Only ack, result, and error types are accepted on /hub/receipt.",
        Locale.ZH: "/hub/receipt 仅接受 ack、result 和 error 类型。",
    },
    "receipt_must_have_reply_to": {
        Locale.EN: "Set the reply_to field to the msg_id of the message you are acknowledging.",
        Locale.ZH: "请在 reply_to 字段中设置您要确认的消息的 msg_id。",
    },
    "original_message_not_found": {
        Locale.EN: "The message referenced by reply_to does not exist. Check the msg_id.",
        Locale.ZH: "reply_to 引用的消息不存在，请检查 msg_id。",
    },
    "message_not_found": {
        Locale.EN: "Check the msg_id. Message IDs start with 'h_'.",
        Locale.ZH: "请检查 msg_id 是否正确，消息 ID 以 'h_' 开头。",
    },
    "not_the_sender": {
        Locale.EN: "You can only check the delivery status of messages you sent.",
        Locale.ZH: "您只能查看自己发送的消息的投递状态。",
    },
    "invalid_cursor": {
        Locale.EN: "The cursor references a message that no longer exists. Start pagination from the beginning.",
        Locale.ZH: "游标引用的消息已不存在，请从头开始分页。",
    },

    # -----------------------------------------------------------------------
    # Room
    # -----------------------------------------------------------------------
    "room_not_found": {
        Locale.EN: "Check the room_id. Room IDs start with 'rm_'.",
        Locale.ZH: "请检查 room_id 是否正确，房间 ID 以 'rm_' 开头。",
    },
    "not_a_member": {
        Locale.EN: "Join the room first, or ask an admin to add you.",
        Locale.ZH: "请先加入房间，或联系管理员将您添加。",
    },
    "admin_or_owner_required": {
        Locale.EN: "This action requires admin or owner role. Ask the room owner to promote you.",
        Locale.ZH: "此操作需要管理员或所有者角色，请联系房间所有者提升您的角色。",
    },
    "member_ids_not_found": {
        Locale.EN: "Verify all member agent_ids exist and start with 'ag_'.",
        Locale.ZH: "请确认所有成员的 agent_id 存在且以 'ag_' 开头。",
    },
    "admission_denied_contacts_only": {
        Locale.EN: "Some agents have contacts_only policy. Add them as contacts first before inviting.",
        Locale.ZH: "部分 Agent 设置了仅联系人策略，请先添加为联系人再邀请。",
    },
    "initial_members_exceed_max": {
        Locale.EN: "Reduce the number of initial members or increase max_members for the room.",
        Locale.ZH: "请减少初始成员数量，或增大房间的 max_members 限制。",
    },
    "join_rate_limit_exceeded": {
        Locale.EN: "Too many agents are joining this room. Wait a moment and try again.",
        Locale.ZH: "该房间的加入频率过高，请稍后重试。",
    },
    "self_join_public_open_only": {
        Locale.EN: "This room is not public or does not allow open joining. Ask an admin to invite you.",
        Locale.ZH: "该房间不是公开房间或不允许自由加入，请联系管理员邀请您。",
    },
    "no_invite_permission": {
        Locale.EN: "The room's default_invite is disabled and you don't have an override. Ask an admin.",
        Locale.ZH: "房间的 default_invite 已禁用且您没有覆盖权限，请联系管理员。",
    },
    "admission_denied_target_contacts_only": {
        Locale.EN: "The target agent's policy requires you to be in their contacts first.",
        Locale.ZH: "目标 Agent 设置了仅联系人策略，请先添加为联系人。",
    },
    "agent_senders_disabled": {
        Locale.EN: "The target agent has disabled inbound traffic from other agents.",
        Locale.ZH: "目标 Agent 已关闭来自其他 Agent 的入站。",
    },
    "human_senders_disabled": {
        Locale.EN: "The target agent has disabled inbound traffic from human users.",
        Locale.ZH: "目标 Agent 已关闭来自人类用户的入站。",
    },
    "not_in_whitelist": {
        Locale.EN: "Ask the agent owner to whitelist you (add you as a contact).",
        Locale.ZH: "请联系该 Agent 的所有者将您加入白名单（添加为联系人）。",
    },
    "agent_closed_to_new_contacts": {
        Locale.EN: "The target agent is not accepting new contacts.",
        Locale.ZH: "目标 Agent 当前不接受新联系人。",
    },
    "room_invite_requires_contact": {
        Locale.EN: "The target agent only accepts room invites from existing contacts.",
        Locale.ZH: "目标 Agent 仅接受联系人发出的入群邀请。",
    },
    "agent_closed_to_room_invites": {
        Locale.EN: "The target agent is not accepting room invites.",
        Locale.ZH: "目标 Agent 当前不接受入群邀请。",
    },
    "room_is_full": {
        Locale.EN: "The room has reached its member limit. Ask the owner to increase max_members.",
        Locale.ZH: "房间已达成员上限，请联系所有者增大 max_members。",
    },
    "agent_already_member_or_not_exist": {
        Locale.EN: "The agent is already in the room, or the agent_id does not exist.",
        Locale.ZH: "该 Agent 已在房间中，或 agent_id 不存在。",
    },
    "member_not_found_in_room": {
        Locale.EN: "Check the agent_id. This agent is not a member of the room.",
        Locale.ZH: "请检查 agent_id，该 Agent 不是此房间的成员。",
    },
    "cannot_remove_room_owner": {
        Locale.EN: "Transfer ownership to another member before removing the owner.",
        Locale.ZH: "请先将所有权转移给其他成员，再移除所有者。",
    },
    "only_owner_can_remove_admins": {
        Locale.EN: "Only the room owner can remove admins. Contact the owner.",
        Locale.ZH: "只有房间所有者可以移除管理员，请联系所有者。",
    },
    "owner_cannot_leave": {
        Locale.EN: "Transfer ownership to another member first, then you can leave.",
        Locale.ZH: "请先将所有权转移给其他成员，然后再离开房间。",
    },
    "only_owner_can_dissolve": {
        Locale.EN: "Only the room owner can dissolve the room.",
        Locale.ZH: "只有房间所有者可以解散房间。",
    },
    "only_owner_can_transfer": {
        Locale.EN: "Only the current owner can transfer ownership.",
        Locale.ZH: "只有当前所有者可以转让所有权。",
    },
    "cannot_transfer_to_self": {
        Locale.EN: "You are already the owner. Transfer to a different member.",
        Locale.ZH: "您已经是所有者，请转让给其他成员。",
    },
    "new_owner_not_member": {
        Locale.EN: "The target agent must be a member of the room before receiving ownership.",
        Locale.ZH: "目标 Agent 必须是房间成员才能接受所有权。",
    },
    "only_owner_can_promote": {
        Locale.EN: "Only the room owner can promote or demote members.",
        Locale.ZH: "只有房间所有者可以提升或降级成员角色。",
    },
    "cannot_change_owner_role": {
        Locale.EN: "Use the transfer endpoint to change ownership instead.",
        Locale.ZH: "请使用转让端点来更改所有权。",
    },
    "cannot_modify_owner_permissions": {
        Locale.EN: "Owner permissions cannot be modified.",
        Locale.ZH: "所有者权限不可修改。",
    },
    "only_owner_can_modify_admin_permissions": {
        Locale.EN: "Only the room owner can modify admin permissions.",
        Locale.ZH: "只有房间所有者可以修改管理员权限。",
    },
    "only_owner_admin_can_post": {
        Locale.EN: "This room has default_send disabled. Ask an admin to grant you send permission.",
        Locale.ZH: "该房间已禁用 default_send，请联系管理员授予您发送权限。",
    },

    # -----------------------------------------------------------------------
    # Topics
    # -----------------------------------------------------------------------
    "topic_not_found": {
        Locale.EN: "Check the topic_id. Topic IDs start with 'tp_'.",
        Locale.ZH: "请检查 topic_id 是否正确，Topic ID 以 'tp_' 开头。",
    },
    "topic_title_duplicate": {
        Locale.EN: "Choose a different title — a topic with this name already exists in the room.",
        Locale.ZH: "请选择不同的标题——该房间中已存在同名 Topic。",
    },
    "topic_update_title_desc_forbidden": {
        Locale.EN: "Only the topic creator, a room admin, or the owner can edit the title and description.",
        Locale.ZH: "只有 Topic 创建者、管理员或所有者可以修改标题和描述。",
    },
    "topic_reactivation_requires_goal": {
        Locale.EN: "Provide a new 'goal' to reactivate a completed, failed, or expired topic.",
        Locale.ZH: "请提供新的 'goal' 来重新激活已终止的 Topic。",
    },
    "only_owner_admin_can_delete_topics": {
        Locale.EN: "Only the room owner or admin can delete topics.",
        Locale.ZH: "只有房间所有者或管理员可以删除 Topic。",
    },

    # -----------------------------------------------------------------------
    # Files
    # -----------------------------------------------------------------------
    "mime_type_not_allowed": {
        Locale.EN: "Allowed types: text/*, image/*, audio/*, video/*, and common application types (pdf, json, zip).",
        Locale.ZH: "允许的类型：text/*、image/*、audio/*、video/* 以及常见应用类型（pdf、json、zip）。",
    },
    "file_too_large": {
        Locale.EN: "Reduce the file size or split it into smaller parts.",
        Locale.ZH: "请缩小文件大小或拆分为多个较小的部分。",
    },
    "empty_file": {
        Locale.EN: "Upload a file with actual content.",
        Locale.ZH: "请上传有实际内容的文件。",
    },
    "file_not_found": {
        Locale.EN: "The file_id does not exist. File IDs start with 'f_'.",
        Locale.ZH: "该 file_id 不存在，文件 ID 以 'f_' 开头。",
    },
    "file_expired": {
        Locale.EN: "This file has expired and been deleted. Upload it again if needed.",
        Locale.ZH: "该文件已过期并被删除，如需使用请重新上传。",
    },
    "file_not_found_on_disk": {
        Locale.EN: "The file record exists but the actual file is missing. Re-upload the file.",
        Locale.ZH: "文件记录存在但实际文件丢失，请重新上传。",
    },

    # -----------------------------------------------------------------------
    # Wallet
    # -----------------------------------------------------------------------
    "subscription_product_creation_not_allowed": {
        Locale.EN: "Your agent does not have permission to create subscription products. Contact the hub admin.",
        Locale.ZH: "您的 Agent 没有创建订阅产品的权限，请联系 Hub 管理员。",
    },
    "amount_minor_must_be_numeric": {
        Locale.EN: "Provide amount_minor as a numeric string (e.g. \"1000\").",
        Locale.ZH: "请将 amount_minor 提供为数字字符串（如 \"1000\"）。",
    },
    "amount_fee_must_be_numeric": {
        Locale.EN: "Provide amount and fee as numeric strings.",
        Locale.ZH: "请将 amount 和 fee 提供为数字字符串。",
    },
    "fee_must_be_non_negative": {
        Locale.EN: "Set fee_minor to 0 or a positive value.",
        Locale.ZH: "请将 fee_minor 设为 0 或正数。",
    },
    "transaction_not_found": {
        Locale.EN: "Check the tx_id. Transaction IDs start with 'tx_'.",
        Locale.ZH: "请检查 tx_id 是否正确，交易 ID 以 'tx_' 开头。",
    },
    "not_authorized": {
        Locale.EN: "You are not authorized to perform this action.",
        Locale.ZH: "您没有执行此操作的权限。",
    },
    "internal_endpoints_disabled": {
        Locale.EN: "Set ALLOW_PRIVATE_ENDPOINTS=true in the server configuration to enable internal endpoints.",
        Locale.ZH: "请在服务器配置中设置 ALLOW_PRIVATE_ENDPOINTS=true 以启用内部端点。",
    },
    "missing_internal_api_secret": {
        Locale.EN: "Provide a Bearer token in the Authorization header.",
        Locale.ZH: "请在 Authorization 请求头中提供 Bearer 令牌。",
    },
    "invalid_internal_api_secret": {
        Locale.EN: "The provided API secret does not match. Check INTERNAL_API_SECRET configuration.",
        Locale.ZH: "提供的 API 密钥不匹配，请检查 INTERNAL_API_SECRET 配置。",
    },
    "wallet_service_error": {
        Locale.EN: "Check the request parameters and try again.",
        Locale.ZH: "请检查请求参数后重试。",
    },

    # -----------------------------------------------------------------------
    # Contacts
    # -----------------------------------------------------------------------
    "contact_not_found": {
        Locale.EN: "Check the contact agent_id. You may not have this agent in your contacts.",
        Locale.ZH: "请检查联系人 agent_id，该 Agent 可能不在您的联系人列表中。",
    },
    "cannot_block_yourself": {
        Locale.EN: "You cannot block yourself.",
        Locale.ZH: "不能屏蔽自己。",
    },
    "target_agent_not_found": {
        Locale.EN: "The target agent_id does not exist. Verify the ID.",
        Locale.ZH: "目标 agent_id 不存在，请确认 ID。",
    },
    "agent_already_blocked": {
        Locale.EN: "This agent is already blocked. No further action needed.",
        Locale.ZH: "该 Agent 已被屏蔽，无需再次操作。",
    },
    "block_not_found": {
        Locale.EN: "You have not blocked this agent.",
        Locale.ZH: "您未屏蔽该 Agent。",
    },

    # -----------------------------------------------------------------------
    # Contact Requests
    # -----------------------------------------------------------------------
    "contact_request_not_found": {
        Locale.EN: "Check the request_id. The contact request may have been deleted.",
        Locale.ZH: "请检查 request_id，该联系人请求可能已被删除。",
    },
    "contact_request_already_resolved": {
        Locale.EN: "This contact request has already been processed. No further action is possible.",
        Locale.ZH: "该联系人请求已被处理，无法再次操作。",
    },

    # -----------------------------------------------------------------------
    # Subscriptions
    # -----------------------------------------------------------------------
    "billing_interval_invalid": {
        Locale.EN: "Set billing_interval to 'week', 'month', or 'once'.",
        Locale.ZH: "请将 billing_interval 设置为 'week'、'month' 或 'once'。",
    },
    "subscription_product_not_found": {
        Locale.EN: "Check the product_id. Subscription product IDs start with 'sp_'.",
        Locale.ZH: "请检查 product_id 是否正确，订阅产品 ID 以 'sp_' 开头。",
    },

    # -----------------------------------------------------------------------
    # Dashboard
    # -----------------------------------------------------------------------
    "before_after_exclusive": {
        Locale.EN: "Use either 'before' or 'after' for pagination, not both at the same time.",
        Locale.ZH: "分页时请只使用 'before' 或 'after' 中的一个，不能同时使用。",
    },
    "share_not_found": {
        Locale.EN: "The share link may have been deleted or the share_id is incorrect.",
        Locale.ZH: "分享链接可能已被删除或 share_id 不正确。",
    },
    "share_expired": {
        Locale.EN: "This share link has expired. Ask the room member to create a new one.",
        Locale.ZH: "该分享链接已过期，请联系房间成员创建新的分享。",
    },
    "already_a_member": {
        Locale.EN: "You are already a member of this room. No action needed.",
        Locale.ZH: "您已是此房间的成员，无需操作。",
    },

    # -----------------------------------------------------------------------
    # Auth
    # -----------------------------------------------------------------------
    "invalid_authorization_header": {
        Locale.EN: "Provide a valid 'Bearer <token>' in the Authorization header.",
        Locale.ZH: "请在 Authorization 请求头中提供有效的 'Bearer <token>'。",
    },
    "token_expired": {
        Locale.EN: "Refresh your token via POST /registry/agents/{{agent_id}}/token/refresh.",
        Locale.ZH: "请通过 POST /registry/agents/{{agent_id}}/token/refresh 刷新令牌。",
    },
    "invalid_token": {
        Locale.EN: "The token is malformed or signed with a different secret. Obtain a new token.",
        Locale.ZH: "令牌格式错误或使用了不同的密钥签发，请获取新的令牌。",
    },
    "user_auth_not_configured": {
        Locale.EN: "The hub admin needs to configure SUPABASE_JWT_SECRET or SUPABASE_JWT_JWKS_URL.",
        Locale.ZH: "Hub 管理员需要配置 SUPABASE_JWT_SECRET 或 SUPABASE_JWT_JWKS_URL。",
    },
    "active_agent_header_required": {
        Locale.EN: "Include X-Active-Agent header with the agent_id you want to act as.",
        Locale.ZH: "请在请求头中包含 X-Active-Agent，值为您要操作的 agent_id。",
    },

    # -----------------------------------------------------------------------
    # Dashboard chat
    # -----------------------------------------------------------------------
    "user_id_required_for_chat": {
        Locale.EN: "Log in to the dashboard to use the chat feature.",
        Locale.ZH: "请登录 Dashboard 以使用聊天功能。",
    },
    "duplicate_message": {
        Locale.EN: "This message was already sent. Use a different msg_id.",
        Locale.ZH: "该消息已发送过，请使用不同的 msg_id。",
    },

    # -----------------------------------------------------------------------
    # Wallet/Subscription service-layer error hints (used via hint_key)
    # -----------------------------------------------------------------------
    "hint_insufficient_balance": {
        Locale.EN: "Top up your wallet before retrying, or reduce the amount.",
        Locale.ZH: "请先充值钱包后重试，或减少金额。",
    },
    "hint_amount_must_be_positive": {
        Locale.EN: "Specify a positive amount greater than zero.",
        Locale.ZH: "请指定大于零的正数金额。",
    },
    "hint_recipient_not_found": {
        Locale.EN: "Check the recipient agent_id. It should start with 'ag_'.",
        Locale.ZH: "请检查收款方 agent_id，应以 'ag_' 开头。",
    },
    "hint_cannot_transfer_to_self": {
        Locale.EN: "Transfer to a different agent, not yourself.",
        Locale.ZH: "请转账给其他 Agent，不能转给自己。",
    },
    "hint_idempotency_conflict": {
        Locale.EN: "This operation was already processed. Use a new idempotency key if you intend a separate transaction.",
        Locale.ZH: "此操作已被处理过，如需新交易请使用新的幂等键。",
    },
    "hint_request_not_found": {
        Locale.EN: "Check the request ID. The request may have already been processed or does not exist.",
        Locale.ZH: "请检查请求 ID，该请求可能已被处理或不存在。",
    },
    "hint_request_wrong_status": {
        Locale.EN: "This request is no longer in the expected state. Check its current status.",
        Locale.ZH: "该请求已不在预期状态，请检查其当前状态。",
    },
    "hint_fee_must_be_non_negative": {
        Locale.EN: "Set the fee to 0 or a positive value.",
        Locale.ZH: "请将手续费设为 0 或正数。",
    },
    "hint_stripe_not_configured": {
        Locale.EN: "The hub admin needs to configure Stripe API keys.",
        Locale.ZH: "Hub 管理员需要配置 Stripe API 密钥。",
    },
    "hint_subscription_product_exists": {
        Locale.EN: "A product with this name already exists. Use a different name.",
        Locale.ZH: "同名产品已存在，请使用不同的名称。",
    },
    "hint_subscription_product_archived": {
        Locale.EN: "This product has been archived and no longer accepts new subscriptions.",
        Locale.ZH: "该产品已归档，不再接受新的订阅。",
    },
    "hint_cannot_subscribe_own_product": {
        Locale.EN: "You cannot subscribe to a product you own.",
        Locale.ZH: "不能订阅自己拥有的产品。",
    },
    "hint_subscription_already_exists": {
        Locale.EN: "You already have an active subscription to this product.",
        Locale.ZH: "您已经订阅了该产品。",
    },
    "hint_not_authorized_cancel": {
        Locale.EN: "Only the subscriber can cancel their subscription.",
        Locale.ZH: "只有订阅者本人可以取消订阅。",
    },
    "hint_not_authorized_archive": {
        Locale.EN: "Only the product owner can archive it.",
        Locale.ZH: "只有产品所有者可以归档该产品。",
    },
    "hint_not_authorized_generic": {
        Locale.EN: "You do not have permission for this operation.",
        Locale.ZH: "您没有执行此操作的权限。",
    },
    "hint_subscription_product_not_found": {
        Locale.EN: "Check the product_id. Subscription product IDs start with 'sp_'.",
        Locale.ZH: "请检查 product_id，订阅产品 ID 以 'sp_' 开头。",
    },
    "hint_subscription_not_found": {
        Locale.EN: "Check the subscription_id. Subscription IDs start with 'sub_'.",
        Locale.ZH: "请检查 subscription_id，订阅 ID 以 'sub_' 开头。",
    },
    "hint_subscription_room_full": {
        Locale.EN: "The subscription room has reached its member limit. Ask the room owner to increase max_members.",
        Locale.ZH: "订阅房间已达成员上限，请联系房间所有者增大 max_members。",
    },
    "hint_subscription_room_join_failed": {
        Locale.EN: "Auto-join to the subscription room failed. The subscriber may already be a member, or there was a conflict.",
        Locale.ZH: "自动加入订阅房间失败，订阅者可能已是成员或发生了冲突。",
    },
}


# ---------------------------------------------------------------------------
# Helper: resolve service-layer ValueError messages to hint keys
# ---------------------------------------------------------------------------
# IMPORTANT: Rules are matched top-to-bottom (first match wins).
# Place more specific patterns BEFORE generic catch-all patterns.
# ---------------------------------------------------------------------------

_SERVICE_ERROR_HINT_MAP: list[tuple[str, str]] = [
    # -- Specific patterns first --
    ("Insufficient balance", "hint_insufficient_balance"),
    ("Amount must be positive", "hint_amount_must_be_positive"),
    ("Fee must be non-negative", "hint_fee_must_be_non_negative"),
    ("Recipient agent not found", "hint_recipient_not_found"),
    ("Cannot transfer to yourself", "hint_cannot_transfer_to_self"),
    ("Cannot subscribe to your own", "hint_cannot_subscribe_own_product"),
    ("Idempotency conflict", "hint_idempotency_conflict"),
    ("Stripe is not configured", "hint_stripe_not_configured"),
    ("is archived", "hint_subscription_product_archived"),
    # -- Subscription-specific patterns --
    ("Failed to auto-join subscription room", "hint_subscription_room_join_failed"),
    ("Subscription room", "hint_subscription_room_full"),
    ("Subscription product already exists", "hint_subscription_product_exists"),
    ("Subscription already exists", "hint_subscription_already_exists"),
    ("Subscription product not found", "hint_subscription_product_not_found"),
    ("Subscription not found", "hint_subscription_not_found"),
    ("Not authorized to archive", "hint_not_authorized_archive"),
    ("Not authorized to cancel", "hint_not_authorized_cancel"),
    # -- Generic catch-all patterns (must be last) --
    ("not found", "hint_request_not_found"),
    ("not pending", "hint_request_wrong_status"),
    ("not approved", "hint_request_wrong_status"),
    ("already exists", "hint_subscription_product_exists"),
    ("Not authorized", "hint_not_authorized_generic"),
]


def resolve_service_error_hint(error_msg: str) -> str | None:
    """Find the best hint_key for a service-layer ValueError message."""
    for pattern, hint_key in _SERVICE_ERROR_HINT_MAP:
        if pattern in error_msg:
            return hint_key
    return None


def get_hint(key: str, locale: Locale = Locale.EN, **kwargs: object) -> str | None:
    """Get a translated hint by key.

    Returns ``None`` if no hint is defined for the key.
    """
    msgs = HINT_MESSAGES.get(key)
    if msgs is None:
        return None
    msg = msgs.get(locale, msgs.get(Locale.EN))
    if msg is None:
        return None
    return msg.format(**kwargs) if kwargs else msg


def get_message(key: str, locale: Locale = Locale.EN, **kwargs: object) -> str:
    """Get a translated error message by key.

    Falls back to English if the requested locale is not found, and
    returns the raw key if the key itself is not in the catalog.
    """
    msgs = ERROR_MESSAGES.get(key)
    if msgs is None:
        return key
    msg = msgs.get(locale, msgs.get(Locale.EN, key))
    return msg.format(**kwargs) if kwargs else msg


def detect_locale(accept_language: str | None) -> Locale:
    """Detect locale from the Accept-Language HTTP header.

    Simple heuristic: if the header contains "zh" anywhere, return ZH.
    Otherwise default to EN.
    """
    if accept_language and "zh" in accept_language.lower():
        return Locale.ZH
    return Locale.EN


class I18nHTTPException(HTTPException):
    """HTTPException subclass with i18n message key support.

    Instead of passing a human-readable ``detail`` string, pass a
    ``message_key`` that maps to an entry in ``ERROR_MESSAGES``.  The
    exception handler in ``main.py`` resolves the key to a translated
    string based on the request's ``Accept-Language`` header.

    An optional ``hint_key`` overrides which key is used to look up
    the hint message (useful for generic wrappers like
    ``wallet_service_error`` that need error-specific hints).
    """

    def __init__(
        self,
        status_code: int,
        message_key: str,
        *,
        hint_key: str | None = None,
        **kwargs: object,
    ) -> None:
        self.message_key = message_key
        self.hint_key = hint_key
        self.message_kwargs = kwargs
        # Use the key as the detail so FastAPI's default handler still
        # produces something meaningful if our custom handler is bypassed.
        super().__init__(status_code=status_code, detail=message_key)
