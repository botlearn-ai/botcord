#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# BotCord E2E — GCP Cloud Runner
#
# Provisions ephemeral GCP VMs, installs OpenClaw, runs the quickstart E2E
# scenario via SSH, collects artifacts, then destroys the VMs.
#
# Usage:
#   ./gcp-run.sh                                  # 2 instances, preview env
#   ./gcp-run.sh --instances 1 --env test         # 1 instance, test env
#   ./gcp-run.sh --keep                           # don't destroy VMs after
#   ./gcp-run.sh --destroy                        # just destroy leftover VMs
#
# Prerequisites:
#   - gcloud CLI authenticated with project access
#   - shared/vertex-sa-key.json (Vertex AI service account key)
#   - BOTCORD_PREVIEW_DB_URL or BOTCORD_TEST_DB_URL for DB assertions
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Defaults ─────────────────────────────────────────────────────────────────
GCP_PROJECT="readbookai"
GCP_ZONE="us-central1-a"
MACHINE_TYPE="e2-standard-2"            # 2 vCPU, 8 GB RAM
BOOT_DISK_SIZE="30GB"
OPENCLAW_VERSION="2026.3.28"
OPENCLAW_MODEL="google-vertex/gemini-3-flash-preview"
GATEWAY_PORT=16200

INSTANCE_COUNT=2
ENV_NAME="preview"
KEEP_VMS=false
DESTROY_ONLY=false
SCENARIO="quickstart-install"

VM_PREFIX="e2e-openclaw"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-gcp"
ARTIFACT_DIR="$SCRIPT_DIR/artifacts/$RUN_ID"

# ── Parse args ───────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --instances) INSTANCE_COUNT="$2"; shift 2 ;;
    --env)       ENV_NAME="$2"; shift 2 ;;
    --scenario)  SCENARIO="$2"; shift 2 ;;
    --keep)      KEEP_VMS=true; shift ;;
    --destroy)   DESTROY_ONLY=true; shift ;;
    --project)   GCP_PROJECT="$2"; shift 2 ;;
    --zone)      GCP_ZONE="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# ── Helpers ──────────────────────────────────────────────────────────────────
log()      { printf "\033[36m[e2e-gcp]\033[0m %s\n" "$*"; }
log_ok()   { printf "\033[32m[e2e-gcp]\033[0m %s\n" "$*"; }
log_warn() { printf "\033[33m[e2e-gcp]\033[0m %s\n" "$*"; }
log_err()  { printf "\033[31m[e2e-gcp]\033[0m %s\n" "$*" >&2; }

ssh_vm() {
  local vm="$1"; shift
  gcloud compute ssh "$vm" --zone="$GCP_ZONE" --project="$GCP_PROJECT" \
    --command="$*" --quiet 2>/dev/null
}

scp_to_vm() {
  local src="$1" vm="$2" dst="$3"
  gcloud compute scp "$src" "$vm:$dst" \
    --zone="$GCP_ZONE" --project="$GCP_PROJECT" --quiet 2>/dev/null
}

scp_from_vm() {
  local vm="$1" src="$2" dst="$3"
  gcloud compute scp "$vm:$src" "$dst" \
    --zone="$GCP_ZONE" --project="$GCP_PROJECT" --quiet 2>/dev/null
}

vm_name() { echo "${VM_PREFIX}-${RUN_ID}-$1"; }

get_vm_ip() {
  gcloud compute instances describe "$(vm_name "$1")" \
    --zone="$GCP_ZONE" --project="$GCP_PROJECT" \
    --format='get(networkInterfaces[0].accessConfigs[0].natIP)' 2>/dev/null
}

# ── Destroy all E2E VMs ─────────────────────────────────────────────────────
destroy_vms() {
  local vms=()
  for i in $(seq 1 "$INSTANCE_COUNT"); do
    vms+=("$(vm_name "$i")")
  done
  log "Destroying VMs: ${vms[*]}"
  gcloud compute instances delete "${vms[@]}" \
    --zone="$GCP_ZONE" --project="$GCP_PROJECT" --quiet 2>/dev/null || true
}

destroy_all_e2e_vms() {
  log "Finding all e2e-openclaw VMs..."
  local vms
  vms=$(gcloud compute instances list --project="$GCP_PROJECT" \
    --filter="name~^${VM_PREFIX}" --format="value(name)" 2>/dev/null)
  if [[ -z "$vms" ]]; then
    log "No E2E VMs found."
    return
  fi
  log_warn "Will delete: $vms"
  echo "$vms" | xargs gcloud compute instances delete \
    --zone="$GCP_ZONE" --project="$GCP_PROJECT" --quiet 2>/dev/null || true
  log_ok "Done."
}

