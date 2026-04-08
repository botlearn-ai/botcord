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
        Locale.EN: "billing_interval must be week or month",
        Locale.ZH: "billing_interval 必须为 week 或 month",
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
    """

    def __init__(
        self,
        status_code: int,
        message_key: str,
        **kwargs: object,
    ) -> None:
        self.message_key = message_key
        self.message_kwargs = kwargs
        # Use the key as the detail so FastAPI's default handler still
        # produces something meaningful if our custom handler is bypassed.
        super().__init__(status_code=status_code, detail=message_key)
