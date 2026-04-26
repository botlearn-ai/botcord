#!/usr/bin/env bash
# --------------------------------------------------------------------------
# BotCord OpenClaw plugin installer (bind-code onboarding)
#
# Issued by the dashboard; runs on a machine that already has OpenClaw +
# Node.js + npm. The dashboard pre-fills --bind-code and --bind-nonce in
# the install command.
#
# What it does, in order:
#   1. Stages @botcord/botcord into ~/.openclaw/extensions/botcord
#      (download tarball or clone source, npm install --omit=dev, atomic swap)
#   2. Generates an Ed25519 keypair locally (private key never leaves disk)
#   3. Signs the bind-nonce and POSTs /api/users/me/agents/install-claim
#   4. Writes ~/.botcord/credentials/<agentId>.json with chmod 600
#   5. Configures channels.botcord in openclaw.json (CLI or direct edit)
#   6. Restarts the OpenClaw gateway (or prints a docker-restart hint)
#
# Invariants:
#   - The bind code is single-use; if any pre-claim step fails the code
#     remains pending so the user can retry.
#   - The Ed25519 private key is never sent to the server. The server sees
#     only the public key + a signature over the bind-nonce.
#   - Trap on_exit archives the run log to ~/.botcord/log/install_fail_<ts>.log
#     when the installer aborts non-zero.
# --------------------------------------------------------------------------
set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────

SERVER_URL="${BOTCORD_SERVER_URL:-https://api.botcord.chat}"
PLUGIN_PACKAGE="@botcord/botcord"
PLUGIN_VERSION=""
TGZ_URL=""
TGZ_PATH=""
FROM_SOURCE_DIR=""
TARGET_DIR_DEFAULT="$HOME/.openclaw/extensions/botcord"
TARGET_DIR="$TARGET_DIR_DEFAULT"
ACCOUNT=""
AGENT_NAME=""
SKIP_PLUGIN_INSTALL="false"
SKIP_RESTART="false"
FORCE_REINSTALL="false"
OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"
OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-}"

BIND_CODE=""
BIND_NONCE=""

# ── Logging + cleanup ─────────────────────────────────────────────────────

LOG_DIR="$HOME/.botcord/log"
TS="$(date +%Y%m%d_%H%M%S)"
RUN_LOG="${TMPDIR:-/tmp}/botcord-install-${TS}-$$.log"
STAGING_DIR=""
# Swap state for the post-claim plugin replacement. ``BACKUP_DIR`` names
# the directory that holds the user's previous plugin while we move the
# staged one into place. ``SWAP_DONE`` flips to ``true`` only after both
# moves succeed; if the script dies between them, on_exit restores the
# backup so the user is never left with a missing plugin.
BACKUP_DIR=""
SWAP_DONE="false"

mkdir -p "$LOG_DIR" 2>/dev/null || true
: > "$RUN_LOG" 2>/dev/null || RUN_LOG="/dev/null"

log()       { printf "[botcord] %s\n" "$*" | tee -a "$RUN_LOG"; }
log_warn()  { printf "[botcord] WARN: %s\n" "$*" | tee -a "$RUN_LOG"; }
log_error() { printf "[botcord] ERROR: %s\n" "$*" | tee -a "$RUN_LOG" >&2; }
log_quiet() { printf "[botcord] %s\n" "$*" >> "$RUN_LOG"; }  # log only to file (private)

