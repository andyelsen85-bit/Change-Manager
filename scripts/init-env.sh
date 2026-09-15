#!/usr/bin/env bash
# Bootstrap a private .env file with independent, high-entropy values.
#
# A newly created .env receives 32 random bytes (hex encoded) for every local
# secret. Existing values are never rotated by this script: a configured but
# weak value is an error, and a missing APP_ENCRYPTION_KEY is an explicit
# migration step because it may need to retain the old JWT-derived ciphertext
# key. Set that value deliberately before rotating session/JWT secrets.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
EXAMPLE_FILE="${ROOT_DIR}/.env.example"

usage() {
  cat <<'USAGE'
Usage: ./scripts/init-env.sh [--fresh-install]

Validate an existing .env without changing its secrets. If .env is absent,
the script fails closed because an existing database or encrypted ciphertext
may still depend on the lost values. Pass --fresh-install only when creating
a brand-new local/test database with no existing data:

  ./scripts/init-env.sh --fresh-install
USAGE
}

fresh_install=0
case "${1:-}" in
  "")
    ;;
  --fresh-install)
    fresh_install=1
    ;;
  --help|-h)
    usage
    exit 0
    ;;
  *)
    echo "ERROR: unknown option: $1" >&2
    usage >&2
    exit 2
    ;;
esac

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

# Validate using the same byte rules as the API without ever echoing the
# candidate value. This recognises raw UTF-8, even-length hex, padded base64,
# and unpadded base64url generated values.
is_strong_secret() {
  local value="$1"
  SECRET_VALUE="${value}" node <<'NODE'
const value = process.env.SECRET_VALUE ?? "";
const placeholders = new Set([
  "changeme",
  "change-me",
  "change_me",
  "please-change-me",
  "please_change_me",
  "replace-me",
  "replace_me",
  "replace-with-a-long-random-string",
  "replace_with_a_long_random_string",
  "your-secret-here",
  "your_secret_here",
  "your-secret",
  "your_secret",
  "secret",
  "password",
  "jwt-secret",
  "jwt_secret",
  "app-encryption-key",
  "app_encryption_key",
  "session-secret",
  "session_secret",
  "dev-only-change-mgmt-secret-do-not-use-in-prod",
  "dev-only-app-encryption-key",
]);
const normalized = value.trim().toLowerCase();
if (
  !normalized ||
  placeholders.has(normalized) ||
  /^<[^>]+>$/.test(normalized) ||
  /^(?:x|y|z|0|1|a){4,}$/.test(normalized) ||
  /^(?:secret|password|replace|change|please)[-_ ]?(?:me|here|this)?$/.test(normalized)
) {
  process.exit(1);
}

let bytes;
if (/^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) {
  bytes = Buffer.from(value, "hex");
} else {
  const looksLikeBase64 =
    value.length >= 40 || value.includes("=") || value.includes("-") || value.includes("_");
  if (looksLikeBase64 && /^[A-Za-z0-9+/_-]*={0,2}$/.test(value)) {
    const unpadded = value.replace(/=+$/, "");
    if (unpadded && unpadded.length % 4 !== 1) {
      const standard = unpadded.replace(/-/g, "+").replace(/_/g, "/");
      const padded = standard + "=".repeat((4 - (standard.length % 4)) % 4);
      const decoded = Buffer.from(padded, "base64");
      if (decoded.length && decoded.toString("base64").replace(/=+$/, "") === standard) {
        bytes = decoded;
      }
    }
  }
  if (!bytes) bytes = Buffer.from(value, "utf8");
}

if (bytes.length < 32 || /^(.)\1+$/.test(value) || /^(.{1,4})\1+$/.test(value)) {
  process.exit(1);
}
process.exit(0);
NODE
}

get_value() {
  local var="$1"
  local line
  line="$(grep -E "^${var}=" "${ENV_FILE}" | head -n 1 || true)"
  printf '%s' "${line#*=}"
}

has_value() {
  local var="$1"
  local value
  [[ -f "${ENV_FILE}" ]] || return 1
  value="$(get_value "${var}")"
  [[ -n "${value}" ]]
}

