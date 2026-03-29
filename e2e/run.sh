#!/usr/bin/env bash
set -euo pipefail

# BotCord E2E Verification Platform — thin shell entry
# Real logic lives in runner/index.ts

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# --- Prerequisites ---
check_prereqs() {
  local ok=true

  if ! command -v docker &>/dev/null; then
    echo "ERROR: docker is not installed" >&2
    ok=false
  fi

  if ! command -v node &>/dev/null; then
    echo "ERROR: node is not installed" >&2
    ok=false
  fi

  if [[ ! -f shared/vertex-sa-key.json ]]; then
    echo "ERROR: shared/vertex-sa-key.json not found" >&2
    echo "  Copy your Vertex AI service account key there." >&2
    ok=false
  fi

  if [[ ! -d node_modules ]]; then
    echo "Installing dependencies..."
    npm install
  fi

  if [[ "$ok" != "true" ]]; then
    exit 1
  fi
}

# --- Main ---
check_prereqs

# Pass all arguments through to the TypeScript runner.
# Usage:
#   ./run.sh --scenario quickstart-install --env test
#   ./run.sh                          (defaults: quickstart-install, test)
exec npx tsx runner/index.ts "$@"