on_exit() {
  local code=$?
  if [ "$code" -ne 0 ]; then
    # Plugin-swap rollback: if we stashed the previous install but did
    # not finish moving the staged one into place, restore the backup
    # so the live target never ends up missing.
    if [ "$SWAP_DONE" != "true" ] && [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
      log_error "rolling back plugin swap; restoring $BACKUP_DIR → $TARGET_DIR"
      rm -rf -- "$TARGET_DIR" 2>/dev/null || true
      if mv -- "$BACKUP_DIR" "$TARGET_DIR" 2>>"$RUN_LOG"; then
        log_error "previous plugin restored at $TARGET_DIR"
      else
        log_error "rollback failed; previous plugin is at $BACKUP_DIR"
      fi
    fi
    if [ -d "${STAGING_DIR:-/nonexistent}" ]; then
      rm -rf -- "$STAGING_DIR" 2>/dev/null || true
    fi
    if [ "$RUN_LOG" != "/dev/null" ] && [ -s "$RUN_LOG" ]; then
      local archive="$LOG_DIR/install_fail_${TS}.log"
      cp -- "$RUN_LOG" "$archive" 2>/dev/null && \
        printf "[botcord] install failed; full log archived to %s\n" "$archive" >&2
    fi
  else
    [ "$RUN_LOG" != "/dev/null" ] && rm -f -- "$RUN_LOG" 2>/dev/null || true
  fi
}
trap on_exit EXIT

# ── Helpers ───────────────────────────────────────────────────────────────

usage() {
  cat <<USAGE
Usage:
  curl -fsSL <hub>/openclaw/install.sh | bash -s -- --bind-code <bd_xxx> --bind-nonce <nonce> [options]

Required (issued by the dashboard):
  --bind-code <bd_xxx>      One-time bind code from "Add Agent to OpenClaw"
  --bind-nonce <base64>     Ticket nonce to sign with the local keypair

Plugin source (mutually exclusive; default: npm registry):
  --plugin-version <ver>    Pin a specific version of $PLUGIN_PACKAGE
  --tgz-url <url>           Install plugin from a tarball URL
  --tgz-path <path>         Install plugin from a local tarball
  --from-source <dir>       Install plugin from a checked-out source dir

Configuration:
  --server-url <url>        BotCord hub URL (default: $SERVER_URL)
  --account <id>            Multi-account namespace (channels.botcord.accounts.<id>)
  --target-dir <path>       Plugin install dir (default: $TARGET_DIR_DEFAULT)
  --name <name>             Override agent display name (otherwise dashboard's intended_name wins)
  --force-reinstall         Replace any existing plugin install at target dir
  --skip-plugin-install     Only do claim + credentials + config; assume plugin already installed
  --skip-restart            Skip gateway restart (you'll restart manually)
  -h, --help                Show this help

Environment:
  BOTCORD_SERVER_URL         Default for --server-url
  OPENCLAW_BIN               Path to openclaw CLI (default: openclaw)
  OPENCLAW_CONFIG_PATH       Direct openclaw.json path (skips CLI; useful in containers)
USAGE
}

need_next_arg() {
  local opt="$1" argc="$2"
  if [ "$argc" -lt 2 ]; then
    log_error "missing value for $opt"
    exit 1
  fi
}

require_cmd() {
  local cmd="$1" hint="$2"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    log_error "missing command: $cmd"
    log_error "$hint"
    exit 1
  fi
}

# ── Parse args ────────────────────────────────────────────────────────────

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bind-code)       need_next_arg "$1" "$#"; BIND_CODE="$2"; shift 2 ;;
    --bind-nonce)      need_next_arg "$1" "$#"; BIND_NONCE="$2"; shift 2 ;;
    --server-url)      need_next_arg "$1" "$#"; SERVER_URL="$2"; shift 2 ;;
    --plugin-version)  need_next_arg "$1" "$#"; PLUGIN_VERSION="$2"; shift 2 ;;
    --tgz-url)         need_next_arg "$1" "$#"; TGZ_URL="$2"; shift 2 ;;
    --tgz-path)        need_next_arg "$1" "$#"; TGZ_PATH="$2"; shift 2 ;;
    --from-source)     need_next_arg "$1" "$#"; FROM_SOURCE_DIR="$2"; shift 2 ;;
    --target-dir)      need_next_arg "$1" "$#"; TARGET_DIR="$2"; shift 2 ;;
    --account)         need_next_arg "$1" "$#"; ACCOUNT="$2"; shift 2 ;;
    --name)            need_next_arg "$1" "$#"; AGENT_NAME="$2"; shift 2 ;;
    --force-reinstall) FORCE_REINSTALL="true"; shift ;;
    --skip-plugin-install) SKIP_PLUGIN_INSTALL="true"; shift ;;
    --skip-restart)    SKIP_RESTART="true"; shift ;;
    -h|--help)         usage; exit 0 ;;
    *) log_error "unknown argument: $1"; usage; exit 1 ;;
  esac
