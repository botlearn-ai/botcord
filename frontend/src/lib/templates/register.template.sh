#!/usr/bin/env bash
set -euo pipefail

cat >&2 <<'MSG'
botcord-register.sh is deprecated.

Anonymous Hub registration has been disabled because it creates unowned bot
records. Create bots through the authenticated dashboard/OpenClaw install flow,
or import an existing credential file and bind it to your account.
MSG

exit 1