set_kv() {
  local var="$1"
  local value="$2"
  local tmp
  tmp="$(mktemp)"
  if grep -qE "^${var}=" "${ENV_FILE}"; then
    awk -v var="${var}" -v val="${value}" '
      BEGIN { FS = OFS = "=" }
      $1 == var { print var "=" val; next }
      { print }
    ' "${ENV_FILE}" > "${tmp}"
  else
    cat "${ENV_FILE}" > "${tmp}"
    printf '%s=%s\n' "${var}" "${value}" >> "${tmp}"
  fi
  mv "${tmp}" "${ENV_FILE}"
}

fail_existing_secret() {
  local var="$1"
  local value
  value="$(get_value "${var}")"
  if [[ -z "${value}" ]]; then
    echo "ERROR: ${var} is missing or empty in an existing .env; set it explicitly." >&2
  elif ! is_strong_secret "${value}"; then
    echo "ERROR: ${var} is weak or a placeholder; refusing to rotate an existing value." >&2
  else
    echo "ERROR: ${var} is invalid; set it explicitly." >&2
  fi
  exit 1
}

created=0
if [[ ! -f "${ENV_FILE}" ]]; then
  if [[ "${fresh_install}" -ne 1 ]]; then
    echo "ERROR: ${ENV_FILE} is absent; refusing to generate replacement secrets." >&2
    echo "Restore the .env/key backup for an existing database, or acknowledge a brand-new local/test install with:" >&2
    echo "    ./scripts/init-env.sh --fresh-install" >&2
    exit 1
  fi
  cp "${EXAMPLE_FILE}" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  created=1
  echo "Created ${ENV_FILE} from .env.example."
fi

healed=()
if [[ "${created}" -eq 1 ]]; then
  # A fresh local installation has no ciphertext or database state to
  # preserve, so independent values are safe to generate together.
  set_kv POSTGRES_PASSWORD "$(rand_hex 32)"
  set_kv JWT_SECRET "$(rand_hex 32)"
  set_kv SESSION_SECRET "$(rand_hex 32)"
  set_kv APP_ENCRYPTION_KEY "$(rand_hex 32)"
  healed+=("POSTGRES_PASSWORD" "JWT_SECRET" "SESSION_SECRET" "APP_ENCRYPTION_KEY")
else
  # A DATABASE_URL supplied by an externally managed database is authoritative;
  # do not require or rotate a redundant POSTGRES_PASSWORD in that case.
  if ! has_value DATABASE_URL && ! has_value POSTGRES_PASSWORD; then
    fail_existing_secret POSTGRES_PASSWORD
  fi
  if has_value POSTGRES_PASSWORD && ! is_strong_secret "$(get_value POSTGRES_PASSWORD)"; then
    fail_existing_secret POSTGRES_PASSWORD
  fi

  if ! has_value APP_ENCRYPTION_KEY; then
    echo "ERROR: APP_ENCRYPTION_KEY must be set explicitly for an existing installation." >&2
    echo "If ciphertext was created with the former JWT fallback, carry that value forward first; rotate it only after re-encryption." >&2
    exit 1
  fi
  if ! is_strong_secret "$(get_value APP_ENCRYPTION_KEY)"; then
    fail_existing_secret APP_ENCRYPTION_KEY
  fi

  if has_value JWT_SECRET && ! is_strong_secret "$(get_value JWT_SECRET)"; then
    fail_existing_secret JWT_SECRET
  fi
  if has_value SESSION_SECRET && ! is_strong_secret "$(get_value SESSION_SECRET)"; then
    fail_existing_secret SESSION_SECRET
  fi
  if ! has_value JWT_SECRET && ! has_value SESSION_SECRET; then
    echo "ERROR: set SESSION_SECRET (preferred) or JWT_SECRET in the existing .env." >&2
    exit 1
  fi
fi

chmod 600 "${ENV_FILE}"

if [[ "${created}" -eq 1 ]]; then
  echo "Generated independent 32-byte values for: ${healed[*]}"
  echo "File permissions on ${ENV_FILE} are 0600."
else
  echo "${ENV_FILE} already has configured secrets; no values were changed."
fi

echo
echo "You can now run:"
echo "    docker compose up -d --build"
echo