done

# ── Validate ──────────────────────────────────────────────────────────────

if [ -z "$BIND_CODE" ] || [ -z "$BIND_NONCE" ]; then
  log_error "--bind-code and --bind-nonce are required"
  usage
  exit 1
fi

case "$BIND_CODE" in bd_*) ;; *) log_error "--bind-code must start with bd_"; exit 1 ;; esac

require_cmd node "Install Node.js >= 18 first (https://nodejs.org)"
require_cmd curl "Install curl first"

# Reject pathological combinations early.
SOURCES_SET=0
[ -n "$TGZ_URL" ]         && SOURCES_SET=$((SOURCES_SET + 1))
[ -n "$TGZ_PATH" ]        && SOURCES_SET=$((SOURCES_SET + 1))
[ -n "$FROM_SOURCE_DIR" ] && SOURCES_SET=$((SOURCES_SET + 1))
if [ "$SOURCES_SET" -gt 1 ]; then
  log_error "--tgz-url, --tgz-path, --from-source are mutually exclusive"
  exit 1
fi

if [ "$SKIP_PLUGIN_INSTALL" != "true" ]; then
  require_cmd npm "Install npm (ships with Node.js)"
fi

# ── Step 1: Stage + npm install (no live swap yet) ───────────────────────
#
# We deliberately do *not* touch $TARGET_DIR before the claim step. That
# way a claim failure (expired bind code, server-side reject, network
# blip) leaves the user's existing plugin install untouched. The atomic
# swap into TARGET_DIR happens further down once we have credentials in
# hand.

WANT_PLUGIN_SWAP="false"
if [ "$SKIP_PLUGIN_INSTALL" = "true" ]; then
  log "skipping plugin install (--skip-plugin-install)"
elif [ -d "$TARGET_DIR" ] && [ "$FORCE_REINSTALL" != "true" ]; then
  log "plugin already installed at $TARGET_DIR (use --force-reinstall to replace)"
else
  WANT_PLUGIN_SWAP="true"
  STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/botcord-stage.XXXXXX")"
  log "staging plugin to $STAGING_DIR"

  if [ -n "$FROM_SOURCE_DIR" ]; then
    if [ ! -d "$FROM_SOURCE_DIR" ]; then
      log_error "--from-source dir does not exist: $FROM_SOURCE_DIR"
      exit 1
    fi
    # Pack the source dir to a tarball, then unpack into staging.
    SRC_TARBALL="$(cd "$FROM_SOURCE_DIR" && npm pack --silent --pack-destination "$STAGING_DIR" 2>>"$RUN_LOG")"
    tar -xzf "$STAGING_DIR/$SRC_TARBALL" -C "$STAGING_DIR" --strip-components=1
    rm -f -- "$STAGING_DIR/$SRC_TARBALL"
  elif [ -n "$TGZ_PATH" ]; then
    if [ ! -f "$TGZ_PATH" ]; then
      log_error "--tgz-path file does not exist: $TGZ_PATH"
      exit 1
    fi
    tar -xzf "$TGZ_PATH" -C "$STAGING_DIR" --strip-components=1
  elif [ -n "$TGZ_URL" ]; then
    LOCAL_TARBALL="$STAGING_DIR/plugin.tgz"
    log "downloading $TGZ_URL"
    curl -fsSL "$TGZ_URL" -o "$LOCAL_TARBALL" 2>>"$RUN_LOG"
    tar -xzf "$LOCAL_TARBALL" -C "$STAGING_DIR" --strip-components=1
    rm -f -- "$LOCAL_TARBALL"
  else
    # Default: pull from npm.
    SPEC="$PLUGIN_PACKAGE"
    [ -n "$PLUGIN_VERSION" ] && SPEC="${PLUGIN_PACKAGE}@${PLUGIN_VERSION}"
    log "fetching $SPEC from npm registry"
    REG_TARBALL="$(cd "$STAGING_DIR" && npm pack --silent "$SPEC" 2>>"$RUN_LOG")"
    tar -xzf "$STAGING_DIR/$REG_TARBALL" -C "$STAGING_DIR" --strip-components=1
    rm -f -- "$STAGING_DIR/$REG_TARBALL"
  fi

  log "installing plugin runtime dependencies (npm install --omit=dev --omit=peer)"
  ( cd "$STAGING_DIR" && npm install --omit=dev --omit=peer --no-audit --no-fund 2>>"$RUN_LOG" >/dev/null ) || {
    log_error "npm install failed; see $RUN_LOG for details"
    exit 1
  }
