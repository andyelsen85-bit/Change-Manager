#!/usr/bin/env bash
# Generates a .env file at the repo root with strong random values for the
# variables that docker-compose.yml requires (POSTGRES_PASSWORD, JWT_SECRET).
# Idempotent: if .env already exists, the script reports it and exits 0
# without overwriting. Run this once before `docker compose up -d`.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
EXAMPLE_FILE="${ROOT_DIR}/.env.example"

if [[ -f "${ENV_FILE}" ]]; then
  echo ".env already exists at ${ENV_FILE} — leaving it untouched."
  echo "If you want to regenerate, delete it first:  rm ${ENV_FILE}"
  exit 0
fi

if [[ ! -f "${EXAMPLE_FILE}" ]]; then
  echo "ERROR: ${EXAMPLE_FILE} not found." >&2
  exit 1
fi

rand_hex() {
  # 32 bytes -> 64 hex chars. Falls back to /dev/urandom if openssl absent.
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    head -c "$1" /dev/urandom | xxd -p -c 256
  fi
}

POSTGRES_PASSWORD="$(rand_hex 24)"
JWT_SECRET="$(rand_hex 64)"

# Start from the example file then substitute the placeholders for the two
# values that MUST be strong and unique per deployment.
sed \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${POSTGRES_PASSWORD}|" \
  -e "s|^JWT_SECRET=.*|JWT_SECRET=${JWT_SECRET}|" \
  "${EXAMPLE_FILE}" > "${ENV_FILE}"

chmod 600 "${ENV_FILE}"

echo "Generated ${ENV_FILE} with strong random POSTGRES_PASSWORD and JWT_SECRET."
echo "File permissions set to 0600. You can now run:"
echo
echo "    docker compose up -d --build"
echo
