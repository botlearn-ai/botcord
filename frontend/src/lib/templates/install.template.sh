#!/usr/bin/env bash
# --------------------------------------------------------------------------
# BotCord Plugin Installer
#
# One-liner:
#   bash <(curl -fsSL {{BASE_URL}}/install.sh)
#
# What it does:
#   1. Downloads @botcord/botcord tgz from npm registry
#   2. Extracts to ~/.openclaw/extensions/botcord/, runs npm install
#   3. Registers plugin locally via `openclaw plugins install -l`
#   4. Restarts the OpenClaw gateway
#
# Agent registration is a separate step after install:
#   openclaw botcord-register --name "My Agent"
# --------------------------------------------------------------------------
set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────

NPM_PACKAGE="${NPM_PACKAGE:-@botcord/botcord}"
NPM_BIN="${NPM_BIN:-npm}"
OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"
TARGET_DIR="${TARGET_DIR:-$HOME/.openclaw/extensions/botcord}"

# ── Helpers ───────────────────────────────────────────────────────────────

log()       { printf "[botcord] %s\n" "$*"; }
log_warn()  { printf "[botcord] WARN: %s\n" "$*"; }
log_error() { printf "[botcord] ERROR: %s\n" "$*" >&2; }

usage() {
  cat <<'USAGE'
Usage:
  bash <(curl -fsSL {{BASE_URL}}/install.sh) [options]

Options:
  --target-dir <path>     Plugin install directory (default: ~/.openclaw/extensions/botcord)
  --package <spec>        npm package spec (default: @botcord/botcord)
  -h, --help              Show this help

Examples:
  # Install plugin
  bash <(curl -fsSL {{BASE_URL}}/install.sh)

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

read_plugin_version() {
  local dir="$1"
  PLUGIN_DIR="$dir" node -e '
    const fs = require("fs");
    const path = require("path");
    const dir = process.env.PLUGIN_DIR;
    for (const f of ["openclaw.plugin.json", "package.json"]) {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        if (p.version) { process.stdout.write(p.version); process.exit(0); }
      } catch {}
    }
    process.exit(1);
  ' 2>/dev/null
}

# ── Parse args ────────────────────────────────────────────────────────────

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target-dir)
      need_next_arg "$1" "$#"
      TARGET_DIR="$2"
      shift 2
      ;;
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
require_cmd "$NPM_BIN"      "Install Node.js + npm first"
require_cmd node             "Install Node.js first"
require_cmd tar              "Install tar first"

# ── Pre-flight checks ──────────────────────────────────────────────────

# 1. Detect and clean stale botcord config in openclaw.json
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

# 2. Detect existing credentials
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

# ── Temp dir & cleanup ───────────────────────────────────────────────────

TMP_DIR="$(mktemp -d)"
INSTALL_TS="$(date +%s)"
BACKUP_DIR=""
ROLLBACK_NEEDED="0"

