# syntax=docker/dockerfile:1.7
# Multi-stage build for the IT Change Management app.
# Produces two runtime images via build targets: `api` (Node) and `web` (Nginx).

ARG NODE_VERSION=24-alpine

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
EXPOSE 8080
USER node
CMD ["node", "--enable-source-maps", "./dist/index.mjs"]

# --- web runtime (Nginx serving static frontend + TLS + reverse proxy) ------
FROM nginx:1.27-alpine AS web
RUN apk add --no-cache openssl
COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY docker/entrypoint-web.sh /entrypoint-web.sh
RUN chmod +x /entrypoint-web.sh
COPY --from=builder /repo/artifacts/change-mgmt/dist/public /usr/share/nginx/html
EXPOSE 80 443
ENTRYPOINT ["/entrypoint-web.sh"]
