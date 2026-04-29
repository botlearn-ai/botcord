#!/bin/sh
# --------------------------------------------------------------------------
# BotCord daemon installer
#
# One-liner:
#   curl -fsSL https://api.botcord.chat/daemon/install.sh | sh -s -- --hub https://api.botcord.chat
#
# What it does:
#   1. Uses an existing node/npm if available and Node >= 18.
#   2. Otherwise downloads a private Node.js build into ~/.botcord/node.
#   3. Installs @botcord/daemon into ~/.botcord/daemon.
#   4. Writes ~/.botcord/bin/botcord-daemon and optionally starts it.
#
# This avoids requiring users to have npx or a global Node.js install.
# --------------------------------------------------------------------------
set -eu

DAEMON_PACKAGE="${BOTCORD_DAEMON_PACKAGE:-@botcord/daemon@latest}"
INSTALL_ROOT="${BOTCORD_INSTALL_ROOT:-$HOME/.botcord}"
NODE_VERSION="${BOTCORD_NODE_VERSION:-v20.18.1}"
NODE_DIST_URL="${BOTCORD_NODE_DIST_URL:-https://nodejs.org/dist}"
HUB_URL="${BOTCORD_HUB:-https://api.botcord.chat}"
START_DAEMON="true"
EXTRA_DAEMON_ARGS=""
INSTALL_TOKEN=""
DAEMON_LABEL=""

log() { printf '[botcord-daemon] %s\n' "$*"; }
warn() { printf '[botcord-daemon] WARN: %s\n' "$*" >&2; }
die() { printf '[botcord-daemon] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Usage:
  curl -fsSL <hub>/daemon/install.sh | sh -s -- [options] [-- daemon args...]

Options:
  --hub <url>             Hub URL passed to botcord-daemon start
  --install-token <token> One-time dashboard install token for non-interactive auth
  --label <name>          Human label for this daemon in the dashboard
  --package <spec>        npm package spec (default: @botcord/daemon@latest)
  --install-root <path>   Install root (default: ~/.botcord)
  --node-version <ver>    Bundled Node.js version when system Node is missing
  --no-start              Install only; do not start the daemon
  -h, --help              Show this help

Environment:
  BOTCORD_HUB
  BOTCORD_DAEMON_PACKAGE
  BOTCORD_INSTALL_ROOT
  BOTCORD_NODE_VERSION
  BOTCORD_NODE_DIST_URL
USAGE
}

need_next_arg() {
  opt="$1"
  if [ "$#" -lt 2 ]; then
    die "missing value for $opt"
  fi
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

node_major() {
  "$1" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf '0'
}

detect_node_platform() {
  os="$(uname -s 2>/dev/null || true)"
  arch="$(uname -m 2>/dev/null || true)"

  case "$os" in
    Darwin) node_os="darwin" ;;
    Linux) node_os="linux" ;;
    *) die "unsupported OS: $os (supported: macOS, Linux)" ;;
  esac

  case "$arch" in
    x86_64|amd64) node_arch="x64" ;;
    arm64|aarch64) node_arch="arm64" ;;
    *) die "unsupported CPU architecture: $arch (supported: x64, arm64)" ;;
  esac

  printf '%s-%s' "$node_os" "$node_arch"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --hub)
      need_next_arg "$1" "$@"
      HUB_URL="$2"
      shift 2
      ;;
    --package)
      need_next_arg "$1" "$@"
      DAEMON_PACKAGE="$2"
      shift 2
      ;;
    --install-token)
      need_next_arg "$1" "$@"
      INSTALL_TOKEN="$2"
      shift 2
      ;;
    --label)
      need_next_arg "$1" "$@"
      DAEMON_LABEL="$2"
      shift 2
      ;;
    --install-root)
      need_next_arg "$1" "$@"
      INSTALL_ROOT="$2"
      shift 2
      ;;
    --node-version)
      need_next_arg "$1" "$@"
      NODE_VERSION="$2"
      shift 2
      ;;
    --no-start)
      START_DAEMON="false"
      shift
      ;;
    --)
      shift
      EXTRA_DAEMON_ARGS="$*"
      break
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

