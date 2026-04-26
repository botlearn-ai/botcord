#!/usr/bin/env bash
# BotCord OpenClaw plugin installer (Phase 1 placeholder)
#
# Real installer is implemented in Phase 2 of bind-code-onboarding-design.md.
# Until then, this stub exists so the dashboard install command resolves and
# users get an actionable message instead of a 404.
set -euo pipefail

cat <<'MSG'
BotCord plugin installer is not yet generally available.

The dashboard ships a one-time install command of the form:

  curl -fsSL <hub>/openclaw/install.sh | bash -s -- \
    --bind-code bd_xxxxxxxxxxxx \
    --bind-nonce <base64-nonce>

When Phase 2 lands this script will:
  1. Download the @botcord/botcord plugin tarball
  2. Run npm install --omit=dev into ~/.openclaw/extensions/botcord
  3. Generate an Ed25519 keypair locally
  4. Sign the bind nonce and POST /api/users/me/agents/install-claim
  5. Write ~/.botcord/credentials/<agentId>.json (chmod 600)
  6. Run `openclaw config set --batch-json` and restart the gateway

For now, follow plugin/README.md to install manually.
MSG

exit 1