if [[ "$DESTROY_ONLY" == "true" ]]; then
  destroy_all_e2e_vms
  exit 0
fi

# ── Prerequisites ────────────────────────────────────────────────────────────
check_prereqs() {
  local ok=true
  if ! command -v gcloud &>/dev/null; then
    log_err "gcloud CLI not found"; ok=false
  fi
  if [[ ! -f shared/vertex-sa-key.json ]]; then
    log_err "shared/vertex-sa-key.json not found"; ok=false
  fi
  if [[ ! -f shared/gaxios-fetch-patch.cjs ]]; then
    log_err "shared/gaxios-fetch-patch.cjs not found"; ok=false
  fi
  [[ "$ok" == "true" ]] || exit 1
}

check_prereqs
mkdir -p "$ARTIFACT_DIR"

log "============================================"
log "BotCord E2E — GCP Cloud Runner"
log "============================================"
log "Run ID:     $RUN_ID"
log "Scenario:   $SCENARIO"
log "Environment: $ENV_NAME"
log "Instances:  $INSTANCE_COUNT"
log "Machine:    $MACHINE_TYPE"
log "OpenClaw:   $OPENCLAW_VERSION"
log "Model:      $OPENCLAW_MODEL"
log "Artifacts:  $ARTIFACT_DIR"
log "============================================"

# ── Resolve environment URLs ─────────────────────────────────────────────────
case "$ENV_NAME" in
  test)
    HUB_BASE_URL="https://api.test.botcord.chat"
    DOCS_BASE_URL="https://test.botcord.chat"
    SETUP_GUIDE_URL="$DOCS_BASE_URL/openclaw-setup-instruction-script-beta.md"
    ;;
  preview)
    HUB_BASE_URL="https://preview.botcord.chat"
    DOCS_BASE_URL="https://preview.botcord.chat"
    SETUP_GUIDE_URL="$DOCS_BASE_URL/openclaw-setup-instruction-script.md"
    ;;
  prod)
    HUB_BASE_URL="https://api.botcord.chat"
    DOCS_BASE_URL="https://botcord.chat"
    SETUP_GUIDE_URL="$DOCS_BASE_URL/openclaw-setup-instruction-script.md"
    ;;
  *) log_err "Unknown env: $ENV_NAME"; exit 1 ;;
esac

# ── Build prompt (same as frontend buildConnectBotPrompt) ────────────────────
PROMPT="Help me start using BotCord.
If BotCord is not installed yet, follow this setup guide first: ${SETUP_GUIDE_URL}
If I already have a Bot, connect the existing one first. If not, create a new one for me.
After setup, connect this Bot to my BotCord account.
If you need my confirmation during the connection flow, I will confirm it in this chat.
Do not explain internal technical details. Just tell me when it is done."

echo "$PROMPT" > "$ARTIFACT_DIR/prompt.md"

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 1: Provision VMs
# ══════════════════════════════════════════════════════════════════════════════
log ""
log "Phase 1: Creating $INSTANCE_COUNT VM(s)..."

declare -A VM_TOKENS
declare -A VM_IPS

for i in $(seq 1 "$INSTANCE_COUNT"); do
  VM=$(vm_name "$i")
  TOKEN=$(openssl rand -hex 16)
  VM_TOKENS[$i]="$TOKEN"

  log "  Creating $VM..."
  gcloud compute instances create "$VM" \
    --zone="$GCP_ZONE" \
    --machine-type="$MACHINE_TYPE" \
    --boot-disk-size="$BOOT_DISK_SIZE" \
    --image-family=debian-12 \
    --image-project=debian-cloud \
    --project="$GCP_PROJECT" \
    --scopes=cloud-platform \
    --quiet &
done
wait
log_ok "  VMs created."

# Wait for SSH
log "  Waiting for SSH..."
for i in $(seq 1 "$INSTANCE_COUNT"); do
  VM=$(vm_name "$i")
  for attempt in $(seq 1 20); do
    if ssh_vm "$VM" "echo ok" &>/dev/null; then
      VM_IPS[$i]=$(get_vm_ip "$i")
      log_ok "  $VM ready (${VM_IPS[$i]})"
      break
    fi
    sleep 5
  done
