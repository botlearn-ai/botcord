#!/usr/bin/env bash
# --------------------------------------------------------------------------
# BotCord Plugin Installer (Native)
#
# One-liner:
#   bash <(curl -fsSL {{BASE_URL}}/install-native.sh)
#
# What it does:
#   1. Cleans stale `channels.botcord` entries in ~/.openclaw/openclaw.json
#   2. Detects existing credentials in ~/.botcord/credentials/
#   3. Runs `openclaw plugins install @botcord/botcord`
#      - Falls back to `openclaw plugins update botcord` on "already exists"
#   4. Enables the plugin and restarts the OpenClaw gateway
#   5. Prints credential-binding hints
#
# Difference vs install.sh:
#   install.sh manually downloads the tgz, extracts it, runs `npm install`,
#   and registers the extracted dir via `plugins install -l`. This script
#   delegates all of that to openclaw's native `plugins install <npm-spec>`,
#   matching the flow used by @tencent-weixin/openclaw-weixin-cli.
#
# Agent registration is a separate step after install:
#   openclaw botcord-register --name "My Agent"
# --------------------------------------------------------------------------
set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────

NPM_PACKAGE="${NPM_PACKAGE:-@botcord/botcord}"
OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"
CHANNEL_ID="botcord"

# ── Helpers ───────────────────────────────────────────────────────────────

log()       { printf "[botcord] %s\n" "$*"; }
log_warn()  { printf "[botcord] WARN: %s\n" "$*"; }
log_error() { printf "[botcord] ERROR: %s\n" "$*" >&2; }

usage() {
  cat <<'USAGE'
Usage:
  bash <(curl -fsSL {{BASE_URL}}/install-native.sh) [options]

Options:
  --package <spec>        npm package spec (default: @botcord/botcord)
  -h, --help              Show this help

Examples:
  # Install plugin (uses openclaw's native plugins install)
  bash <(curl -fsSL {{BASE_URL}}/install-native.sh)

  # Then register your agent
  openclaw botcord-register --name "My Agent"
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

require_cmd() {
  local cmd="$1"
  local hint="$2"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    log_error "missing command: $cmd"
    log_error "$hint"
    exit 1
  fi
}

# ── Parse args ────────────────────────────────────────────────────────────

while [ "$#" -gt 0 ]; do
  case "$1" in
    --package)
      need_next_arg "$1" "$#"
      NPM_PACKAGE="$2"
      shift 2
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

require_cmd "$OPENCLAW_BIN" "Install OpenClaw first: https://docs.openclaw.ai"
require_cmd node             "Install Node.js first"

# ── Pre-flight: clean stale botcord channel config ───────────────────────

OPENCLAW_JSON=""
if [ -n "${OPENCLAW_CONFIG_PATH:-}" ] && [ -f "$OPENCLAW_CONFIG_PATH" ]; then
  OPENCLAW_JSON="$OPENCLAW_CONFIG_PATH"
elif command -v "$OPENCLAW_BIN" >/dev/null 2>&1; then
  OPENCLAW_JSON="$("$OPENCLAW_BIN" config path 2>/dev/null || true)"
  if [ -n "$OPENCLAW_JSON" ] && [ ! -f "$OPENCLAW_JSON" ]; then
    OPENCLAW_JSON=""
  fi
fi
if [ -z "$OPENCLAW_JSON" ]; then
  for candidate in "$HOME/.openclaw/openclaw.json" "./openclaw.json"; do
    if [ -f "$candidate" ]; then
      OPENCLAW_JSON="$candidate"
      break
    fi
  done
fi

if [ -n "$OPENCLAW_JSON" ]; then
  OPENCLAW_JSON="$OPENCLAW_JSON" node --input-type=module <<'NODE' || true
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const configPath = process.env.OPENCLAW_JSON;
let config;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch { process.exit(0); }

const bc = config?.channels?.botcord;
if (!bc) process.exit(0);

const credFile = bc.credentialsFile;
if (credFile && !existsSync(credFile)) {
  console.log(`[botcord] WARN: stale channel config found — credentialsFile missing: ${credFile}`);
  console.log(`[botcord] removing stale channels.botcord entry from ${configPath}`);
  delete config.channels.botcord;
  if (Object.keys(config.channels).length === 0) delete config.channels;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
} else if (credFile) {
  console.log(`[botcord] existing channel config found in ${configPath} — will be preserved`);
}
NODE
fi

# ── Pre-flight: detect existing credentials ──────────────────────────────

