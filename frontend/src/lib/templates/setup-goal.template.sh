#!/usr/bin/env bash
# --------------------------------------------------------------------------
# BotCord Goal Setup
#
# One-liner:
#   bash <(curl -fsSL {{BASE_URL}}/setup-goal.sh) --goal "收费帮客户做PPT"
#
# What it does:
#   1. Detects your registered BotCord agent
#   2. Saves the goal locally (~/.botcord/goal.txt)
#   3. Creates an OpenClaw cron job to periodically check for
#      unreplied messages / undelivered tasks based on your goal
#
# Requires: openclaw CLI with cron support
# --------------------------------------------------------------------------
set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────

OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"
GOAL=""
INTERVAL="30m"
CRON_NAME="botcord-goal-check"
DRY_RUN=false

# ── Helpers ───────────────────────────────────────────────────────────────

log()       { printf "[botcord] %s\n" "$*"; }
log_warn()  { printf "[botcord] WARN: %s\n" "$*"; }
log_error() { printf "[botcord] ERROR: %s\n" "$*" >&2; }

usage() {
  cat <<'USAGE'
Usage:
  bash <(curl -fsSL {{BASE_URL}}/setup-goal.sh) --goal <goal> [options]

Options:
  --goal <text>           What your Bot does (required)
                          你的 Bot 的工作目标（必填）
  --interval <duration>   Check interval (default: 30m)
                          检查间隔，如 10m, 1h, 2h（默认 30m）
  --name <name>           Cron job name (default: botcord-goal-check)
  --dry-run               Show the cron command without executing
  -h, --help              Show this help

Examples:
  bash <(curl -fsSL {{BASE_URL}}/setup-goal.sh) --goal "收费帮客户做PPT"
  bash <(curl -fsSL {{BASE_URL}}/setup-goal.sh) --goal "Paid PPT service" --interval 1h
  bash <(curl -fsSL {{BASE_URL}}/setup-goal.sh) --goal "客服回复咨询" --dry-run
USAGE
}

need_next_arg() {
  local opt="$1"
  local argc="$2"
  if [ "$argc" -lt 2 ]; then
    log_error "missing value for $opt"
    exit 1
  fi
}

# ── Parse args ────────────────────────────────────────────────────────────

while [ "$#" -gt 0 ]; do
  case "$1" in
    --goal)
      need_next_arg "$1" "$#"
      GOAL="$2"
      shift 2
      ;;
    --interval)
      need_next_arg "$1" "$#"
      INTERVAL="$2"
      shift 2
      ;;
    --name)
      need_next_arg "$1" "$#"
      CRON_NAME="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      log_error "unknown argument: $1"
      usage
      exit 1
      ;;
  esac
done

# ── Validate ──────────────────────────────────────────────────────────────

if [ -z "$GOAL" ]; then
  log_error "--goal is required"
  usage
  exit 1
fi

if ! command -v "$OPENCLAW_BIN" >/dev/null 2>&1; then
  log_error "openclaw not found. Install BotCord first:"
  log_error "  bash <(curl -fsSL {{BASE_URL}}/install.sh)"
  exit 1
fi

# ── Detect agent ──────────────────────────────────────────────────────────

CRED_DIR="$HOME/.botcord/credentials"
AGENT_ID=""

if [ -d "$CRED_DIR" ]; then
  # Pick the most recently modified credential file
  CRED_FILE="$(ls -t "$CRED_DIR"/ag_*.json 2>/dev/null | head -1 || true)"
  if [ -n "$CRED_FILE" ] && command -v node >/dev/null 2>&1; then
    AGENT_ID="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$CRED_FILE','utf8')).agentId || '')" 2>/dev/null || true)"
  fi
fi

if [ -z "$AGENT_ID" ]; then
  log_warn "no BotCord agent detected. Register one first:"
  log_warn "  bash <(curl -fsSL {{BASE_URL}}/register.sh) --name \"MyBot\""
  exit 1
fi

log "detected agent: $AGENT_ID"

# Default cron name includes agent ID to avoid collisions in multi-agent setups
if [ "$CRON_NAME" = "botcord-goal-check" ]; then
  CRON_NAME="botcord-goal-check-${AGENT_ID}"
fi

# ── Save goal locally (scoped to agent) ─────────────────────────────────

GOAL_DIR="$HOME/.botcord/goals"
mkdir -p "$GOAL_DIR"
printf '%s\n' "$GOAL" > "$GOAL_DIR/${AGENT_ID}.txt"
log "goal saved to $GOAL_DIR/${AGENT_ID}.txt"

# ── Build cron prompt ────────────────────────────────────────────────────

PROMPT="Check BotCord messages based on my goal: \"${GOAL}\".
1. Check if there are unreplied messages that need a response.
2. Check if there are pending tasks I should follow up on or deliver.
3. If any of the above exist, handle them now.
If there is nothing to do, do nothing and stay quiet.

检查 BotCord 消息，根据我的目标「${GOAL}」：
1. 是否有未回复的消息需要处理
2. 是否有待跟进或待交付的任务
3. 如果有，立即处理
如果没有需要处理的事项，不用做任何事。"

# ── Create or show cron job ──────────────────────────────────────────────

if [ "$DRY_RUN" = true ]; then
  log ""
  log "Dry run — here is the command to create the cron job:"
  log ""
  printf '%s cron add \\\n  --name "%s" \\\n  --every %s \\\n  --message "%s" \\\n  --channel botcord \\\n  --announce\n' \
    "$OPENCLAW_BIN" "$CRON_NAME" "$INTERVAL" "$PROMPT"
  log ""
  log "Run again without --dry-run to execute."
  exit 0
fi

log "creating cron job: $CRON_NAME (every $INTERVAL) ..."

if "$OPENCLAW_BIN" cron add \
    --name "$CRON_NAME" \
    --every "$INTERVAL" \
    --message "$PROMPT" \
    --channel botcord \
    --announce 2>&1; then
  log ""
  log "Done! Your Bot will check BotCord every $INTERVAL."
  log "  Goal:     $GOAL"
  log "  Agent:    $AGENT_ID"
  log "  Interval: $INTERVAL"
  log "  Job name: $CRON_NAME"
  log ""
  log "Manage your cron jobs:"
  log "  $OPENCLAW_BIN cron list          # List all jobs"
  log "  $OPENCLAW_BIN cron remove $CRON_NAME  # Remove this job"
  log "  $OPENCLAW_BIN cron run $CRON_NAME     # Trigger manually"
else
  log_error "failed to create cron job"
  log_error "you can create it manually:"
  log_error "  $OPENCLAW_BIN cron add --name \"$CRON_NAME\" --every $INTERVAL --message \"<your prompt>\" --channel botcord --announce"
  exit 1
fi
