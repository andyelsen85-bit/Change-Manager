#!/usr/bin/env bash
# update.sh — pull the latest version from GitHub, build the Docker images,
# tag them with the release version and push them to the Nexus registry.
#
# Usage:
#   ./update.sh            # version is read from artifacts/api-server/package.json
#   ./update.sh 2.1.6      # or pass the version explicitly
#
# Overridable via environment:
#   REGISTRY   (default: srvnexusint.hopital.chdn.lan:6443/infra)
#   PROJECT    (default: change-manager — the docker compose project name,
#               which determines the local image names <project>-<service>)

set -euo pipefail

REGISTRY="${REGISTRY:-srvnexusint.hopital.chdn.lan:6443/infra}"
PROJECT="${PROJECT:-change-manager}"

cd "$(dirname "$0")"

echo "==> Pulling latest code from git"
git pull --ff-only

# Resolve the version AFTER git pull so we tag what we just pulled.
if [[ $# -ge 1 ]]; then
  VERSION="$1"
else
  VERSION="$(node -p "require('./artifacts/api-server/package.json').version" 2>/dev/null || true)"
  if [[ -z "${VERSION}" ]]; then
    # Fallback if node is not installed on the host
    VERSION="$(grep -m1 '"version"' artifacts/api-server/package.json | sed -E 's/.*"version": *"([^"]+)".*/\1/')"
  fi
fi
if [[ -z "${VERSION}" ]]; then
  echo "ERROR: could not determine version. Pass it explicitly: ./update.sh 2.1.6" >&2
  exit 1
fi
echo "==> Deploying version ${VERSION}"

echo "==> Building images (no cache)"
docker compose -p "${PROJECT}" build --no-cache

# local image name -> remote image name
declare -A IMAGES=(
  ["${PROJECT}-migrate"]="change-manager-builder"
  ["${PROJECT}-api"]="change-manager-api"
  ["${PROJECT}-web"]="change-manager-web"
)

echo "==> Tagging and pushing to ${REGISTRY}"
for local in "${!IMAGES[@]}"; do
  remote="${REGISTRY}/${IMAGES[$local]}:${VERSION}"
  if ! docker image inspect "${local}" >/dev/null 2>&1; then
    echo "ERROR: expected local image '${local}' not found after build." >&2
    echo "       Check 'docker images' — your compose project name may differ (set PROJECT=...)." >&2
    exit 1
  fi
  docker image tag "${local}" "${remote}"
  docker push "${remote}"
done

echo "==> Done. Pushed version ${VERSION}:"
for local in "${!IMAGES[@]}"; do
  echo "    ${REGISTRY}/${IMAGES[$local]}:${VERSION}"
done