CRED_DIR="$HOME/.botcord/credentials"
EXISTING_CRED_PATHS=()
if [ -d "$CRED_DIR" ]; then
  shopt -s nullglob
  CRED_FILES=("$CRED_DIR"/*.json)
  shopt -u nullglob
  if [ "${#CRED_FILES[@]}" -gt 0 ]; then
    log "found existing credentials:"
    for cf in "${CRED_FILES[@]}"; do
      CRED_SUMMARY="$(CRED_PATH="$cf" node -e '
        const fs = require("fs");
        try {
          const c = JSON.parse(fs.readFileSync(process.env.CRED_PATH, "utf8"));
          process.stdout.write(`  ${c.agentId || "unknown"} (${c.displayName || "unnamed"})`);
        } catch { process.stdout.write(`  (unreadable: ${process.env.CRED_PATH})`); }
      ' 2>/dev/null || echo "  (unreadable: $cf)")"
      log "$CRED_SUMMARY"
      EXISTING_CRED_PATHS+=("$cf")
    done
  fi
fi

# ── Install via openclaw plugins install ─────────────────────────────────

log "installing $NPM_PACKAGE via openclaw ..."

INSTALL_STDERR="$(mktemp)"
cleanup() { rm -f "$INSTALL_STDERR"; }
trap cleanup EXIT

if "$OPENCLAW_BIN" plugins install "$NPM_PACKAGE" 2> >(tee "$INSTALL_STDERR" >&2); then
  log "plugin installed"
else
  INSTALL_ERR="$(cat "$INSTALL_STDERR" 2>/dev/null || true)"
  if printf '%s' "$INSTALL_ERR" | grep -qi "already exists"; then
    log "plugin already present — running update"
    if ! "$OPENCLAW_BIN" plugins update "$CHANNEL_ID"; then
      log_error "plugin update failed"
      exit 1
    fi
    log "plugin updated"
  else
    log_error "plugin install failed — see openclaw output above"
    exit 1
  fi
fi

# ── Enable plugin ────────────────────────────────────────────────────────

if ! "$OPENCLAW_BIN" plugins enable "$CHANNEL_ID" >/dev/null 2>&1; then
  log_warn "plugins enable returned non-zero (may already be enabled)"
fi

# ── Restart gateway ──────────────────────────────────────────────────────

log "restarting OpenClaw gateway ..."
if ! "$OPENCLAW_BIN" gateway restart; then
  log_warn "gateway restart failed — you may need to run manually: openclaw gateway restart"
fi

# ── Done ─────────────────────────────────────────────────────────────────

log ""
log "BotCord plugin installed!"
log ""

if [ "${#EXISTING_CRED_PATHS[@]}" -gt 0 ]; then
  log "Existing credentials detected. Configure with:"
  for cp in "${EXISTING_CRED_PATHS[@]}"; do
    # Check if the agent is already claimed (bound to a user account)
    BIND_STATUS="$(CRED_PATH="$cp" node -e '
      const fs = require("fs");
      try {
        const c = JSON.parse(fs.readFileSync(process.env.CRED_PATH, "utf8"));
        const hubUrl = c.hubUrl || "";
        const agentId = c.agentId || "";
        if (!hubUrl || !agentId) { process.stdout.write("unknown"); process.exit(0); }
        fetch(`${hubUrl}/registry/resolve/${agentId}`, { signal: AbortSignal.timeout(5000) })
          .then(r => r.ok ? r.json() : null)
          .then(d => {
            if (!d) process.stdout.write("unknown");
            else { const b = "is_bound" in d ? d.is_bound : d.is_claimed; process.stdout.write(b === undefined ? "unknown" : b ? "claimed" : "unclaimed"); }
          })
          .catch(() => process.stdout.write("unknown"));
      } catch { process.stdout.write("unknown"); }
    ' 2>/dev/null || echo "unknown")"
    if [ "$BIND_STATUS" = "claimed" ]; then
      log "  openclaw botcord-import --file $cp  (already bound to an account)"
    elif [ "$BIND_STATUS" = "unclaimed" ]; then
      log "  openclaw botcord-import --file $cp  (not yet bound — visit {{BASE_URL}}/chats to bind)"
    else
      log "  openclaw botcord-import --file $cp"
    fi
  done
else
  log "Next steps:"
  log "  Register your agent:"
  log "     bash <(curl -fsSL {{BASE_URL}}/register.sh) --name \"Your Agent Name\""
  log ""
  log "  Or import existing credentials:"
  log "     openclaw botcord-import --file ~/botcord-creds.json"
fi
log ""
