#!/bin/bash
# ============================================================
# Local Docker verification: npm pack → install tarball in
# OpenClaw container → verify plugin loads without errors.
#
# This simulates the real user flow: `npm install @botcord/botcord`
# by packing a tarball locally and installing it inside the container.
#
# Usage: cd plugin && bash test-docker-install.sh
# ============================================================
set -euo pipefail

OPENCLAW_IMAGE="${OPENCLAW_IMAGE:-alpine/openclaw:latest}"
CONTAINER_NAME="botcord-plugin-test"
PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
TEST_DIR=$(mktemp -d)

cleanup() {
  echo ">>> Cleaning up..."
  docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
  # Docker may have created files as root inside the mounted volume
  docker run --rm -v "$TEST_DIR:/cleanup" alpine sh -c 'rm -rf /cleanup/*' 2>/dev/null || true
  rm -rf "$TEST_DIR" 2>/dev/null || true
}
trap cleanup EXIT

echo "=== BotCord Plugin Docker Install Test ==="
echo "Image:  $OPENCLAW_IMAGE"
echo "Plugin: $PLUGIN_DIR"
echo "TmpDir: $TEST_DIR"
echo ""

# ── 1. npm pack to produce a tarball ──────────────────────────
echo ">>> Step 1: Packing plugin tarball..."
TARBALL=$(cd "$PLUGIN_DIR" && npm pack --pack-destination "$TEST_DIR" 2>/dev/null)
TARBALL_PATH="$TEST_DIR/$TARBALL"

if [ ! -f "$TARBALL_PATH" ]; then
  echo "FAIL: npm pack did not produce a tarball"
  exit 1
fi
echo "    Tarball: $TARBALL ($(du -h "$TARBALL_PATH" | cut -f1))"

# ── 2. Prepare .openclaw with minimal config (no botcord yet) ─
mkdir -p "$TEST_DIR/.openclaw/workspace"

# Start with a clean config — no botcord references yet, so the
# gateway can boot without validation errors before the plugin exists.
cat > "$TEST_DIR/.openclaw/openclaw.json" <<'JSONEOF'
{
  "gateway": {
    "mode": "local",
    "controlUi": {
      "dangerouslyAllowHostHeaderOriginFallback": true,
      "allowInsecureAuth": true,
      "dangerouslyDisableDeviceAuth": true
    }
  },
  "agents": {
    "defaults": {
      "model": "google-vertex/gemini-3-flash-preview"
    }
  }
}
JSONEOF

chmod 700 "$TEST_DIR/.openclaw"
chmod 600 "$TEST_DIR/.openclaw/openclaw.json"

echo ">>> Step 2: Config prepared (minimal, no plugin references)"

# ── 3. Start container ────────────────────────────────────────
GATEWAY_TOKEN="test$(openssl rand -hex 10)"
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

docker run -d \
  --name "$CONTAINER_NAME" \
  -e HOME=/home/node \
  -e TERM=xterm-256color \
  -e OPENCLAW_GATEWAY_TOKEN="$GATEWAY_TOKEN" \
  -v "$TEST_DIR/.openclaw:/home/node/.openclaw" \
  -v "$TEST_DIR/.openclaw/workspace:/home/node/.openclaw/workspace" \
  -p 0:18789 \
  --init \
  "$OPENCLAW_IMAGE" \
  node dist/index.js gateway --bind lan --port 18789 --allow-unconfigured

echo ">>> Step 3: Container started"

# ── 4. Copy tarball into container and npm install ────────────
echo ">>> Step 4: Installing plugin from tarball..."

docker cp "$TARBALL_PATH" "$CONTAINER_NAME:/tmp/$TARBALL"

# Extract tarball into extensions dir, then install runtime deps only.
# The openclaw peer dep is provided by the host runtime — skip it.
# This mirrors what `openclaw plugins install @botcord/botcord` does.
docker exec "$CONTAINER_NAME" sh -c "
  mkdir -p /home/node/.openclaw/extensions/botcord && \
  tar xzf /tmp/$TARBALL -C /home/node/.openclaw/extensions/botcord --strip-components=1 && \
  cd /home/node/.openclaw/extensions/botcord && \
  npm install --omit=dev --omit=peer 2>&1