done

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 2: Install & Configure OpenClaw
# ══════════════════════════════════════════════════════════════════════════════
log ""
log "Phase 2: Installing OpenClaw on VMs..."

for i in $(seq 1 "$INSTANCE_COUNT"); do
  VM=$(vm_name "$i")
  TOKEN="${VM_TOKENS[$i]}"
  INST_DIR="$ARTIFACT_DIR/instance-$i"
  mkdir -p "$INST_DIR"

  log "  [$VM] Installing Node.js 22 + OpenClaw $OPENCLAW_VERSION..."
  ssh_vm "$VM" "
    set -e
    # Install Node.js 22
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null 2>&1
    sudo apt-get install -y nodejs >/dev/null 2>&1

    # Install OpenClaw
    sudo npm install -g openclaw@${OPENCLAW_VERSION} >/dev/null 2>&1

    # Create openclaw user
    sudo useradd -m -s /bin/bash openclaw 2>/dev/null || true
    sudo mkdir -p /home/openclaw/.openclaw/workspace
    sudo mkdir -p /home/openclaw/.botcord/credentials
  "

  # Upload credentials & patch
  log "  [$VM] Uploading Vertex AI credentials..."
  scp_to_vm "shared/vertex-sa-key.json" "$VM" "/tmp/vertex-sa-key.json"
  scp_to_vm "shared/gaxios-fetch-patch.cjs" "$VM" "/tmp/gaxios-fetch-patch.cjs"

  ssh_vm "$VM" "
    sudo cp /tmp/vertex-sa-key.json /home/openclaw/.openclaw/vertex-sa-key.json
    sudo cp /tmp/gaxios-fetch-patch.cjs /home/openclaw/.openclaw/gaxios-fetch-patch.cjs
    sudo chmod 600 /home/openclaw/.openclaw/vertex-sa-key.json

    # Write openclaw.json
    sudo tee /home/openclaw/.openclaw/openclaw.json > /dev/null <<'JSONEOF'
{
  \"agents\": {
    \"defaults\": {
      \"model\": {
        \"primary\": \"${OPENCLAW_MODEL}\",
        \"fallbacks\": []
      },
      \"compaction\": { \"mode\": \"safeguard\" }
    }
  },
  \"commands\": {
    \"native\": \"auto\",
    \"nativeSkills\": \"auto\",
    \"restart\": true,
    \"ownerDisplay\": \"raw\"
  },
  \"session\": { \"dmScope\": \"per-channel-peer\" },
  \"channels\": {},
  \"gateway\": {
    \"mode\": \"local\",
    \"controlUi\": {
      \"dangerouslyAllowHostHeaderOriginFallback\": true,
      \"allowInsecureAuth\": true,
      \"dangerouslyDisableDeviceAuth\": true
    }
  },
  \"plugins\": { \"entries\": {}, \"installs\": {} }
}
JSONEOF

    sudo chown -R openclaw:openclaw /home/openclaw/.openclaw
    sudo chown -R openclaw:openclaw /home/openclaw/.botcord

    # Create systemd service
    sudo tee /etc/systemd/system/openclaw.service > /dev/null <<SVCEOF
[Unit]
Description=OpenClaw Gateway (E2E)
After=network.target

[Service]
Type=simple
User=openclaw
Group=openclaw
WorkingDirectory=/home/openclaw
Environment=HOME=/home/openclaw
Environment=\"NODE_OPTIONS=--require /home/openclaw/.openclaw/gaxios-fetch-patch.cjs\"
Environment=GOOGLE_APPLICATION_CREDENTIALS=/home/openclaw/.openclaw/vertex-sa-key.json
Environment=GOOGLE_CLOUD_PROJECT=${GCP_PROJECT}
Environment=GOOGLE_CLOUD_LOCATION=global
Environment=OPENCLAW_GATEWAY_TOKEN=${TOKEN}
ExecStart=/usr/bin/openclaw gateway --bind lan --port ${GATEWAY_PORT} --allow-unconfigured
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SVCEOF

    sudo systemctl daemon-reload
    sudo systemctl enable openclaw >/dev/null 2>&1
    sudo systemctl start openclaw
  "

  log_ok "  [$VM] OpenClaw started."
done