fi

# ── Step 2: Generate keypair, sign, claim ────────────────────────────────

log "claiming bind code on $SERVER_URL"

RESULT="$(
  SERVER_URL="$SERVER_URL" \
  BIND_CODE="$BIND_CODE" \
  BIND_NONCE="$BIND_NONCE" \
  AGENT_NAME="$AGENT_NAME" \
  node --input-type=module <<'NODE' 2>>"$RUN_LOG"
import { generateKeyPairSync, createPrivateKey, sign } from "node:crypto";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const serverUrl = process.env.SERVER_URL.replace(/\/+$/, "");
const bindCode  = process.env.BIND_CODE;
const bindNonce = process.env.BIND_NONCE;
const overrideName = process.env.AGENT_NAME || null;

// 1. Keygen — raw 32-byte Ed25519 seed (matches backend `generate_agent_id`
//    and protocol-core `generateKeypair`).
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const privDer = privateKey.export({ type: "pkcs8", format: "der" });
const privB64 = Buffer.from(privDer.subarray(-32)).toString("base64");
const pubDer  = publicKey.export({ type: "spki",  format: "der" });
const pubB64  = Buffer.from(pubDer.subarray(-32)).toString("base64");
const pubkeyFormatted = `ed25519:${pubB64}`;

// 2. Sign nonce — same algorithm as backend `verify_challenge_sig`:
//    base64-decode challenge, raw Ed25519 sign, base64-encode signature.
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const pk = createPrivateKey({
  key: Buffer.concat([PKCS8_PREFIX, Buffer.from(privB64, "base64")]),
  format: "der",
  type: "pkcs8",
});
const sig = sign(null, Buffer.from(bindNonce, "base64"), pk).toString("base64");

// 3. POST install-claim
const claimUrl = `${serverUrl}/api/users/me/agents/install-claim`;
const body = {
  bind_code: bindCode,
  pubkey: pubkeyFormatted,
  proof: { nonce: bindNonce, sig },
};
if (overrideName) body.name = overrideName;

const resp = await fetch(claimUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(20000),
});

if (!resp.ok) {
  const text = await resp.text().catch(() => "");
  process.stderr.write(`install-claim failed (${resp.status}): ${text}\n`);
  process.exit(1);
}
const data = await resp.json();

// 4. Write credentials.json (chmod 600). Matches the format used by
//    botcord-register.sh and read by the plugin.
const agentId = data.agent_id;
const credDir = join(homedir(), ".botcord", "credentials");
mkdirSync(credDir, { recursive: true, mode: 0o700 });
const credPath = join(credDir, `${agentId}.json`);
const hubUrl   = data.hub_url || serverUrl;
const credentials = {
  version: 1,
  hubUrl,
  agentId,
  keyId: data.key_id,
  privateKey: privB64,
  publicKey: pubB64,
  displayName: data.display_name || agentId,
  savedAt: new Date().toISOString(),
  token: data.agent_token || undefined,
  tokenExpiresAt: data.token_expires_at ?? undefined,
};
writeFileSync(credPath, JSON.stringify(credentials, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
chmodSync(credPath, 0o600);

process.stdout.write(JSON.stringify({
  agentId,
  keyId: data.key_id,
  displayName: credentials.displayName,
  hubUrl,
  wsUrl: data.ws_url || null,
  credentialsFile: credPath,
}));
NODE
)" || {
  log_error "claim step failed (bind code may be expired, already used, or the server rejected the proof)"
  exit 1
}

