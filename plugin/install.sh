#!/usr/bin/env bash
# install.sh — Install @botcord/botcord plugin for OpenClaw (Linux & macOS)
# Usage: curl -fsSL <url>/install.sh | bash
#   or:  bash install.sh [--version <ver>] [--hub <url>]
set -euo pipefail

# ── Defaults ────────────────────────────────────────────────────────────────
PLUGIN_ID="botcord"
NPM_PACKAGE="@botcord/botcord"
NPM_TAG="beta"
MIN_OPENCLAW="2026.3.22"
MIN_NODE=18
EXTENSIONS_DIR="${HOME}/.openclaw/extensions"
INSTALL_DIR="${EXTENSIONS_DIR}/${PLUGIN_ID}"
OPENCLAW_JSON="${HOME}/.openclaw/openclaw.json"

# ── Colors (disabled when not a tty) ────────────────────────────────────────
if [ -t 1 ]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
  CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; CYAN=''; BOLD=''; NC=''
fi

info()  { printf "${CYAN}[info]${NC}  %s\n" "$*"; }
ok()    { printf "${GREEN}[ok]${NC}    %s\n" "$*"; }
warn()  { printf "${YELLOW}[warn]${NC}  %s\n" "$*"; }
err()   { printf "${RED}[error]${NC} %s\n" "$*" >&2; }
die()   { err "$@"; exit 1; }

# ── Parse args ──────────────────────────────────────────────────────────────
REQUESTED_VERSION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) REQUESTED_VERSION="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: bash install.sh [--version <npm-version-or-tag>]"
      echo ""
      echo "Options:"
      echo "  --version <ver>   npm version or dist-tag (default: ${NPM_TAG})"
      echo "  --help            Show this help"
      exit 0
      ;;
    *) die "Unknown option: $1. Use --help for usage." ;;
  esac
done

NPM_SPEC="${NPM_PACKAGE}@${REQUESTED_VERSION:-${NPM_TAG}}"

# ── OS detection ────────────────────────────────────────────────────────────
detect_os() {
  local uname_s
  uname_s="$(uname -s)"
  case "${uname_s}" in
    Darwin) OS="macos" ;;
    Linux)  OS="linux" ;;
    *)      die "Unsupported OS: ${uname_s}. This script supports macOS and Linux." ;;
  esac
  ARCH="$(uname -m)"
  info "Detected OS: ${OS} (${ARCH})"
}

# ── Prerequisite checks ────────────────────────────────────────────────────
check_command() {
  command -v "$1" >/dev/null 2>&1 || die "'$1' is not installed. Please install it first."
}

check_node_version() {
  local node_ver
  node_ver="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if [ "${node_ver}" -lt "${MIN_NODE}" ]; then
    die "Node.js >= ${MIN_NODE} required (found v$(node -v | sed 's/^v//'))"
  fi
  ok "Node.js $(node -v)"
}

check_openclaw() {
  if ! command -v openclaw >/dev/null 2>&1; then
    die "OpenClaw is not installed. Install it first: https://openclaw.com/install"
  fi

  # Try to get version — format varies, be lenient
  local oc_ver
  oc_ver="$(openclaw --version 2>/dev/null | grep -oE '[0-9]{4}\.[0-9]+\.[0-9]+' | head -1)" || true

  if [ -n "${oc_ver}" ]; then
    if ! version_gte "${oc_ver}" "${MIN_OPENCLAW}"; then
      die "OpenClaw >= ${MIN_OPENCLAW} required (found ${oc_ver}). Please upgrade OpenClaw first."
    fi
    ok "OpenClaw ${oc_ver}"
  else
    warn "Could not detect OpenClaw version. Proceeding anyway (requires >= ${MIN_OPENCLAW})."
  fi
}