# ── Wait for gateways healthy ────────────────────────────────────────────────
log ""
log "  Waiting for gateways to become healthy..."
for i in $(seq 1 "$INSTANCE_COUNT"); do
  VM=$(vm_name "$i")
  for attempt in $(seq 1 36); do  # 180s max
    if ssh_vm "$VM" "curl -sf http://localhost:${GATEWAY_PORT}/" &>/dev/null; then
      log_ok "  [$VM] Gateway healthy."
      break
    fi
    if [[ $attempt -eq 36 ]]; then
      log_err "  [$VM] Gateway failed to start within 180s"
      ssh_vm "$VM" "sudo journalctl -u openclaw --no-pager -n 30" > "$ARTIFACT_DIR/instance-$i/journal.log" 2>/dev/null
    fi
    sleep 5
  done
done

# Save VM metadata
for i in $(seq 1 "$INSTANCE_COUNT"); do
  cat > "$ARTIFACT_DIR/instance-$i/vm-info.json" <<EOF
{
  "vm": "$(vm_name "$i")",
  "ip": "${VM_IPS[$i]:-unknown}",
  "token": "${VM_TOKENS[$i]}",
  "port": $GATEWAY_PORT,
  "openclawVersion": "$OPENCLAW_VERSION",
  "model": "$OPENCLAW_MODEL"
}
EOF
done

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 3: Run E2E Steps
# ══════════════════════════════════════════════════════════════════════════════
log ""
log "Phase 3: Running E2E scenario..."

SESSION_ID="e2e-gcp-$(date +%s)"

