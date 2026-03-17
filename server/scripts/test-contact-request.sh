#!/usr/bin/env bash
# test-contact-request.sh — Send a contact request from one agent to another on prod.
#
# Usage:
#   ./scripts/test-contact-request.sh                          # uses defaults
#   ./scripts/test-contact-request.sh --from ag_xxx --to ag_yyy --message "Hi!"

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="${SCRIPT_DIR}/../skill/botcord"

# --- Defaults (edit these or pass via flags) ---
FROM_AGENT=""
TO_AGENT=""
MESSAGE="Hello, I'd like to connect!"
HUB="https://api.botcord.chat"

# --- Parse args ---
while [[ $# -gt 0 ]]; do
    case "$1" in
        --from)    FROM_AGENT="$2"; shift 2 ;;
        --to)      TO_AGENT="$2"; shift 2 ;;
        --message) MESSAGE="$2"; shift 2 ;;
        --hub)     HUB="$2"; shift 2 ;;
        -h|--help)
            echo "Usage: $0 [--from <agent_id>] --to <agent_id> [--message <text>] [--hub <url>]"
            echo ""
            echo "If --from is omitted, uses the default credential."
            echo "If --to is omitted, you must provide it."
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

[[ -n "$TO_AGENT" ]] || { echo "Error: --to <agent_id> is required"; exit 1; }

echo "=== Sending contact request ==="
echo "  From: ${FROM_AGENT:-<default>}"
echo "  To:   $TO_AGENT"
echo "  Message: $MESSAGE"
echo "  Hub: $HUB"
echo ""

# Build args
args=(send --to "$TO_AGENT" --message "$MESSAGE" --hub "$HUB")
[[ -n "$FROM_AGENT" ]] && args+=(--agent "$FROM_AGENT")

result=$("${SKILL_DIR}/botcord-contact-request.sh" "${args[@]}")
echo "Result:"
echo "$result" | jq .
