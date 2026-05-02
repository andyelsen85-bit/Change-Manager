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
- **Approvals**: role-based per track — Normal needs only Change Manager (post-CAB sign-off); Emergency needs Change Manager + eCAB member; Standard auto-approves. The Change Manager's deputy can vote in their absence.
- **Roles**: Change Manager, Technical Reviewer, Business Owner, **CAB Member**, eCAB Member, Implementer, Tester, Service Owner, Security Reviewer. Every role supports a deputy.
- **CAB / eCAB**: calendar of meetings, attendee management, ICS invite download (members add it to their calendar themselves), and a "Send agenda" action that emails every member the full agenda — meeting metadata plus, for every change on the docket, its ref/title, track, status, risk, impact, planned start/end, and full description — so members can review before the meeting starts. The "New meeting" dialog defaults the attendee list to all primary CAB Members for a standard CAB and to all primary eCAB Members for an eCAB; switching the meeting kind reapplies the corresponding default. Backed by `GET /api/users?role=<key>&primary=1` (filters to non-deputy assignments) and `POST /api/cab-meetings/:id/send-agenda`.
- **Change progress timeline**: the Change detail page shows a per-track horizontal timeline (green ✓ for completed steps, highlighted current step, muted future steps; cancelled / rejected / rolled-back rendered as a red stop-tile) so it's obvious at a glance where the change is in its lifecycle.
- **Deputies / replacements** for every governance role (incl. Change Manager) so approvals never block.
- **Notifications**: per-user granular email + in-app preferences keyed by event.
- **Auth**: local users (bcrypt) + LDAP. JWT cookie session (`cm_session`). CSRF protection via double-submit cookie (`cm_csrf` non-HttpOnly cookie + `X-CSRF-Token` header) — required on every POST/PATCH/PUT/DELETE under `/api` except `/api/auth/login`. Token issued on login, cleared on logout, healed by `/api/auth/me`. The frontend `api` client in `artifacts/change-mgmt/src/lib/api.ts` reads the cookie and attaches the header automatically.
- **Settings (admin)**: SMTP, LDAP, SSL/TLS upload + in-app CSR generation (POST /api/settings/ssl/csr — RSA 2048/3072/4096, DNS+IP SANs, key usage / extKeyUsage server-auth, private key persisted server-side until the signed cert is uploaded), session/lockout timeouts. Sensitive values returned as `*Set` booleans on GET.
- **LDAP diagnostics**: `authenticateLdap` and `POST /api/settings/ldap/test` return a structured `{ success, stage, message, code?, details?, userDn? }` (`LdapTestResult`). `stage` is one of `config | connect | service-bind | search | user-bind | ok` so admins can tell exactly where a failed bind broke. The Settings → LDAP panel renders this as a persistent diagnostic card and includes one-click presets: **OpenLDAP** `(uid={{username}})`, **Active Directory (sAMAccountName)** `(&(objectClass=user)(sAMAccountName={{username}}))`, and **Active Directory (UPN)** `(&(objectClass=user)(userPrincipalName={{username}}))`. Server-side, every stage is logged via pino with `{ url, baseDn, usernameMasked, stage, code }` (the username is reduced to a fingerprint, never the password) so the host operator can correlate UI test results with `docker compose logs api`.
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

## First-time setup

There is no default admin password. On first boot the API seeds an `admin`
local user with **no password**, and the web app shows a one-time setup
wizard at `/setup` where the operator picks the password. The wizard
auto-logs them in and disappears for good once setup is done.

For an unattended deployment, set `INITIAL_ADMIN_PASSWORD` (>= 8 chars) in
the API container's environment before the first boot. The seed will
create the admin with that password and skip the wizard.

### Recovering a locked-out install

If an existing deployment was bootstrapped by an older version of this
codebase and the admin password is unknown, set
`RESET_ADMIN_PASSWORD=1` in the API container's environment and restart
the API. The next boot will clear the admin's password and re-enable the
`/setup` wizard. **Remove the variable after you complete setup** — the
seed will keep clearing the password on every restart while the variable
is set.

## Key commands

- `pnpm run typecheck` — typecheck all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks + Zod schemas from OpenAPI
- `pnpm --filter @workspace/db run push` — push DB schema (dev)
- `pnpm --filter @workspace/api-server run dev` — run API locally (port 8080)
- `pnpm --filter @workspace/change-mgmt run dev` — run web frontend locally (port 5000)

## Self-hosting with Docker (80 / 443)

After cloning the repo, the simplest path is just:

```
docker compose up -d --build
```

This works without any pre-bootstrap. The compose file ships with a safe
internal-only default for `POSTGRES_PASSWORD` (the `db` service has no
exposed port — it is only reachable from inside the docker network) and
the api container's entrypoint auto-generates a strong `JWT_SECRET` on
first boot, persisting it to the `api_secrets` named volume so existing
sessions survive `docker compose down`/`up` cycles.

To override either value (recommended for production), create a `.env`
at the repo root and set them explicitly:

```
./scripts/init-env.sh        # generates .env with strong random secrets
# …or copy .env.example to .env and edit by hand, e.g.
#   POSTGRES_PASSWORD=$(openssl rand -hex 24)
#   JWT_SECRET=$(openssl rand -hex 64)
docker compose up -d --build
```

Wrapper for the lazy: `./scripts/up.sh` runs `init-env.sh` (if no `.env`)
then `docker compose up -d --build` and tails the logs.

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