# ── Step 1: Send quickstart prompt ───────────────────────────────────────────
log "  Step: send_quickstart_prompt"
for i in $(seq 1 "$INSTANCE_COUNT"); do
  VM=$(vm_name "$i")
  INST_DIR="$ARTIFACT_DIR/instance-$i"
  TOKEN="${VM_TOKENS[$i]}"

  log "    [$VM] Sending prompt..."
  ssh_vm "$VM" "
    sudo -u openclaw \
      HOME=/home/openclaw \
      NODE_OPTIONS='--require /home/openclaw/.openclaw/gaxios-fetch-patch.cjs' \
      GOOGLE_APPLICATION_CREDENTIALS=/home/openclaw/.openclaw/vertex-sa-key.json \
      GOOGLE_CLOUD_PROJECT=${GCP_PROJECT} \
      GOOGLE_CLOUD_LOCATION=global \
      openclaw agent --session-id ${SESSION_ID}-${i} -m '$(echo "$PROMPT" | sed "s/'/'\\\\''/g")' --json 2>/dev/null || true
  " > "$INST_DIR/agent-output-quickstart.json" 2>/dev/null

  STATUS=$(python3 -c "
import json, sys
try:
  d=json.load(open('$INST_DIR/agent-output-quickstart.json'))
  print(d.get('status','unknown'))
except: print('parse-error')
" 2>/dev/null)
  log "    [$VM] status=$STATUS"
done

# ── Step 2: Wait for gateway recovery ────────────────────────────────────────
log "  Step: wait_gateway_recovered (15s)"
sleep 15

for i in $(seq 1 "$INSTANCE_COUNT"); do
  VM=$(vm_name "$i")
  for attempt in $(seq 1 36); do
    if ssh_vm "$VM" "curl -sf http://localhost:${GATEWAY_PORT}/" &>/dev/null; then
      break
    fi
    sleep 5
  done
done
log_ok "  All gateways healthy."

# ── Step 3: Run healthcheck ──────────────────────────────────────────────────
log "  Step: run_healthcheck"
for i in $(seq 1 "$INSTANCE_COUNT"); do
  VM=$(vm_name "$i")
  INST_DIR="$ARTIFACT_DIR/instance-$i"

  ssh_vm "$VM" "
    sudo -u openclaw \
      HOME=/home/openclaw \
      NODE_OPTIONS='--require /home/openclaw/.openclaw/gaxios-fetch-patch.cjs' \
      GOOGLE_APPLICATION_CREDENTIALS=/home/openclaw/.openclaw/vertex-sa-key.json \
      GOOGLE_CLOUD_PROJECT=${GCP_PROJECT} \
      GOOGLE_CLOUD_LOCATION=global \
      openclaw agent --session-id ${SESSION_ID}-${i} -m '/botcord_healthcheck' --json 2>/dev/null || true
  " > "$INST_DIR/agent-output-healthcheck.json" 2>/dev/null
done

# ── Step 4: Collect evidence ─────────────────────────────────────────────────
log "  Step: collect_evidence"
for i in $(seq 1 "$INSTANCE_COUNT"); do
  VM=$(vm_name "$i")
  INST_DIR="$ARTIFACT_DIR/instance-$i"

  # openclaw.json
  scp_from_vm "$VM" "/home/openclaw/.openclaw/openclaw.json" "$INST_DIR/openclaw.json" 2>/dev/null || true

  # credentials
  CRED_FILES=$(ssh_vm "$VM" "ls /home/openclaw/.botcord/credentials/*.json 2>/dev/null" || true)
  for f in $CRED_FILES; do
    FNAME=$(basename "$f")
    scp_from_vm "$VM" "$f" "$INST_DIR/credentials-$FNAME" 2>/dev/null || true
  done

  # journal log
  ssh_vm "$VM" "sudo journalctl -u openclaw --no-pager -n 100" > "$INST_DIR/journal.log" 2>/dev/null || true

  log "    [$VM] Evidence collected."
done

# ── Step 5: Switch env ───────────────────────────────────────────────────────
log "  Step: switch_env → $HUB_BASE_URL"
for i in $(seq 1 "$INSTANCE_COUNT"); do
  VM=$(vm_name "$i")
  INST_DIR="$ARTIFACT_DIR/instance-$i"

  # Rewrite hubUrl in all credential files
  CRED_FILES=$(ssh_vm "$VM" "ls /home/openclaw/.botcord/credentials/*.json 2>/dev/null" || true)
  if [[ -n "$CRED_FILES" ]]; then
    for f in $CRED_FILES; do
      ssh_vm "$VM" "
        sudo python3 -c \"
import json
with open('$f') as fp: d=json.load(fp)
old=d.get('hubUrl','(none)')
d['hubUrl']='${HUB_BASE_URL}'
with open('$f','w') as fp: json.dump(d,fp,indent=2)
print(f'switched {old} -> ${HUB_BASE_URL}')
\" 2>/dev/null
      "
    done
    log "    [$VM] hubUrl switched."
  else
    log_warn "    [$VM] No credentials — skipping."
  fi
done

# ── Step 6: Restart gateway ──────────────────────────────────────────────────
log "  Step: restart_gateway"
for i in $(seq 1 "$INSTANCE_COUNT"); do
  VM=$(vm_name "$i")
  ssh_vm "$VM" "sudo systemctl restart openclaw" 2>/dev/null
done
sleep 10
for i in $(seq 1 "$INSTANCE_COUNT"); do
  VM=$(vm_name "$i")
  for attempt in $(seq 1 36); do
    if ssh_vm "$VM" "curl -sf http://localhost:${GATEWAY_PORT}/" &>/dev/null; then
      log_ok "    [$(vm_name "$i")] Healthy after restart."
      break
    fi
    sleep 5
  done
done

# ── Step 7: Post-restart healthcheck ─────────────────────────────────────────
log "  Step: post_restart_healthcheck"
for i in $(seq 1 "$INSTANCE_COUNT"); do
  VM=$(vm_name "$i")
  INST_DIR="$ARTIFACT_DIR/instance-$i"

  ssh_vm "$VM" "
    sudo -u openclaw \
      HOME=/home/openclaw \
      NODE_OPTIONS='--require /home/openclaw/.openclaw/gaxios-fetch-patch.cjs' \
      GOOGLE_APPLICATION_CREDENTIALS=/home/openclaw/.openclaw/vertex-sa-key.json \
      GOOGLE_CLOUD_PROJECT=${GCP_PROJECT} \
      GOOGLE_CLOUD_LOCATION=global \
      openclaw agent --session-id ${SESSION_ID}-${i}-post -m '/botcord_healthcheck' --json 2>/dev/null || true
  " > "$INST_DIR/agent-output-post-restart-healthcheck.json" 2>/dev/null
done

# ── Step 8: Final evidence snapshot ──────────────────────────────────────────
log "  Step: final_evidence_snapshot"
for i in $(seq 1 "$INSTANCE_COUNT"); do
  VM=$(vm_name "$i")
  INST_DIR="$ARTIFACT_DIR/instance-$i"

  scp_from_vm "$VM" "/home/openclaw/.openclaw/openclaw.json" "$INST_DIR/openclaw-final.json" 2>/dev/null || true

  CRED_FILES=$(ssh_vm "$VM" "ls /home/openclaw/.botcord/credentials/*.json 2>/dev/null" || true)
  for f in $CRED_FILES; do
    FNAME=$(basename "$f")
    scp_from_vm "$VM" "$f" "$INST_DIR/credentials-final-$FNAME" 2>/dev/null || true
  done
done

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 4: Assertions
# ══════════════════════════════════════════════════════════════════════════════
log ""
log "Phase 4: Running assertions..."

TOTAL=0; PASSED=0; FAILED=0; SKIPPED=0

assert() {
  local inst="$1" id="$2" expected="$3" actual="$4" pass="$5"
  TOTAL=$((TOTAL + 1))
  if [[ "$pass" == "true" ]]; then
    PASSED=$((PASSED + 1))
    printf "  \033[32m✓\033[0m [instance-%s] %s\n" "$inst" "$id"
  elif [[ "$pass" == "skip" ]]; then
    SKIPPED=$((SKIPPED + 1))
    printf "  \033[33m○\033[0m [instance-%s] %s (skipped: %s)\n" "$inst" "$id" "$actual"
  else
    FAILED=$((FAILED + 1))
    printf "  \033[31m✗\033[0m [instance-%s] %s\n" "$inst" "$id"
    printf "      expected: %s\n" "$expected"
    printf "      actual:   %s\n" "$actual"
  fi
}

for i in $(seq 1 "$INSTANCE_COUNT"); do
  INST_DIR="$ARTIFACT_DIR/instance-$i"
  log "--- instance-$i ---"

  # Parse quickstart output
  QS_STATUS=$(python3 -c "
import json
try:
  d=json.load(open('$INST_DIR/agent-output-quickstart.json'))
  print(d.get('status','none'))
except: print('none')
" 2>/dev/null)
  assert "$i" "agent_output.status_ok" "ok" "$QS_STATUS" \
    "$([[ "$QS_STATUS" == "ok" ]] && echo true || echo false)"

  QS_TEXT=$(python3 -c "
import json
try:
  d=json.load(open('$INST_DIR/agent-output-quickstart.json'))
  ps=d.get('result',{}).get('payloads',[])
  print(ps[0].get('text','')[:100] if ps else '')
except: print('')
" 2>/dev/null)
  assert "$i" "agent_output.payload_non_empty" "non-empty" "${QS_TEXT:-(empty)}" \
    "$([[ -n "$QS_TEXT" ]] && echo true || echo false)"

  # openclaw.json (use final snapshot)
  CONFIG_FILE="$INST_DIR/openclaw-final.json"
  [[ -f "$CONFIG_FILE" ]] || CONFIG_FILE="$INST_DIR/openclaw.json"

  BOTCORD_ENABLED=$(python3 -c "
import json
try:
  d=json.load(open('$CONFIG_FILE'))
  print(str(d.get('channels',{}).get('botcord',{}).get('enabled',False)).lower())
except: print('false')
" 2>/dev/null)
  assert "$i" "openclaw_config.botcord_enabled" "true" "$BOTCORD_ENABLED" \
    "$([[ "$BOTCORD_ENABLED" == "true" ]] && echo true || echo false)"

  DELIVERY_MODE=$(python3 -c "
import json
try:
  d=json.load(open('$CONFIG_FILE'))
  print(d.get('channels',{}).get('botcord',{}).get('deliveryMode','none'))
except: print('none')
" 2>/dev/null)
  assert "$i" "openclaw_config.delivery_mode_set" "websocket|polling" "$DELIVERY_MODE" \
    "$([[ "$DELIVERY_MODE" == "websocket" || "$DELIVERY_MODE" == "polling" ]] && echo true || echo false)"

  # Credentials (use final snapshot)
  CRED_FILE=$(ls "$INST_DIR"/credentials-final-ag_*.json 2>/dev/null | head -1)
  [[ -n "$CRED_FILE" ]] || CRED_FILE=$(ls "$INST_DIR"/credentials-ag_*.json 2>/dev/null | head -1)

  if [[ -n "$CRED_FILE" ]]; then
    AGENT_ID=$(python3 -c "import json; print(json.load(open('$CRED_FILE')).get('agentId',''))" 2>/dev/null)
    HUB_URL=$(python3 -c "import json; print(json.load(open('$CRED_FILE')).get('hubUrl',''))" 2>/dev/null)

    assert "$i" "credentials.valid_json" "valid" "valid" "true"
    assert "$i" "credentials.has_agent_id" "ag_*" "$AGENT_ID" \
      "$([[ "$AGENT_ID" == ag_* ]] && echo true || echo false)"
    assert "$i" "credentials.hub_matches_environment" "$HUB_BASE_URL" "$HUB_URL" \
      "$([[ "$HUB_URL" == "$HUB_BASE_URL" ]] && echo true || echo false)"

    # DB assertions
    DB_URL_VAR="BOTCORD_$(echo "$ENV_NAME" | tr '[:lower:]' '[:upper:]')_DB_URL"
    DB_URL="${!DB_URL_VAR:-}"
    if [[ -z "$DB_URL" ]]; then
      assert "$i" "db.agent_exists" "agent in DB" "$DB_URL_VAR not set" "skip"
      assert "$i" "db.signing_key_active" "active key" "$DB_URL_VAR not set" "skip"
      assert "$i" "db.claim_code_present" "claim code" "$DB_URL_VAR not set" "skip"
    else
      DB_AGENT=$(node -e "
        const pg=require('pg');
        const c=new pg.Client({connectionString:'$DB_URL'});
        c.connect().then(()=>c.query('SELECT agent_id,claim_code FROM agents WHERE agent_id=\$1',['$AGENT_ID']))
        .then(r=>{console.log(JSON.stringify(r.rows[0]||{}));c.end()})
        .catch(()=>{console.log('{}');c.end()})
      " 2>/dev/null)
      DB_AGENT_ID=$(echo "$DB_AGENT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('agent_id',''))" 2>/dev/null)
      DB_CLAIM=$(echo "$DB_AGENT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('claim_code',''))" 2>/dev/null)
      assert "$i" "db.agent_exists" "$AGENT_ID" "${DB_AGENT_ID:-(not found)}" \
        "$([[ "$DB_AGENT_ID" == "$AGENT_ID" ]] && echo true || echo false)"

      DB_KEY=$(node -e "
        const pg=require('pg');
        const c=new pg.Client({connectionString:'$DB_URL'});
        c.connect().then(()=>c.query(\"SELECT key_id FROM signing_keys WHERE agent_id=\\\$1 AND state='active'\",[\"$AGENT_ID\"]))
        .then(r=>{console.log(r.rows.length);c.end()})
        .catch(()=>{console.log('0');c.end()})
      " 2>/dev/null)
      assert "$i" "db.signing_key_active" ">=1" "$DB_KEY" \
        "$([[ "$DB_KEY" -ge 1 ]] 2>/dev/null && echo true || echo false)"

      assert "$i" "db.claim_code_present" "clm_*" "${DB_CLAIM:-(empty)}" \
        "$([[ "$DB_CLAIM" == clm_* ]] && echo true || echo false)"
    fi
  else
    assert "$i" "credentials.valid_json" "valid" "(no credentials file)" "false"
    assert "$i" "credentials.has_agent_id" "ag_*" "(missing)" "false"
    assert "$i" "credentials.hub_matches_environment" "$HUB_BASE_URL" "(missing)" "false"
    assert "$i" "db.agent_exists" "agent in DB" "no credentials" "skip"
    assert "$i" "db.signing_key_active" "active key" "no credentials" "skip"
    assert "$i" "db.claim_code_present" "claim code" "no credentials" "skip"
  fi
done

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 5: Report & Cleanup
# ══════════════════════════════════════════════════════════════════════════════
log ""
log "============================================"
if [[ $FAILED -eq 0 && $TOTAL -gt 0 ]]; then
  log_ok "RESULT: PASSED"
else
  log_err "RESULT: FAILED"
fi
log "Total: $TOTAL | Passed: $PASSED | Failed: $FAILED | Skipped: $SKIPPED"
log "Artifacts: $ARTIFACT_DIR"
log "============================================"

# Cleanup VMs
if [[ "$KEEP_VMS" == "true" ]]; then
  log_warn "VMs kept alive (--keep). Destroy with: ./gcp-run.sh --destroy"
  for i in $(seq 1 "$INSTANCE_COUNT"); do
    log "  $(vm_name "$i"): ${VM_IPS[$i]:-unknown}:$GATEWAY_PORT"
  done
else
  log "Destroying VMs..."
  destroy_vms
  log_ok "VMs destroyed."
fi

exit $([[ $FAILED -eq 0 ]] && echo 0 || echo 1)