" || {
  echo "FAIL: npm install from tarball failed"
  docker logs "$CONTAINER_NAME" 2>&1 | tail -30
  exit 1
}

echo ">>> Step 4: Plugin installed from tarball"

# ── 5. Verify installed package contents ──────────────────────
echo ">>> Step 5: Checking installed package files..."
docker exec "$CONTAINER_NAME" sh -c \
  'ls /home/node/.openclaw/extensions/botcord/' || true
echo ""

# ── 6. Write full config with plugin references, then restart ─
echo ">>> Step 6: Writing config with plugin + restarting..."

# Now write the real config pointing to the installed plugin path.
cat > "$TEST_DIR/.openclaw/openclaw.json" <<'JSONEOF'
{
  "gateway": {
    "mode": "local",
    "controlUi": {
      "dangerouslyAllowHostHeaderOriginFallback": true,
      "allowInsecureAuth": true,
      "dangerouslyDisableDeviceAuth": true
    }
  },
  "agents": {
    "defaults": {
      "model": "google-vertex/gemini-3-flash-preview"
    }
  },
  "channels": {
    "botcord": {
      "enabled": false
    }
  },
  "plugins": {
    "load": {
      "paths": ["/home/node/.openclaw/extensions/botcord"]
    },
    "entries": {
      "botcord": {
        "enabled": true
      }
    }
  }
}
JSONEOF

chmod 600 "$TEST_DIR/.openclaw/openclaw.json"

docker restart "$CONTAINER_NAME"

# Wait for gateway to fully boot after restart.
echo ">>> Waiting for gateway startup after restart..."
sleep 3
for i in $(seq 1 45); do
  if docker logs --since 30s "$CONTAINER_NAME" 2>&1 | grep -q "listening on"; then
    break
  fi
  # Check if container died
  if ! docker ps -q -f "name=$CONTAINER_NAME" | grep -q .; then
    echo "WARN: Container exited during restart"
    echo "=== Exit logs ==="
    docker logs --tail 30 "$CONTAINER_NAME" 2>&1
    break
  fi
  sleep 1
done

# ── 7. Check logs for plugin load success/failure ─────────────
echo ""
echo "=== Container Status ==="
docker ps -a -f "name=$CONTAINER_NAME" --format "{{.Status}}"
echo ""
echo "=== Container Logs (full) ==="
docker logs "$CONTAINER_NAME" 2>&1 | tail -60
echo ""

LOGS=$(docker logs "$CONTAINER_NAME" 2>&1)

if echo "$LOGS" | grep -qi "error.*botcord\|failed.*botcord\|cannot find.*botcord"; then
  echo ""
  echo "FAIL: BotCord plugin load errors detected!"
  exit 1
fi

if echo "$LOGS" | grep -qi "botcord"; then
  echo ""
  echo "PASS: BotCord plugin loaded (found references in logs)"
else
  echo ""
  echo "WARN: No BotCord references found in logs (plugin may not have been loaded yet)"
  echo "      Check the full logs above for details."
fi

# ── 8. Test gateway health endpoint ──────────────────────────
MAPPED_PORT=$(docker port "$CONTAINER_NAME" 18789/tcp 2>/dev/null | head -1 | cut -d: -f2)
if [ -n "$MAPPED_PORT" ]; then
  echo ""
  echo ">>> Gateway port: $MAPPED_PORT"
  HEALTH=$(curl -sf "http://localhost:$MAPPED_PORT/" 2>/dev/null || echo "unreachable")
  if [ "$HEALTH" != "unreachable" ]; then
    echo "PASS: Gateway is responding on port $MAPPED_PORT"
  else
    echo "INFO: Gateway not yet responding (may still be starting)"
  fi
fi

echo ""
echo "=== Test Complete ==="