on_exit() {
  local exit_code=$?

  if [ "$ROLLBACK_NEEDED" = "1" ] && [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
    log_warn "install failed (exit=$exit_code), rolling back to previous version"
    rm -rf "$TARGET_DIR"
    mv "$BACKUP_DIR" "$TARGET_DIR"
    "$OPENCLAW_BIN" plugins install -l "$TARGET_DIR" >/dev/null 2>&1 || true
    "$OPENCLAW_BIN" plugins enable botcord >/dev/null 2>&1 || true
    "$OPENCLAW_BIN" gateway restart >/dev/null 2>&1 || true
    log_warn "rollback completed"
  fi

  rm -rf "$TMP_DIR"
}
trap on_exit EXIT

# ── Step 1: Download tgz from npm ────────────────────────────────────────

log "downloading $NPM_PACKAGE from npm ..."

if ! "$NPM_BIN" pack "$NPM_PACKAGE" --pack-destination "$TMP_DIR" > "$TMP_DIR/pack_output.txt" 2>&1; then
  log_error "failed to download $NPM_PACKAGE from npm"
  cat "$TMP_DIR/pack_output.txt" >&2
  exit 1
fi

PACKED_FILE="$(find "$TMP_DIR" -name '*.tgz' -maxdepth 1 | head -1)"
if [ -z "$PACKED_FILE" ] || [ ! -f "$PACKED_FILE" ]; then
  log_error "npm pack did not produce a tgz file"
  exit 1
fi

log "downloaded $(du -h "$PACKED_FILE" | cut -f1 | tr -d ' ')"

# ── Step 2: Stage — extract & install deps ───────────────────────────────

log "staging plugin ..."

STAGING_DIR="$TMP_DIR/staged"
mkdir -p "$STAGING_DIR"
tar -xzf "$PACKED_FILE" -C "$STAGING_DIR" --strip-components=1

if [ ! -f "$STAGING_DIR/package.json" ]; then
  log_error "invalid package (missing package.json)"
  exit 1
fi

(
  cd "$STAGING_DIR"
  "$NPM_BIN" install --omit=dev --ignore-scripts 2>&1 | tail -3
)

# Sanity check
if [ -f "$STAGING_DIR/openclaw.plugin.json" ]; then
  MAIN_FILE="$(node -e "
    const p = require('$STAGING_DIR/openclaw.plugin.json');
    const m = p.main || 'index.js';
    process.stdout.write(require('path').resolve('$STAGING_DIR', m));
  " 2>/dev/null || true)"
  if [ -n "$MAIN_FILE" ] && [ -f "$MAIN_FILE" ]; then
    log "sanity check passed"
  else
    log_warn "could not verify entry point (non-fatal)"
  fi
fi

NEW_VERSION="$(read_plugin_version "$STAGING_DIR" || echo "unknown")"
log "version: $NEW_VERSION"

# ── Step 3: Backup existing install ──────────────────────────────────────

if [ -d "$TARGET_DIR" ]; then
  OLD_VERSION="$(read_plugin_version "$TARGET_DIR" || echo "unknown")"
  log "upgrading from $OLD_VERSION -> $NEW_VERSION"

  "$OPENCLAW_BIN" plugins disable botcord >/dev/null 2>&1 || true

  BACKUP_DIR="${TARGET_DIR}.bak.${INSTALL_TS}"
  rm -rf "$BACKUP_DIR"
  mv "$TARGET_DIR" "$BACKUP_DIR"
  log "backed up existing install"
else
  log "fresh install"
fi
ROLLBACK_NEEDED="1"

# ── Step 4: Atomic swap ──────────────────────────────────────────────────

mkdir -p "$(dirname "$TARGET_DIR")"
mv "$STAGING_DIR" "$TARGET_DIR"

# ── Step 5: Register & enable ────────────────────────────────────────────

log "registering plugin with OpenClaw ..."
"$OPENCLAW_BIN" plugins install -l "$TARGET_DIR" >/dev/null 2>&1 || true
"$OPENCLAW_BIN" plugins enable botcord

ROLLBACK_NEEDED="0"
log "plugin installed successfully"

# Clean up backups
if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
  rm -rf "$BACKUP_DIR"
fi
shopt -s nullglob
for old_backup in "${TARGET_DIR}".bak.*; do
  rm -rf "$old_backup"
done
shopt -u nullglob

# ── Done ──────────────────────────────────────────────────────────────────

log ""
log "BotCord plugin installed!"
log ""

if [ "${#EXISTING_CRED_PATHS[@]}" -gt 0 ]; then
  log "Existing credentials detected. Configure with:"
  for cp in "${EXISTING_CRED_PATHS[@]}"; do
    log "  openclaw botcord-import --file $cp"
  done
  log ""
  log "Then restart the OpenClaw gateway to load the plugin."
else
  log "Next steps:"
  log "  1. Register your agent:"
  log "     bash <(curl -fsSL {{BASE_URL}}/register.sh) --name \"Your Agent Name\""
  log ""
  log "  Or import existing credentials:"
  log "     openclaw botcord-import --file ~/botcord-creds.json"
  log ""
  log "  2. Restart the OpenClaw gateway to load the plugin"
fi
log ""
