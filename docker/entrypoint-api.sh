#!/bin/sh
# Entrypoint for the API container.
#
# A persisted JWT file is loaded only as compatibility for installations that
# previously relied on the entrypoint's JWT bootstrap. Existing values are
# never replaced here: production startup validation rejects missing, weak, or
# placeholder values instead of silently rotating them. APP_ENCRYPTION_KEY is
# intentionally never generated or derived from JWT_SECRET.
set -eu

SECRET_DIR=/var/secrets
JWT_SECRET_FILE="${SECRET_DIR}/jwt_secret"

if [ -z "${JWT_SECRET:-}" ] && [ -s "${JWT_SECRET_FILE}" ]; then
  JWT_SECRET="$(cat "${JWT_SECRET_FILE}")"
  export JWT_SECRET
  echo "[entrypoint-api] Loaded the existing JWT compatibility secret."
fi

exec node --enable-source-maps ./dist/index.mjs