if [ -z "$RESULT" ]; then
  log_error "claim step returned no output; nothing was written"
  exit 1
fi

AGENT_ID="$(printf '%s' "$RESULT"      | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).agentId)')"
KEY_ID="$(printf '%s' "$RESULT"        | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).keyId)')"
DISPLAY_NAME="$(printf '%s' "$RESULT"  | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).displayName || "")')"
HUB_URL_OUT="$(printf '%s' "$RESULT"   | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).hubUrl || "")')"
WS_URL_OUT="$(printf '%s' "$RESULT"    | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).wsUrl || "")')"
CRED_FILE="$(printf '%s' "$RESULT"     | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).credentialsFile)')"

log_quiet "claimed agent_id=$AGENT_ID key_id=$KEY_ID hub=$HUB_URL_OUT"
log "agent claimed:"
log "  Agent ID:    $AGENT_ID"
log "  Display:     $DISPLAY_NAME"
log "  Key ID:      $KEY_ID"
log "  Credentials: $CRED_FILE"

# ── Step 3: Atomic swap staged plugin into TARGET_DIR ─────────────────────
#
# Now (and only now) that the claim succeeded do we touch the live plugin
# install. If we'd swapped earlier and the claim then failed, the user's
# previous plugin would have been displaced for nothing.

if [ "$WANT_PLUGIN_SWAP" = "true" ] && [ -n "$STAGING_DIR" ] && [ -d "$STAGING_DIR" ]; then
  mkdir -p -- "$(dirname "$TARGET_DIR")"
  if [ -d "$TARGET_DIR" ]; then
    BACKUP_DIR="${TARGET_DIR}.bak.${TS}"
    log "moving existing $TARGET_DIR → $BACKUP_DIR"
    mv -- "$TARGET_DIR" "$BACKUP_DIR"
    # From here on, on_exit will restore BACKUP_DIR if the script dies
    # before SWAP_DONE flips below.
  fi
  # Fault-injection hook for tests: if BOTCORD_INSTALL_FAULT=after-backup,
  # exit between the two moves so the on_exit rollback path is exercised
  # against a real filesystem state. Never fires in production unless the
  # caller explicitly opts in with this env var.
  if [ "${BOTCORD_INSTALL_FAULT:-}" = "after-backup" ]; then
    log_error "BOTCORD_INSTALL_FAULT=after-backup; aborting before second mv"
    exit 73
  fi
  mv -- "$STAGING_DIR" "$TARGET_DIR"
  STAGING_DIR=""   # ownership transferred; on_exit shouldn't rm the live install
  SWAP_DONE="true" # second move succeeded — disarm the rollback
  log "plugin installed at $TARGET_DIR"
fi

# ── Step 4: Configure openclaw.json ──────────────────────────────────────

# Account-namespaced keys when --account is supplied; otherwise global keys.
if [ -n "$ACCOUNT" ]; then
  CFG_ENABLED_KEY="channels.botcord.accounts.${ACCOUNT}.enabled"
  CFG_CRED_KEY="channels.botcord.accounts.${ACCOUNT}.credentialsFile"
  CFG_DELIVERY_KEY="channels.botcord.accounts.${ACCOUNT}.deliveryMode"
else
  CFG_ENABLED_KEY="channels.botcord.enabled"
  CFG_CRED_KEY="channels.botcord.credentialsFile"
  CFG_DELIVERY_KEY="channels.botcord.deliveryMode"
fi

