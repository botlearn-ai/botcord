#!/usr/bin/env bash
# --------------------------------------------------------------------------
# BotCord Plugin Uninstaller
#
# One-liner:
#   bash <(curl -fsSL {{BASE_URL}}/uninstall.sh)
#
# What it does:
#   1. Disables the BotCord plugin via OpenClaw CLI
#   2. Removes plugin files from ~/.openclaw/extensions/botcord/
#   3. Cleans up channel config from openclaw.json (safely via node, with backup)
#   4. Preserves credentials in ~/.botcord/ (use --purge to delete them)
#
# This script is the recovery path when OpenClaw is broken due to a
# corrupted openclaw.json. It does NOT require a working OpenClaw install.
# --------------------------------------------------------------------------
set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────

OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"
TARGET_DIR="${TARGET_DIR:-$HOME/.openclaw/extensions/botcord}"
PURGE="0"

# ── Helpers ───────────────────────────────────────────────────────────────

log()       { printf "[botcord] %s\n" "$*"; }
log_warn()  { printf "[botcord] WARN: %s\n" "$*"; }
log_error() { printf "[botcord] ERROR: %s\n" "$*" >&2; }

usage() {
  cat <<'USAGE'
Usage:
  bash <(curl -fsSL {{BASE_URL}}/uninstall.sh) [options]

Options:
  --purge               Also delete credentials from ~/.botcord/
  --target-dir <path>   Plugin directory (default: ~/.openclaw/extensions/botcord)
  -h, --help            Show this help
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
    --purge)
      PURGE="1"
      shift
      ;;
    --target-dir)
      need_next_arg "$1" "$#"
      TARGET_DIR="$2"
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

# ── Step 1: Disable plugin via OpenClaw CLI (best-effort) ────────────────

if command -v "$OPENCLAW_BIN" >/dev/null 2>&1; then
  log "disabling BotCord plugin ..."
  "$OPENCLAW_BIN" plugins disable botcord >/dev/null 2>&1 && log "  plugin disabled" || log_warn "  could not disable (may already be disabled or OpenClaw is broken)"
else
  log_warn "openclaw CLI not found — skipping plugin disable"
fi

# ── Step 2: Remove plugin files ──────────────────────────────────────────

if [ -d "$TARGET_DIR" ]; then
  log "removing plugin files from $TARGET_DIR ..."
  rm -rf "$TARGET_DIR"
  log "  done"
else
  log "no plugin files found at $TARGET_DIR"
fi

# Also clean up any leftover backups from failed installs
shopt -s nullglob
for old_backup in "${TARGET_DIR}".bak.*; do
  log "  cleaning up backup: $(basename "$old_backup")"
  rm -rf "$old_backup"
done
shopt -u nullglob

# ── Step 3: Clean openclaw.json safely ───────────────────────────────────
# This is the critical part — uses Node.js to safely parse/modify JSON
# with a backup, so a crash here can't corrupt the config.

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

if [ -n "$OPENCLAW_JSON" ] && command -v node >/dev/null 2>&1; then
  log "cleaning BotCord entries from $(basename "$OPENCLAW_JSON") ..."
  OPENCLAW_JSON="$OPENCLAW_JSON" TARGET_DIR="$TARGET_DIR" node --input-type=module <<'NODE' || true
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";

const configPath = process.env.OPENCLAW_JSON;
let raw, config;
try {
  raw = readFileSync(configPath, "utf8");
  config = JSON.parse(raw);
} catch (err) {
  console.log(`[botcord] WARN: could not parse ${configPath}: ${err.message}`);
  console.log("[botcord] WARN: config file may already be corrupted — attempting repair");

  // Try to fix common JSON corruption: trailing commas, missing braces
  try {
    // Remove trailing commas before } or ]
    let fixed = raw
      .replace(/,\s*([\]}])/g, "$1")
      // Remove any bare "botcord" fragments that might be leftover
      .replace(/"botcord"\s*:\s*\{[^}]*\}\s*,?/g, "");
    config = JSON.parse(fixed);
    console.log("[botcord] repair succeeded — will write cleaned config");
  } catch {
    console.log("[botcord] WARN: could not repair config — skipping JSON cleanup");
    console.log("[botcord] HINT: manually check " + configPath);
    process.exit(0);
  }
}

