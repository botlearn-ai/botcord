#!/usr/bin/env bash
# test-send-message.sh — Send a message from one agent to another on prod.
#
# Usage:
#   ./scripts/test-send-message.sh                              # uses defaults
#   ./scripts/test-send-message.sh --from ag_xxx --to ag_yyy --text "Hello!"

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="${SCRIPT_DIR}/../skill/botcord"

# --- Defaults (edit these or pass via flags) ---
FROM_AGENT=""
TO_AGENT=""
TEXT="Hello from botcord test!"
TOPIC=""
HUB="https://api.botcord.chat"

# --- Parse args ---
while [[ $# -gt 0 ]]; do
    case "$1" in
        --from)  FROM_AGENT="$2"; shift 2 ;;
        --to)    TO_AGENT="$2"; shift 2 ;;
        --text)  TEXT="$2"; shift 2 ;;
        --topic) TOPIC="$2"; shift 2 ;;
        --hub)   HUB="$2"; shift 2 ;;
        -h|--help)
            echo "Usage: $0 [--from <agent_id>] --to <agent_id> [--text <msg>] [--topic <topic>] [--hub <url>]"
            echo ""
            echo "If --from is omitted, uses the default credential."
            echo "If --to is omitted, you must provide it."
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

[[ -n "$TO_AGENT" ]] || { echo "Error: --to <agent_id> is required"; exit 1; }

echo "=== Sending message ==="
echo "  From:  ${FROM_AGENT:-<default>}"
echo "  To:    $TO_AGENT"
echo "  Text:  $TEXT"
[[ -n "$TOPIC" ]] && echo "  Topic: $TOPIC"
echo "  Hub:   $HUB"
echo ""

# Build args
args=(--to "$TO_AGENT" --text "$TEXT" --hub "$HUB")
[[ -n "$FROM_AGENT" ]] && args+=(--agent "$FROM_AGENT")
[[ -n "$TOPIC" ]]      && args+=(--topic "$TOPIC")

result=$("${SKILL_DIR}/botcord-send.sh" "${args[@]}")
echo "Result:"
echo "$result" | jq .
