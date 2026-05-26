#!/usr/bin/env bash
#
# Sandbox entrypoint for the BotCord cloud-agent image.
#
# Validates the env vars injected by the Hub-side provider (see
# backend/hub/services/cloud_daemon_provider_e2b.py) and execs the daemon
# in the foreground so tini can forward signals from the orchestrator.
#
# Required env (cloud-mode contract — packages/daemon/src/cloud-mode.ts):
#   BOTCORD_HUB_URL
#   BOTCORD_CLOUD_DAEMON_INSTANCE_ID
#   BOTCORD_DAEMON_INSTANCE_ID
#   BOTCORD_CLOUD_DAEMON_ACCESS_TOKEN
#
# Optional:
#   DEEPSEEK_API_KEY                 — forwarded to deepseek-tui at runtime
#   CLOUD_DAEMON_NPM_SPEC            — npm package spec to prefer over bundled daemon
#   BOTCORD_DAEMON_EXTRA_ARGS        — appended to the daemon start command

set -euo pipefail

required=(
  BOTCORD_HUB_URL
  BOTCORD_CLOUD_DAEMON_INSTANCE_ID
  BOTCORD_DAEMON_INSTANCE_ID
  BOTCORD_CLOUD_DAEMON_ACCESS_TOKEN
)

missing=()
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    missing+=("$name")
  fi
done

if (( ${#missing[@]} > 0 )); then
  printf 'cloud-agent entrypoint: missing required env vars: %s\n' "${missing[*]}" >&2
  exit 64
fi

BOTCORD_HOME="${BOTCORD_HOME:-$HOME/.botcord}"
CONFIG_DIR="$BOTCORD_HOME/daemon"
CONFIG_FILE="$CONFIG_DIR/config.json"

mkdir -p "$CONFIG_DIR"
if [[ ! -f "$CONFIG_FILE" ]]; then
  cat > "$CONFIG_FILE" <<'JSON'
{
  "defaultRoute": {
    "adapter": "deepseek-tui",
    "cwd": "__BOTCORD_CLOUD_HOME__"
  },
  "routes": [],
  "streamBlocks": true
}
JSON
  sed -i "s#__BOTCORD_CLOUD_HOME__#$HOME#g" "$CONFIG_FILE"
fi

# shellcheck disable=SC2206
extra=( ${BOTCORD_DAEMON_EXTRA_ARGS:-} )

daemon_npm_spec="${CLOUD_DAEMON_NPM_SPEC:-@botcord/daemon@latest}"

if [[ "$daemon_npm_spec" != "bundled" ]]; then
  exec npx --yes --package "$daemon_npm_spec" botcord-daemon start "${extra[@]}"
fi

exec botcord-daemon start "${extra[@]}"
