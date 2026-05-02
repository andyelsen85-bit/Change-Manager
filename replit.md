# IT Change Management

Production-ready, ITIL v4-aligned IT Change Management web app.

## Overview

A pnpm workspace monorepo (TypeScript) that ships:

- `artifacts/api-server` — Express 5 API (auth, RBAC, change requests, phases, approvals, CAB, comments, dashboard, settings, audit).
- `artifacts/change-mgmt` — React + Vite web frontend (TanStack Query, wouter, shadcn/ui, Tailwind v4, light/dark theme).
- `lib/db` — Drizzle ORM schema + migrations (PostgreSQL).
- `lib/api-spec` / `lib/api-zod` — OpenAPI spec and generated Zod schemas / React Query hooks.
- `Dockerfile` + `docker-compose.yml` + `docker/` — self-host bundle (Nginx + Node + Postgres) listening on 80/443 with auto self-signed TLS.

## Feature highlights

- **Change tracks**: Normal, Standard, Emergency. Each has Planning + Testing + PIR phases.
- **Standard templates**: 15 seeded templates that auto-approve and bypass CAB.
- **Approvals**: role-based per track — Normal needs Change Manager + Technical Reviewer + Business Owner, Emergency needs Change Manager + eCAB member, Standard auto-approves.
- **CAB / eCAB**: calendar of meetings, attendee management, ICS invite download + email send.
- **Deputies / replacements** for every governance role (incl. Change Manager) so approvals never block.
- **Notifications**: per-user granular email + in-app preferences keyed by event.
- **Auth**: local users (bcrypt) + LDAP. JWT cookie session (`cm_session`).
- **Settings (admin)**: SMTP, LDAP, SSL/TLS upload + in-app CSR generation (POST /api/settings/ssl/csr — RSA 2048/3072/4096, DNS+IP SANs, key usage / extKeyUsage server-auth, private key persisted server-side until the signed cert is uploaded), session/lockout timeouts. Sensitive values returned as `*Set` booleans on GET.
- **Audit log**: immutable JSONB before/after snapshots, including login/logout with IP and user agent. Admin-only; CSV export.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js**: 24
- **TypeScript**: 5.9
- **API**: Express 5, pino logging, jsonwebtoken, bcryptjs, ldapjs, nodemailer, ics
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **Frontend**: React 18, Vite 7, Tailwind v4, shadcn/ui, TanStack Query, wouter, sonner, framer-motion, recharts
- **Build**: esbuild (api CJS bundle), Vite (frontend static), multi-stage Docker

## Workspace layout

```
artifacts/
  api-server/      # Express API (port 8080)
  change-mgmt/     # Vite frontend (port 5000 in dev)
  mockup-sandbox/  # Replit canvas helper (port 8081)
lib/
  db/              # Drizzle schemas + migrations
  api-spec/        # OpenAPI single source of truth
  api-zod/         # Generated Zod schemas / React Query hooks
docker/            # Nginx config + entrypoint for the web container
```

## Default credentials

`admin` / `admin` (local user, seeded on first boot — change immediately).

## Key commands

- `pnpm run typecheck` — typecheck all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks + Zod schemas from OpenAPI
- `pnpm --filter @workspace/db run push` — push DB schema (dev)
- `pnpm --filter @workspace/api-server run dev` — run API locally (port 8080)
- `pnpm --filter @workspace/change-mgmt run dev` — run web frontend locally (port 5000)

## Self-hosting with Docker (80 / 443)

```
cp .env.example .env
# edit .env: set POSTGRES_PASSWORD and JWT_SECRET (use: openssl rand -hex 64)
docker compose up -d --build
```

The compose stack runs Postgres, applies migrations, starts the Node API, and an Nginx
container that serves the static frontend on `:80`/`:443` and reverse-proxies `/api/*`
to the API. On first boot the web container generates a self-signed cert at
`./certs/server.{crt,key}` if none exists; drop your real cert in there to override
(no rebuild needed). TLS can also be disabled with `DISABLE_TLS=true` in `.env`.

## Development on Replit

The Replit dev environment runs three workflows:

- `artifacts/api-server: API Server` — Express on `:8080` (proxied to `/api`)
- `artifacts/change-mgmt: web` — Vite on `:5000` (proxied to `/`)
- `artifacts/mockup-sandbox: Component Preview Server` — Vite on `:8081`

> Note: Vite reads stdin and exits on EOF, which makes it look like the workflow
> "didn't open a port". The change-mgmt `dev` script wraps Vite as
> `tail -f /dev/null | vite dev` so stdin stays open under the workflow runner.

See the `pnpm-workspace` skill for monorepo conventions.
