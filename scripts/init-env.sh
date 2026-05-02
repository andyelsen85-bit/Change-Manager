#!/usr/bin/env bash
# Bootstraps / heals the .env file at the repo root so docker-compose can
# interpolate the required POSTGRES_PASSWORD and JWT_SECRET variables.
#
# Behaviour:
#   1. If .env does not exist, it is created from .env.example with strong
#      random values for POSTGRES_PASSWORD and JWT_SECRET.
#   2. If .env exists but is missing one of those two variables (or still
#      contains the placeholder default from .env.example), only the missing
#      / placeholder fields are filled in — every other line is preserved.
#   3. If both variables already have non-placeholder values, the script is
#      a no-op and exits 0.
#
# Run this once (or any time you see a "required variable … is missing a
# value" error from docker compose) before `docker compose up -d --build`.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
EXAMPLE_FILE="${ROOT_DIR}/.env.example"

if [[ ! -f "${EXAMPLE_FILE}" ]]; then
  echo "ERROR: ${EXAMPLE_FILE} not found." >&2
  exit 1
fi

rand_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    head -c "$1" /dev/urandom | xxd -p -c 256
  fi
}

# Returns 0 if the given variable is set to a meaningful value in .env
# (i.e. present, non-empty, and not one of the .env.example placeholders).
has_real_value() {
  local var="$1"
  local file="$2"
  [[ -f "${file}" ]] || return 1
  local line value
  line="$(grep -E "^${var}=" "${file}" || true)"
  [[ -n "${line}" ]] || return 1
  value="${line#*=}"
  [[ -n "${value}" ]] || return 1
  case "${value}" in
    please-change-me|replace-with-a-long-random-string|changeme|change-me|"") return 1 ;;
  esac
  return 0
}

# Sets KEY=VALUE in .env: replaces an existing line in place if present,
# otherwise appends a new line. Uses a temp file to remain safe on failure.
set_kv() {
  local var="$1"
  local value="$2"
  local file="$3"
  local tmp
  tmp="$(mktemp)"
  if grep -qE "^${var}=" "${file}"; then
    awk -v var="${var}" -v val="${value}" '
      BEGIN { FS = OFS = "=" }
      $1 == var { print var "=" val; next }
      { print }
    ' "${file}" > "${tmp}"
  else
    cat "${file}" > "${tmp}"
    echo "${var}=${value}" >> "${tmp}"
  fi
  mv "${tmp}" "${file}"
}

# Case 1: no .env at all → create from example.
if [[ ! -f "${ENV_FILE}" ]]; then
  cp "${EXAMPLE_FILE}" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  echo "Created ${ENV_FILE} from .env.example."
fi

# Case 2/3: heal any missing or placeholder values.
healed=()
if ! has_real_value POSTGRES_PASSWORD "${ENV_FILE}"; then
  set_kv POSTGRES_PASSWORD "$(rand_hex 24)" "${ENV_FILE}"
  healed+=("POSTGRES_PASSWORD")
fi
if ! has_real_value JWT_SECRET "${ENV_FILE}"; then
  set_kv JWT_SECRET "$(rand_hex 64)" "${ENV_FILE}"
  healed+=("JWT_SECRET")
fi

chmod 600 "${ENV_FILE}"

if [[ ${#healed[@]} -eq 0 ]]; then
  echo "${ENV_FILE} already has POSTGRES_PASSWORD and JWT_SECRET set — nothing to do."
else
  echo "Filled in strong random values for: ${healed[*]}"
  echo "File permissions on ${ENV_FILE} are 0600."
fi

echo
echo "You can now run:"
echo "    docker compose up -d --build"
echo