configure_via_cli() {
  command -v "$OPENCLAW_BIN" >/dev/null 2>&1 || return 1
  "$OPENCLAW_BIN" config set "$CFG_ENABLED_KEY"  --json "true"        >>"$RUN_LOG" 2>&1 || return 1
  "$OPENCLAW_BIN" config set "$CFG_CRED_KEY"             "$CRED_FILE" >>"$RUN_LOG" 2>&1 || return 1
  "$OPENCLAW_BIN" config set "$CFG_DELIVERY_KEY"         "websocket"  >>"$RUN_LOG" 2>&1 || return 1
  return 0
}

configure_via_file() {
  local path="$1"
  CRED_FILE="$CRED_FILE" \
  CFG_PATH="$path" \
  CFG_ACCOUNT="$ACCOUNT" \
  node --input-type=module <<'NODE' 2>>"$RUN_LOG"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const path = process.env.CFG_PATH;
const credFile = process.env.CRED_FILE;
const account = process.env.CFG_ACCOUNT || "";

let cfg = {};
try { cfg = JSON.parse(readFileSync(path, "utf8")); } catch {}
if (!cfg.channels) cfg.channels = {};
if (!cfg.channels.botcord) cfg.channels.botcord = {};

if (account) {
  if (!cfg.channels.botcord.accounts) cfg.channels.botcord.accounts = {};
  cfg.channels.botcord.accounts[account] = {
    ...(cfg.channels.botcord.accounts[account] || {}),
    enabled: true,
    credentialsFile: credFile,
    deliveryMode: cfg.channels.botcord.accounts[account]?.deliveryMode || "websocket",
  };
} else {
  cfg.channels.botcord = {
    ...cfg.channels.botcord,
    enabled: true,
    credentialsFile: credFile,
    deliveryMode: cfg.channels.botcord.deliveryMode || "websocket",
  };
}

mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
NODE
}

CONFIG_OK="false"
if [ -n "$OPENCLAW_CONFIG_PATH" ]; then
  if configure_via_file "$OPENCLAW_CONFIG_PATH"; then
    CONFIG_OK="true"
    log "openclaw config patched: $OPENCLAW_CONFIG_PATH"
  fi
elif configure_via_cli; then
  CONFIG_OK="true"
  log "openclaw config updated via CLI"
elif configure_via_file "$HOME/.openclaw/openclaw.json"; then
  CONFIG_OK="true"
  log "openclaw config patched: $HOME/.openclaw/openclaw.json"
fi

if [ "$CONFIG_OK" != "true" ]; then
  log_warn "could not configure openclaw automatically; add manually to openclaw.json:"
  log_warn "  channels.botcord.enabled = true"
  log_warn "  channels.botcord.credentialsFile = $CRED_FILE"
  log_warn "  channels.botcord.deliveryMode = websocket"
fi

# ── Step 5: Restart gateway ───────────────────────────────────────────────

if [ "$SKIP_RESTART" = "true" ]; then
  log "skipping gateway restart (--skip-restart); restart it manually for the plugin to load"
elif command -v "$OPENCLAW_BIN" >/dev/null 2>&1; then
  log "restarting OpenClaw gateway"
  RESTART_OUT="$("$OPENCLAW_BIN" gateway restart 2>&1 || true)"
  printf '%s\n' "$RESTART_OUT" >> "$RUN_LOG"
  if printf '%s' "$RESTART_OUT" | grep -qi "no service manager\|not running as a service"; then
    log_warn "OpenClaw is not running as a managed service."
    log_warn "If you're running it in Docker, restart the container, e.g.:"
    log_warn "  docker restart openclaw-openclaw-gateway-1"
  fi
else
  log_warn "openclaw CLI not found; restart the gateway yourself for the plugin to pick up the new config"
fi

# ── Done ──────────────────────────────────────────────────────────────────

log ""
log "All done. The dashboard polling page should pick up agent $AGENT_ID shortly."
log "完成！返回浏览器，仪表盘会自动跳转到这个 agent 的管理页。"
log ""