case "$HUB_URL" in
  http://*|https://*) ;;
  *) die "--hub must be an http(s) URL" ;;
esac

BIN_DIR="$INSTALL_ROOT/bin"
NODE_ROOT="$INSTALL_ROOT/node"
DAEMON_PREFIX="$INSTALL_ROOT/daemon"
mkdir -p "$BIN_DIR" "$NODE_ROOT" "$DAEMON_PREFIX"

NODE_BIN=""
NPM_BIN=""

if have_cmd node && have_cmd npm; then
  major="$(node_major node)"
  if [ "$major" -ge 18 ] 2>/dev/null; then
    NODE_BIN="$(command -v node)"
    NPM_BIN="$(command -v npm)"
    log "using system Node.js: $("$NODE_BIN" --version)"
  else
    warn "system Node.js is too old: $(node --version 2>/dev/null || printf unknown); using private Node.js"
  fi
fi

if [ -z "$NODE_BIN" ]; then
  have_cmd curl || die "missing command: curl"
  have_cmd tar || die "missing command: tar"

  platform="$(detect_node_platform)"
  node_name="node-$NODE_VERSION-$platform"
  node_dir="$NODE_ROOT/$node_name"
  node_tgz="$NODE_ROOT/$node_name.tar.gz"
  node_url="$NODE_DIST_URL/$NODE_VERSION/$node_name.tar.gz"

  if [ ! -x "$node_dir/bin/node" ]; then
    log "downloading private Node.js $NODE_VERSION for $platform"
    curl -fL "$node_url" -o "$node_tgz"
    rm -rf "$node_dir.tmp"
    mkdir -p "$node_dir.tmp"
    tar -xzf "$node_tgz" -C "$node_dir.tmp" --strip-components 1
    rm -rf "$node_dir"
    mv "$node_dir.tmp" "$node_dir"
    rm -f "$node_tgz"
  else
    log "using cached private Node.js: $node_dir"
  fi

  NODE_BIN="$node_dir/bin/node"
  NPM_BIN="$node_dir/bin/npm"
fi

[ -x "$NODE_BIN" ] || die "node executable not found: $NODE_BIN"
[ -x "$NPM_BIN" ] || die "npm executable not found: $NPM_BIN"
NODE_BIN_DIR="$(dirname "$NODE_BIN")"
PATH="$NODE_BIN_DIR:$PATH"
export PATH

log "installing $DAEMON_PACKAGE"
"$NPM_BIN" install --prefix "$DAEMON_PREFIX" "$DAEMON_PACKAGE"

DAEMON_PKG_JSON="$DAEMON_PREFIX/node_modules/@botcord/daemon/package.json"
DAEMON_VERSION="$("$NODE_BIN" -p "require('$DAEMON_PKG_JSON').version" 2>/dev/null || printf 'unknown')"
log "installed @botcord/daemon@$DAEMON_VERSION"

DAEMON_BIN="$DAEMON_PREFIX/node_modules/.bin/botcord-daemon"
[ -x "$DAEMON_BIN" ] || die "botcord-daemon executable not found after install"

WRAPPER="$BIN_DIR/botcord-daemon"
{
  printf '#!/bin/sh\n'
  printf 'PATH="%s:$PATH"\n' "$NODE_BIN_DIR"
  printf 'export PATH\n'
  printf 'exec "%s" "%s" "$@"\n' "$NODE_BIN" "$DAEMON_BIN"
} > "$WRAPPER"
chmod 755 "$WRAPPER"

log "installed wrapper: $WRAPPER"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on PATH; add it to your shell profile to run botcord-daemon directly" ;;
esac

if [ "$START_DAEMON" = "true" ]; then
  log "starting daemon"
  set -- start --hub "$HUB_URL"
  if [ -n "$INSTALL_TOKEN" ]; then
    set -- "$@" --install-token "$INSTALL_TOKEN"
  fi
  if [ -n "$DAEMON_LABEL" ]; then
    set -- "$@" --label "$DAEMON_LABEL"
  fi
  # shellcheck disable=SC2086
  "$WRAPPER" "$@" $EXTRA_DAEMON_ARGS
else
  log "install complete; start with: $WRAPPER start --hub $HUB_URL"
fi
