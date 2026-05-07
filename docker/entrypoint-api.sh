#!/bin/sh
# Entrypoint for the api container.
#
# Ensures JWT_SECRET is set before exec'ing the Node server. Resolution order:
#   1. JWT_SECRET env var already set (e.g. from .env / docker-compose) and
#      non-empty           → honoured as-is.
#   2. /var/secrets/jwt_secret file exists → read it.
#   3. Otherwise            → generate a 64-byte hex secret, persist it to
#                             /var/secrets/jwt_secret (mode 0600), export.
#
# /var/secrets is backed by a named docker volume (`api_secrets`) so the
# generated secret survives `docker compose down`/`up` cycles and existing
# user sessions remain valid across restarts. If the operator wants to
# rotate the secret they delete the volume (or the file) and restart.
set -eu

SECRET_DIR=/var/secrets
SECRET_FILE="${SECRET_DIR}/jwt_secret"

if [ -z "${JWT_SECRET:-}" ]; then
  mkdir -p "${SECRET_DIR}"
  if [ -s "${SECRET_FILE}" ]; then
    JWT_SECRET="$(cat "${SECRET_FILE}")"
    echo "[entrypoint-api] Loaded JWT_SECRET from ${SECRET_FILE}"
  else
    # Use Node so we don't require openssl/coreutils in the runtime image.
    JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")"
    umask 077
    printf '%s' "${JWT_SECRET}" > "${SECRET_FILE}"
    echo "[entrypoint-api] Generated new JWT_SECRET and persisted to ${SECRET_FILE}"
  fi
  export JWT_SECRET
fi

exec node --enable-source-maps ./dist/index.mjs
