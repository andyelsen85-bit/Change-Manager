# syntax=docker/dockerfile:1.7
# Multi-stage build for the IT Change Management app.
# Produces two runtime images via build targets: `api` (Node) and `web` (Nginx).

# Use a glibc-based image (debian-slim) instead of alpine/musl. The pnpm
# lockfile is generated on glibc hosts and pins `@rollup/rollup-linux-x64-gnu`;
# building on alpine fails with "Cannot find module @rollup/rollup-linux-x64-musl"
# because pnpm --frozen-lockfile won't fetch the musl optional binary.
ARG NODE_VERSION=24-bookworm-slim

# --- base: install pnpm + workspace deps -------------------------------------
FROM node:${NODE_VERSION} AS base
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.26.1 --activate
WORKDIR /repo

# Copy lockfile + workspace manifests first for better layer caching
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc* ./
COPY artifacts/api-server/package.json artifacts/api-server/package.json
COPY artifacts/change-mgmt/package.json artifacts/change-mgmt/package.json
COPY lib/db/package.json lib/db/package.json
COPY lib/api-zod/package.json lib/api-zod/package.json
COPY lib/api-spec/package.json lib/api-spec/package.json

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

# --- builder: build api + frontend ------------------------------------------
FROM base AS builder
COPY . .
ENV NODE_ENV=production
ENV PORT=8080
ENV BASE_PATH=/
# Build api-server bundle
RUN pnpm --filter @workspace/api-server run build
# Build static frontend (Vite)
RUN pnpm --filter @workspace/change-mgmt run build

# --- api runtime ------------------------------------------------------------
FROM node:${NODE_VERSION} AS api
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
COPY --from=builder /repo/artifacts/api-server/dist ./dist
COPY docker/entrypoint-api.sh /entrypoint-api.sh
# /var/secrets is backed by the `api_secrets` named volume in compose; the
# entrypoint persists an auto-generated JWT_SECRET there when one is not
# supplied via the environment. Pre-create it owned by the node user so the
# unprivileged process can write to it.
RUN chmod +x /entrypoint-api.sh \
 && mkdir -p /var/secrets \
 && chown -R node:node /var/secrets
EXPOSE 8080
USER node
ENTRYPOINT ["/entrypoint-api.sh"]

# --- web runtime (Nginx serving static frontend + TLS + reverse proxy) ------
FROM nginx:1.27-alpine AS web
RUN apk add --no-cache openssl postgresql16-client
COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY docker/entrypoint-web.sh /entrypoint-web.sh
RUN chmod +x /entrypoint-web.sh
COPY --from=builder /repo/artifacts/change-mgmt/dist/public /usr/share/nginx/html
EXPOSE 80 443
ENTRYPOINT ["/entrypoint-web.sh"]
