#!/usr/bin/env bash
#
# 查看两个 Agent 之间的对话记录
#
# 用法:
#   ./view_chat.sh <agent_id_1> <agent_id_2> [limit]
#
# 示例:
#   ./view_chat.sh ag_abc123 ag_def456
#   ./view_chat.sh ag_abc123 ag_def456 50
#
# 环境变量:
#   DATABASE_URL  — PostgreSQL 连接串 (默认 postgresql://botcord:botcord@localhost:5432/botcord)
#
# 依赖: psql, jq
#

set -euo pipefail

if [ $# -lt 2 ]; then
    echo "用法: $0 <agent_id_1> <agent_id_2> [limit]"
    echo "示例: $0 ag_abc123 ag_def456 50"
    exit 1
fi

for cmd in psql jq; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "错误: 需要 $cmd，请先安装" >&2
        exit 1
    fi
done

AGENT1="$1"
AGENT2="$2"
LIMIT="${3:-100}"

DB_URL="${DATABASE_URL:-postgresql://botcord:botcord@localhost:5432/botcord}"
DB_URL="${DB_URL/postgresql+asyncpg:\/\//postgresql://}"

echo "========================================================================"
echo "对话记录: $AGENT1 <-> $AGENT2  (最多 $LIMIT 条)"
echo "========================================================================"
echo ""

# 用 psql 输出 JSON 行，每行一个 JSON 对象，方便 jq 解析
psql "$DB_URL" -v ON_ERROR_STOP=1 --no-align --tuples-only -c "
SELECT json_build_object(
    'ts',       to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
    'sender',   sender_id,
    'receiver', receiver_id,
    'state',    state,
    'error',    last_error,
    'envelope', envelope_json::json
)
FROM message_records
WHERE (sender_id = '$AGENT1' AND receiver_id = '$AGENT2')
   OR (sender_id = '$AGENT2' AND receiver_id = '$AGENT1')
ORDER BY created_at ASC
LIMIT $LIMIT;
" | while IFS= read -r line; do
    [ -z "$line" ] && continue

    ts=$(echo "$line" | jq -r '.ts')
    sender=$(echo "$line" | jq -r '.sender')
    state=$(echo "$line" | jq -r '.state')
    last_error=$(echo "$line" | jq -r '.error // empty')
    msg_type=$(echo "$line" | jq -r '.envelope.type // "message"')

    # 方向
    if [ "$sender" = "$AGENT1" ]; then
        direction="$AGENT1 → $AGENT2"
    else
        direction="$AGENT2 → $AGENT1"
    fi

    # 状态图标
    case "$state" in
        queued)    icon="⏳" ;;
        delivered) icon="✅" ;;
        acked)     icon="✅✅" ;;
        done)      icon="✅✅✅" ;;
        failed)    icon="❌" ;;
        *)         icon="$state" ;;
    esac

    # 提取消息内容
    text=$(echo "$line" | jq -r '
        .envelope as $e |
        $e.type as $t |
        $e.payload as $p |
        if   $t == "message" then
            ($p.text // $p.body // $p.message // ($p | tostring))
        elif $t == "contact_request" then
            "[好友申请] " + ($p.message // "")
        elif $t == "contact_request_response" then
            "[好友申请回复] " + ($p.state // "")
        elif $t == "contact_removed" then
            "[联系人移除] removed_by=" + ($p.removed_by // "")
        elif $t == "ack" then
            "[ACK]"
        elif $t == "error" then
            "[Error] " + ($p.error.code // "UNKNOWN") + ": " + ($p.error.message // "")
        elif $t == "result" then
            "[Result] " + ($p | tostring)
        else
            ($p | tostring)
        end
    ')

    echo "[$ts]  $direction  ($msg_type)  $icon"
    echo "  $text"

    if [ -n "$last_error" ]; then
        echo "  ⚠️  Error: $last_error"
    fi

    echo ""
done

# 总数
COUNT=$(psql "$DB_URL" --no-align --tuples-only -c "
SELECT count(*)
FROM message_records
WHERE (sender_id = '$AGENT1' AND receiver_id = '$AGENT2')
   OR (sender_id = '$AGENT2' AND receiver_id = '$AGENT1');
")

echo "========================================================================"
echo "共 ${COUNT// /} 条消息"
