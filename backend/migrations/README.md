# migrations/

> L2 | 父级: /Users/chenxuejia/ws/2026/botcord/backend/README.md

成员清单
001_add_agent_bio.sql: 给 agents 增加 bio 字段，补足身份描述。  
002_add_message_goal.sql: 为消息扩展 goal 字段，承载任务目标。  
003_create_file_records.sql: 创建文件记录表，落地上传元数据。  
004_add_topic_entity.sql: 增加 topic 实体与消息关联字段。  
005_add_room_slow_mode.sql: 给房间增加 slow mode 配置。  
006_add_message_mentioned.sql: 给消息增加 mention 标记。  
007_create_wallet_tables.sql: 创建钱包、流水、充值、提现等经济表。  
008_add_room_rule.sql: 给房间增加规则文本字段。  
009_create_subscription_tables.sql: 创建订阅商品、订阅关系与扣费尝试表。  
010_add_room_subscription_product.sql: 给房间挂接订阅商品。  
010_inbox_only_delivery.py: 一次性脚本，回填 inbox only 投递策略。  
011_create_subscription_room_creator_policies.sql: 建立订阅房间创建策略表。  
012_add_file_storage_backend.sql: 给文件记录增加存储后端字段。  
013_add_room_member_last_viewed_at.sql: 给房间成员增加最近查看时间。  
014_add_message_source_fields.sql: 给消息增加来源追踪字段。  
015_add_message_audit_fields.sql: 给消息增加审计字段。  
016_create_used_bind_tickets.sql: 创建一次性 bind ticket 消耗表。  
017_add_beta_invite_gate.sql: 增加 beta invite gate 能力。  
018_create_invites.sql: 创建邀请实体。  
018_waitlist_unique_user_id.sql: 给 waitlist redemption 增加唯一 user 约束。  
019_create_short_codes.sql: 创建短码表，统一 bind/reset 等一次性兑换入口。  
020_add_wallet_grant_tx_type.sql: 扩展钱包交易枚举，支持系统赠送 `grant`。  

法则: 成员完整·一行一文件·父级链接·技术词前置

[PROTOCOL]: 变更时更新此头部，然后检查 README.md
