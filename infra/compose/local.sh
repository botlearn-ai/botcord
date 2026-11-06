#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
ENV_FILE="$DIR/.env.local"
COMPOSE_FILE="$DIR/docker-compose-debug.yml"
OPERATION="${1:-up}"
shift || true

usage() {
  echo "Usage: $0 {up|core-up|down|ps|logs [postgres|redis|botcord-backend|botcord-gateway-ingress|botcord-frontend]|config}" >&2
}

case "$OPERATION" in
  up|core-up|down|config)
    if (( $# != 0 )); then usage; exit 2; fi
    ;;
  ps|logs)
    for service in "$@"; do
      case "$service" in
        postgres|redis|botcord-backend|botcord-gateway-ingress|botcord-frontend) ;;
        *) usage; exit 2 ;;
      esac
    done
    ;;
  *) usage; exit 2 ;;
esac

command -v docker >/dev/null || { echo "Docker with Compose is required." >&2; exit 1; }
docker compose version >/dev/null

create_environment() {
  command -v openssl >/dev/null || { echo "openssl is required to generate local secrets." >&2; exit 1; }
  umask 077
  local temporary_environment
  temporary_environment="$(mktemp "$DIR/.env.local.XXXXXX")"
  trap 'rm -f "${temporary_environment:-}"' EXIT
  {
    printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 32)"
    printf 'REDIS_PASSWORD=%s\n' "$(openssl rand -hex 32)"
    printf 'BIND_PROOF_SECRET=%s\n' "$(openssl rand -hex 32)"
    printf 'JWT_SECRET=%s\n' "$(openssl rand -hex 32)"
    printf 'INTERNAL_API_SECRET=%s\n' "$(openssl rand -hex 32)"
    printf 'CLOUD_GATEWAY_INGRESS_SECRET=%s\n' "$(openssl rand -hex 32)"
    printf 'BOTCORD_HUB_CONTROL_PRIVATE_KEY=%s\n' "$(openssl rand -base64 32 | tr -d '\n')"
    printf 'CLOUD_AGENT_FEATURE_ENABLED=false\n'
    printf 'BOTLEARN_INTEGRATION_ENABLED=false\n'
    printf 'EXPO_PUSH_ENABLED=false\n'
  } > "$temporary_environment"
  mv -n "$temporary_environment" "$ENV_FILE"
  trap - EXIT
  echo "Created private local environment at infra/compose/.env.local."
}

if [[ ! -f "$ENV_FILE" ]]; then
  if [[ "$OPERATION" != up && "$OPERATION" != core-up ]]; then
    echo "No local environment yet. Run: infra/compose/local.sh up" >&2
    exit 1
  fi
  create_environment
fi
chmod 600 "$ENV_FILE"
if [[ "$OPERATION" == up ]] && ! grep -q '^BIND_PROOF_SECRET=' "$ENV_FILE"; then
  printf '\nBIND_PROOF_SECRET=%s\n' "$(openssl rand -hex 32)" >> "$ENV_FILE"
fi

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

validate_shared_environment() {
  # The rendered configuration is piped directly to the validator. Neither
  # Compose nor the validator writes secret values to the terminal.
  compose config --format json | python3 "$DIR/validate_shared_environment.py" --mode "$1"
}

cd "$ROOT"
case "$OPERATION" in
  up)
    compose config --quiet
    validate_shared_environment up
    compose up -d --build --wait --wait-timeout 900 --remove-orphans
    compose ps
    ;;
  core-up)
    compose config --quiet
    validate_shared_environment core-up
    compose up -d --build --wait --wait-timeout 900 postgres redis botcord-backend botcord-gateway-ingress
    compose ps
    ;;
  down)
    compose down
    ;;
  ps)
    compose ps "$@"
    ;;
  logs)
    compose logs --tail 100 "$@"
    ;;
  config)
    # Validate only: rendered Compose would reveal generated secrets.
    compose config --quiet
    echo "Compose configuration is valid."
    ;;
esac
