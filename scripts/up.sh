#!/usr/bin/env bash
# One-command bring-up of the docker-compose stack.
#   1. Bootstraps .env via scripts/init-env.sh if it does not yet exist
#      (generates strong random POSTGRES_PASSWORD and JWT_SECRET).
#   2. Builds + starts the stack with `docker compose up -d --build`.
#   3. Tails follow-mode logs so you can watch the bring-up.
#
# Use this instead of running `docker compose up` directly when you've just
# cloned (or pulled) the repo and have not yet authored a .env file.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

if [[ ! -f .env ]]; then
  echo "[up.sh] .env not found — bootstrapping it now…"
  ./scripts/init-env.sh
fi

# Prefer `docker compose` (v2 plugin); fall back to legacy `docker-compose`.
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "ERROR: neither 'docker compose' nor 'docker-compose' is installed." >&2
  exit 1
fi

echo "[up.sh] Building and starting the stack…"
"${COMPOSE[@]}" up -d --build

echo
echo "[up.sh] Stack is up. Following logs (Ctrl-C to detach — containers keep running):"
echo
"${COMPOSE[@]}" logs -f --tail=50