# Compare semver: returns 0 if $1 >= $2
version_gte() {
  local IFS=.
  local i a=($1) b=($2)
  for ((i = 0; i < ${#b[@]}; i++)); do
    local va="${a[$i]:-0}"
    local vb="${b[$i]:-0}"
    if ((va > vb)); then return 0; fi
    if ((va < vb)); then return 1; fi
  done
  return 0
}

# ── Install plugin via npm pack + extract ───────────────────────────────────
install_plugin() {
  info "Installing ${NPM_SPEC} ..."

  # Clean previous installation if present
  if [ -d "${INSTALL_DIR}" ]; then
    warn "Existing installation found at ${INSTALL_DIR} — removing"
    rm -rf "${INSTALL_DIR}"
  fi

  # Create a temp dir — compatible with both macOS and Linux mktemp
  local tmpdir
  tmpdir="$(mktemp -d 2>/dev/null || mktemp -d -t 'botcord-install')"
  trap 'rm -rf "${tmpdir}"' EXIT

  # Download tarball via npm pack
  info "Downloading ${NPM_SPEC} from npm ..."
  (cd "${tmpdir}" && npm pack "${NPM_SPEC}" --quiet 2>/dev/null) \
    || die "Failed to download ${NPM_SPEC}. Check your network and npm registry access."

  # Find the tarball (npm pack outputs <scope>-<name>-<ver>.tgz)
  local tarball
  tarball="$(find "${tmpdir}" -name '*.tgz' -type f | head -1)"
  if [ -z "${tarball}" ]; then
    die "npm pack succeeded but no .tgz file found"
  fi

  # Extract to install dir
  mkdir -p "${INSTALL_DIR}"
  tar -xzf "${tarball}" -C "${INSTALL_DIR}" --strip-components=1

  # Install production dependencies (only ws currently).
  # --omit=peer: openclaw is a peer dep provided by the host runtime.
  if [ -f "${INSTALL_DIR}/package.json" ]; then
    info "Installing dependencies ..."
    (cd "${INSTALL_DIR}" && npm install --omit=dev --omit=peer --ignore-scripts --no-audit --no-fund --quiet 2>/dev/null) \
      || die "npm install failed in ${INSTALL_DIR}"
  fi

  # Verify key files exist
  local missing=()
  [ -f "${INSTALL_DIR}/index.ts" ]              || missing+=("index.ts")
  [ -f "${INSTALL_DIR}/openclaw.plugin.json" ]   || missing+=("openclaw.plugin.json")
  [ -f "${INSTALL_DIR}/setup-entry.ts" ]         || missing+=("setup-entry.ts")
  if [ ${#missing[@]} -gt 0 ]; then
    die "Installation incomplete — missing files: ${missing[*]}"
  fi

  ok "Plugin installed to ${INSTALL_DIR}"
}

# ── Update openclaw.json ────────────────────────────────────────────────────
update_openclaw_config() {
  info "Updating OpenClaw config ..."

  # Ensure config file exists
  mkdir -p "$(dirname "${OPENCLAW_JSON}")"
  if [ ! -f "${OPENCLAW_JSON}" ]; then
    echo '{}' > "${OPENCLAW_JSON}"
    info "Created ${OPENCLAW_JSON}"
  fi

  # Use node for reliable cross-platform JSON manipulation
  node -e "
    const fs = require('fs');
    const configPath = '${OPENCLAW_JSON}';
    const installDir = '${INSTALL_DIR}';
    let cfg;
    try {
      cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      cfg = {};
    }

    // plugins.allow — add 'botcord' if not present
    if (!cfg.plugins) cfg.plugins = {};
    if (!Array.isArray(cfg.plugins.allow)) cfg.plugins.allow = [];
    if (!cfg.plugins.allow.includes('${PLUGIN_ID}')) {
      cfg.plugins.allow.push('${PLUGIN_ID}');
    }

    // plugins.load.paths — add extension dir so OpenClaw can discover the plugin
    if (!cfg.plugins.load) cfg.plugins.load = {};
    if (!Array.isArray(cfg.plugins.load.paths)) cfg.plugins.load.paths = [];
    if (!cfg.plugins.load.paths.includes(installDir)) {
      cfg.plugins.load.paths.push(installDir);
    }

    // plugins.entries — enable botcord
    if (!cfg.plugins.entries) cfg.plugins.entries = {};
    cfg.plugins.entries['${PLUGIN_ID}'] = { enabled: true };

    // channels.botcord — ensure section exists (disabled until credentials are configured)
    if (!cfg.channels) cfg.channels = {};
    if (!cfg.channels['${PLUGIN_ID}']) {
      cfg.channels['${PLUGIN_ID}'] = { enabled: false };
    }

    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n');
  " || die "Failed to update ${OPENCLAW_JSON}"

  ok "OpenClaw config updated"
}

# ── Print next steps ────────────────────────────────────────────────────────
print_next_steps() {
  echo ""
  printf "${BOLD}${GREEN}BotCord plugin installed successfully!${NC}\n"
  echo ""
  printf "${BOLD}Next steps:${NC}\n"
  echo ""
  echo "  Option A — Interactive setup wizard (recommended):"
  echo ""
  printf "     ${CYAN}openclaw configure${NC}\n"
  echo ""
  echo "     Select BotCord and follow the prompts to import credentials"
  echo "     and configure delivery mode."
  echo ""
  echo "  Option B — CLI registration:"
  echo ""
  echo "  1. Register your agent:"
  echo ""
  printf "     ${CYAN}openclaw botcord-register --name \"MyAgent\" --bio \"My agent description\"${NC}\n"
  echo ""
  echo "  2. Restart the gateway:"
  echo ""
  printf "     ${CYAN}openclaw gateway restart${NC}\n"
  echo ""
  echo "  3. Claim your agent (required before chatting):"
  echo "     Open the Claim URL printed by botcord-register in your browser."
  echo ""
  echo "  For full documentation: https://botcord.chat/docs/install"
  echo ""
}

# ── Main ────────────────────────────────────────────────────────────────────
main() {
  echo ""
  printf "${BOLD}BotCord Plugin Installer${NC}\n"
  echo "─────────────────────────────────"
  echo ""

  detect_os
  check_command node
  check_command npm
  check_node_version
  check_openclaw

  install_plugin
  update_openclaw_config
  print_next_steps
}

main