let changed = false;

// Remove channels.botcord
if (config?.channels?.botcord) {
  delete config.channels.botcord;
  if (Object.keys(config.channels).length === 0) delete config.channels;
  changed = true;
  console.log("[botcord]   removed channels.botcord");
}

// Remove plugin load path entries pointing to botcord
const loadPaths = config?.plugins?.load?.paths;
if (Array.isArray(loadPaths)) {
  const before = loadPaths.length;
  const targetDir = process.env.TARGET_DIR;
  config.plugins.load.paths = loadPaths.filter(
    (p) => !p.includes("botcord") && p !== targetDir
  );
  if (config.plugins.load.paths.length < before) {
    changed = true;
    console.log("[botcord]   removed botcord from plugins.load.paths");
  }
  if (config.plugins.load.paths.length === 0) {
    delete config.plugins.load.paths;
    if (Object.keys(config.plugins.load).length === 0) delete config.plugins.load;
  }
}

// Remove plugin entries.botcord
if (config?.plugins?.entries?.botcord) {
  delete config.plugins.entries.botcord;
  if (Object.keys(config.plugins.entries).length === 0) delete config.plugins.entries;
  changed = true;
  console.log("[botcord]   removed plugins.entries.botcord");
}

// Remove from plugins.allow
const allowList = config?.plugins?.allow;
if (Array.isArray(allowList)) {
  const idx = allowList.indexOf("botcord");
  if (idx !== -1) {
    allowList.splice(idx, 1);
    changed = true;
    console.log("[botcord]   removed botcord from plugins.allow");
  }
}

// Clean up empty plugins object
if (config?.plugins && Object.keys(config.plugins).length === 0) {
  delete config.plugins;
}

if (changed) {
  // Backup before writing
  const backupPath = configPath + ".bak." + Date.now();
  copyFileSync(configPath, backupPath);
  console.log("[botcord]   backed up to " + backupPath);

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  console.log("[botcord]   config updated");
} else {
  console.log("[botcord]   no BotCord entries found in config");
}
NODE
elif [ -n "$OPENCLAW_JSON" ]; then
  log_warn "node not found — cannot clean openclaw.json automatically"
  log_warn "manually remove 'channels.botcord' and botcord plugin entries from $OPENCLAW_JSON"
fi

# ── Step 4: Handle credentials ───────────────────────────────────────────

CRED_DIR="$HOME/.botcord/credentials"

if [ "$PURGE" = "1" ]; then
  if [ -d "$CRED_DIR" ]; then
    shopt -s nullglob
    CRED_FILES=("$CRED_DIR"/*.json)
    shopt -u nullglob
    if [ "${#CRED_FILES[@]}" -gt 0 ]; then
      log "deleting ${#CRED_FILES[@]} credential file(s) ..."
      for cf in "${CRED_FILES[@]}"; do
        rm -f "$cf"
        log "  deleted $(basename "$cf")"
      done
    fi
    # Remove empty dirs
    rmdir "$CRED_DIR" 2>/dev/null || true
    rmdir "$HOME/.botcord" 2>/dev/null || true
  fi
else
  if [ -d "$CRED_DIR" ]; then
    shopt -s nullglob
    CRED_FILES=("$CRED_DIR"/*.json)
    shopt -u nullglob
    if [ "${#CRED_FILES[@]}" -gt 0 ]; then
      log "credentials preserved in $CRED_DIR (${#CRED_FILES[@]} file(s))"
      log "  use --purge to also delete credentials"
      log "  to reinstall later: bash <(curl -fsSL {{BASE_URL}}/install.sh)"
    fi
  fi
fi

# ── Done ──────────────────────────────────────────────────────────────────

log ""
log "BotCord plugin uninstalled."
if command -v "$OPENCLAW_BIN" >/dev/null 2>&1; then
  log "Restart OpenClaw to apply: openclaw gateway restart"
fi
log ""
