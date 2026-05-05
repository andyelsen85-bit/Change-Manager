# IT Change Management

A production-ready, **ITIL v4-aligned IT Change Management** web application.
Self-hostable in a single `docker compose up`, with PostgreSQL, an Express 5
API, a React + Vite SPA, and an Nginx reverse proxy that auto-provisions a
self-signed TLS certificate on first boot.

> Normal / Standard / Emergency change tracks · Role-based approvals with
> deputies · CAB / eCAB calendar with email agendas · Planning, Testing and
> Post-Implementation Review phases · Immutable audit log · Local + LDAP auth ·
> SMTP, LDAP, SSL settings managed in-app · Full-database backup & restore.

---

## Table of contents

- [Screenshots](#screenshots)
- [Feature overview](#feature-overview)
- [Technology stack](#technology-stack)
- [Repository layout](#repository-layout)
- [Quick start (Docker)](#quick-start-docker)
- [First-time setup wizard](#first-time-setup-wizard)
- [Local development](#local-development)
- [Configuration reference](#configuration-reference)
- [Domain model](#domain-model)
- [Change-request state machine](#change-request-state-machine)
- [Roles &amp; permissions](#roles--permissions)
- [Authentication, sessions &amp; CSRF](#authentication-sessions--csrf)
- [LDAP integration](#ldap-integration)
- [Email &amp; ICS notifications](#email--ics-notifications)
- [TLS / SSL](#tls--ssl)
- [Backup &amp; restore](#backup--restore)
- [Audit log](#audit-log)
- [REST API reference](#rest-api-reference)
- [OpenAPI &amp; codegen](#openapi--codegen)
- [Database management](#database-management)
- [Build, test &amp; release](#build-test--release)
- [Project scripts](#project-scripts)
- [Security model &amp; hardening](#security-model--hardening)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Screenshots

The app ships with a light/dark theme, an operations-focused dashboard, a
queue-style changes list, per-change timeline, CAB calendar, and an admin
settings area for SMTP, LDAP, SSL and Backup/Restore.

> Drop screenshots into `docs/screenshots/` and reference them here, e.g.
> `![Dashboard](docs/screenshots/dashboard.png)`.

---

## Feature overview

### Change tracks (ITIL v4)

| Track         | Approval                         | CAB    | Phases                   | Typical use                  |
| ------------- | -------------------------------- | ------ | ------------------------ | ---------------------------- |
| **Normal**    | Change Manager (post-CAB)        | Yes    | Planning · Testing · PIR | Day-to-day production change |
| **Standard**  | Auto-approved via template       | No     | Planning · Testing · PIR | Pre-approved low-risk change |
| **Emergency** | Change Manager + eCAB Member     | eCAB   | Planning · *Testing*\* · PIR | Outage / urgent fix         |

\* Testing is optional on every track — recording a Testing pass is allowed
but not required to reach the Post-Implementation Review phase.

### What you get out of the box

- **Change requests** with ref number, title, description, track, status,
  risk, impact, priority, category, owner, assignee, optional template, planned
  & actual start/end timestamps, full comment thread, and per-phase records.
- **15 seeded Standard templates** that auto-approve and bypass CAB.
- **Approvals** — role-based per track. Normal needs only the Change Manager
  (post-CAB sign-off). Emergency needs Change Manager + an eCAB Member.
  Standard auto-approves. Every governance role supports a **deputy** so
  approvals never block when the primary is out.
- **Change Advisory Board / eCAB** — calendar of meetings, attendee
  management, downloadable ICS invite, "Send agenda" action that emails every
  member the full agenda (meeting metadata + every change on the docket with
  ref/title/track/status/risk/impact/planned start-end/full description), and
  a "New meeting" dialog that defaults attendees to the primary CAB or eCAB
  members depending on meeting kind.
- **Per-change horizontal timeline** on the change detail page (green ✓ for
  completed steps, highlighted current step, muted future steps; cancelled /
  rejected / rolled-back rendered as a red stop-tile).
- **Revert action** — Change Manager / Admin can walk a change BACK to an
  earlier status with an audited reason; reverting past `awaiting_approval`
  resets approvals to `pending`; reverting across `in_progress`/`implemented`
  clears `actualStart`/`actualEnd`. `rolled_back` is the only truly terminal
  status.
- **Notifications** — per-user, per-event email preferences with an admin master-switch on each user account; in-app notifications were removed in v2 of the backup format.
- **Auth** — local users (bcrypt) + LDAP. JWT cookie session with CSRF
  double-submit token. One-time `/setup` wizard for the first admin password.
- **Admin Settings** — SMTP, LDAP (with diagnostics + presets for OpenLDAP /
  AD sAMAccountName / AD UPN), SSL/TLS upload + in-app CSR generation, session
  & lockout timeouts, Backup & Restore.
- **Immutable audit log** — JSONB before/after snapshots, IP + user agent,
  CSV export, DB-level triggers prevent UPDATE / DELETE / TRUNCATE.
- **Backup & Restore** — single-file JSON dump of every table, restored
  inside one transaction with FK-safe ordering and automatic sequence reset.

---

## Technology stack

| Layer            | Choice                                                                  |
| ---------------- | ----------------------------------------------------------------------- |
| Monorepo         | **pnpm workspaces** (`pnpm-workspace.yaml`)                             |
| Language         | **TypeScript 5.9**                                                       |
| Runtime          | **Node.js 24** (Alpine in Docker)                                        |
| API              | **Express 5**, pino logger, jsonwebtoken, bcryptjs, ldapjs, nodemailer, ics |
| Database         | **PostgreSQL 16** + **Drizzle ORM** + drizzle-zod                        |
| Validation       | **Zod** (`zod/v4`)                                                       |
| Frontend         | **React 18**, **Vite 7**, **Tailwind v4**, **shadcn/ui**, TanStack Query, wouter, sonner, framer-motion, **Recharts** |
| API contract     | **OpenAPI 3.1** as single source of truth → generated Zod + React Query hooks |
| Build            | esbuild (API CJS bundle), Vite (frontend static), multi-stage Dockerfile |
| Reverse proxy    | **Nginx** (TLS termination, static SPA, `/api/*` proxy)                  |
| Container orchestration | **docker-compose** (db, migrate, api, web)                        |

---

## Repository layout

```
artifacts/
  api-server/        # Express 5 API (port 8080)
    src/
      app.ts             # express setup, CORS, helmet, csrf, errorHandler
      index.ts           # boot: applyDbConstraints → seed → listen
      seed.ts            # initial roles, templates, admin user
      lib/
        auth.ts          # JWT cookies + requireAuth / requireAdmin
        ldap.ts          # connect, service-bind, search, user-bind, parse
        smtp.ts          # nodemailer transport + templated emails
        state-machine.ts # ChangeTrack / ChangeStatus + transition graphs
        backup.ts        # exportAll / importAll (tx-safe)
        audit.ts         # writes immutable audit_log entries
        secret-crypto.ts # AES-GCM at-rest encryption for SMTP/LDAP secrets
        db-bootstrap.ts  # installs audit_log immutability triggers
      routes/            # all REST endpoints (see API reference below)
  change-mgmt/       # Vite + React frontend (port 5000 in dev)
    src/
      pages/             # Dashboard, ChangesList, ChangeDetail, CabCalendar,
                         # CabDetail, Users, Roles, Templates, Settings,
                         # AuditLog, Notifications, Profile, Login, Setup, …
      components/ui/     # shadcn/ui primitives (cards, tables, dialog, …)
      lib/api.ts         # fetch wrapper with CSRF token + 401/403 handling
  mockup-sandbox/    # internal canvas helper for design exploration
lib/
  db/                # Drizzle schema + drizzle-kit migrations
    src/schema/      # 16 tables across 13 schema files
  api-spec/          # OpenAPI YAML, single source of truth
  api-zod/           # generated Zod schemas + React Query hooks
docker/
  nginx.conf         # SPA + /api proxy + TLS config
  entrypoint-api.sh  # auto-generates JWT_SECRET, runs migrations, starts node
  entrypoint-web.sh  # auto-generates self-signed TLS cert if none supplied
scripts/
  init-env.sh        # generates .env with strong random POSTGRES_PASSWORD + JWT_SECRET
  up.sh              # init-env + docker compose up + tail logs
  post-merge.sh      # post-merge dependency / migration sync
Dockerfile           # multi-stage: builder → api / web
docker-compose.yml   # db + migrate + api + web services
```

---

## Quick start (Docker)

```bash
git clone <this repo>
cd <repo>
docker compose up -d --build
```

This works with no pre-bootstrap: `POSTGRES_PASSWORD` defaults to an
internal-only value (the `db` service has no exposed port — it is only
reachable from inside the docker network) and the API entrypoint
auto-generates a strong `JWT_SECRET` on first boot and persists it to the
`api_secrets` named volume so existing sessions survive restarts.

For production, override secrets explicitly in a `.env` at the repo root:

```bash
./scripts/init-env.sh           # generates .env with strong random secrets
# ... or copy .env.example to .env and edit by hand:
#   POSTGRES_PASSWORD=$(openssl rand -hex 24)
#   JWT_SECRET=$(openssl rand -hex 64)
docker compose up -d --build
```

The lazy wrapper `./scripts/up.sh` runs `init-env.sh` (if no `.env` exists)
then `docker compose up -d --build` and tails the logs.

The compose stack:

1. Starts **Postgres 16** (`db`) — internal-only, no host port mapping.
2. Runs the **migrate** container once → `pnpm --filter @workspace/db run push`.
3. Starts the **api** container on port `8080` (internal only).
4. Starts the **web** container (Nginx) on host ports `80` / `443`.
   - Serves the static React build at `/`.
   - Reverse-proxies `/api/*` to the API.
   - Generates a self-signed TLS cert at `./certs/server.{crt,key}` on first
     boot if you haven't supplied one.

Then open `https://<host>` and you'll be redirected to the **first-time setup
wizard**.

---

## First-time setup wizard

There is **no default admin password**. On first boot the API seeds an
`admin` local user with **no password**, and the web app shows a one-time
setup wizard at `/setup` where the operator picks the password. The wizard
auto-logs them in and disappears for good once setup is done.

For an unattended deployment, set `INITIAL_ADMIN_PASSWORD` (≥ 8 chars) in
the API container's environment before the first boot. The seed will create
the admin with that password and skip the wizard.

### Recovering a locked-out install

If an existing deployment was bootstrapped by an older version of this
codebase and the admin password is unknown, set `RESET_ADMIN_PASSWORD=1` in
the API container's environment and restart the API. The next boot will
clear the admin's password and re-enable the `/setup` wizard.
**Remove the variable after you complete setup** — the seed will keep
clearing the password on every restart while the variable is set.

---

## Local development

You'll need **Node.js 24+**, **pnpm 9+** and a local Postgres (or just point
`DATABASE_URL` at any reachable database).

```bash
pnpm install
export DATABASE_URL=postgresql://user:pass@localhost:5432/change_mgmt
pnpm --filter @workspace/db run push           # apply schema
pnpm --filter @workspace/api-server run dev    # API on :8080
pnpm --filter @workspace/change-mgmt run dev   # web on :5000
```

The Vite dev server proxies `/api/*` to the API automatically, so visiting
`http://localhost:5000` gives you the full app with hot-reload.

> Vite reads stdin and exits on EOF, which makes it look like the workflow
> "didn't open a port" under Replit's workflow runner. The `change-mgmt`
> dev script wraps Vite as `tail -f /dev/null | vite dev` so stdin stays
> open.

---

## Configuration reference

### `.env` (root, consumed by `docker-compose.yml`)

| Variable                | Default                          | Notes                                    |
| ----------------------- | -------------------------------- | ---------------------------------------- |
| `POSTGRES_DB`           | `change_mgmt`                    | Database name                            |
| `POSTGRES_USER`         | `change_mgmt`                    | DB user                                  |
| `POSTGRES_PASSWORD`     | `change_mgmt_internal_only`      | Override in production                   |
| `JWT_SECRET`            | (auto-generated, persisted)      | 64-byte hex recommended                  |
| `LOG_LEVEL`             | `info`                           | pino: `trace`/`debug`/`info`/`warn`/`error`/`fatal` |
| `HTTP_PORT`             | `80`                             | Host port for HTTP                       |
| `HTTPS_PORT`            | `443`                            | Host port for HTTPS                      |
| `DISABLE_TLS`           | `false`                          | `true` disables HTTPS (NOT for prod)     |
| `TLS_HOSTNAME`          | `change-mgmt.local`              | CN of the auto-generated self-signed cert|
| `TLS_SELFSIGNED_DAYS`   | `365`                            | Validity of the self-signed cert         |

### API container environment

| Variable                  | Required | Notes                                             |
| ------------------------- | :------: | ------------------------------------------------- |
| `PORT`                    |   yes    | Listen port (compose sets to `8080`)              |
| `DATABASE_URL`            |   yes    | `postgresql://user:pass@host:5432/db`             |
| `JWT_SECRET`              |   yes    | Auto-generated if empty (entrypoint)              |
| `NODE_ENV`                |          | `development` / `production`                      |
| `LOG_LEVEL`               |          | pino level                                        |
| `INITIAL_ADMIN_PASSWORD`  |          | If set on first boot, skips the setup wizard      |
| `RESET_ADMIN_PASSWORD`    |          | `1` clears admin password & re-enables `/setup`   |
| `APP_ENCRYPTION_KEY`      |          | Optional dedicated key for SMTP/LDAP secret encryption (falls back to `JWT_SECRET`) |

### Frontend (Vite)

| Variable               | Notes                                                        |
| ---------------------- | ------------------------------------------------------------ |
| `VITE_API_BASE_URL`    | Override the API origin. Defaults to current `window.location` so the SPA + reverse-proxy setup works automatically. |

---

## Domain model

The schema lives in [`lib/db/src/schema/`](lib/db/src/schema/) and is the
single source of truth for tables and types. The 16 tables are:

| Table                       | Purpose                                                         |
| --------------------------- | --------------------------------------------------------------- |
| `users`                     | Local + LDAP users; `is_admin`, `must_change_password`, deputy  |
| `roles`                     | Governance role catalogue (`change_manager`, `cab_member`, …)   |
| `role_assignments`          | Many-to-many user ↔ role with deputy linkage                    |
| `change_requests`           | Core change record (track, status, risk, impact, owner, …)     |
| `planning_records`          | One-to-one with change: rollout / rollback plan                 |
| `test_records`              | One-to-one with change: test plan + result                      |
| `pir_records`               | One-to-one with change: post-implementation review              |
| `approvals`                 | Per change × role voting rows                                   |
| `cab_meetings`              | CAB / eCAB scheduled meetings                                   |
| `cab_members`               | Meeting attendee list                                           |
| `cab_changes`               | Many-to-many: which changes are on which meeting docket         |
| `comments`                  | Threaded comments on a change                                   |
| `notification_preferences`  | Per-user, per-event email toggles                               |
| `change_categories`         | Lookup table for the Category dropdown on every change          |
| `change_assignees`          | Per-change override of Tech Reviewer / Implementer / Tester     |
| `standard_templates`        | Pre-approved Standard change templates                          |
| `ref_counters`              | Per-prefix sequence for ref numbers (e.g. `CHG-0001`)           |
| `audit_log`                 | Immutable JSONB before/after snapshots (DB-trigger enforced)    |
| `smtp_settings`             | Singleton SMTP configuration (password encrypted at rest)       |
| `ldap_settings`             | Singleton LDAP configuration (bind password encrypted)          |
| `ssl_settings`              | Stored cert/key + CSR private key                               |
| `workflow_timeouts`         | Reminder / escalation / PIR-window / emergency-window settings  |

---

## Change-request state machine

Every track has its own allowed-transition graph (see
[`artifacts/api-server/src/lib/state-machine.ts`](artifacts/api-server/src/lib/state-machine.ts)).
Transitions are validated server-side on `POST /api/changes/:id/transition`.
Cancelled and rolled_back are reachable from any non-terminal status.

### Normal track

```
draft → submitted → in_review → awaiting_approval → approved → scheduled
   ↓        ↓            ↓               ↓             ↓          ↓
cancelled cancelled  rejected/cancelled rejected/cancelled cancelled  cancelled
                                                                       ↓
                                                                  in_progress
                                                                   ↓        ↓
                                                              implemented  rolled_back
                                                              ↓     ↓
                                                       in_testing  awaiting_pir
                                                              ↓        ↓
                                                       awaiting_pir completed
                                                              ↓
                                                          completed
```

### Standard track (auto-approved, no CAB)

```
draft → scheduled / awaiting_implementation → in_progress → implemented → completed
                                                    ↓             ↓
                                                rolled_back   rolled_back
```

### Emergency track (collapsed flow, eCAB approval mandatory)

```
draft → awaiting_approval → approved → in_progress → implemented → awaiting_pir → completed
                  ↓            ↓            ↓             ↓
              rejected     cancelled    rolled_back   rolled_back
```

### Reverse transitions ("Revert" action)

A separate reverse-transition graph
(`listAllowedReversions(track, from)`) defines the controlled walk-back
paths. `POST /api/changes/:id/revert` requires `change_manager` role or
`isAdmin`, takes `{ toStatus, reason }` (reason ≥ 5 chars), and writes an
audit entry with action `change.reverted`. Side-effects:

- Reverting back past `awaiting_approval` resets every approval row to
  `pending`.
- Reverting back across `in_progress`/`implemented` clears
  `actualStart`/`actualEnd`.

---

## Roles & permissions

| Role key            | Granted abilities                                       |
| ------------------- | ------------------------------------------------------- |
| `admin`             | (cookie flag) Everything, including Settings / Backup   |
| `change_manager`    | Approve Normal/Emergency, revert, manage CAB            |
| `cab_member`        | Vote in Normal CAB approval                             |
| `ecab_member`       | Vote in Emergency CAB approval                          |
| `technical_reviewer`| Technical sign-off on planning                          |
| `business_owner`    | Business sign-off on planning                           |
| `implementer`       | Move change through implementation phase                |
| `tester`            | Record test results                                     |

Every role supports a **deputy** (configured via `role_assignments.deputy_user_id` /
`primary_assignment_id`). The deputy can act on behalf of the primary holder
when the primary hasn't voted, ensuring approvals never deadlock during PTO.

Endpoints requiring `requireAdmin` middleware: all of `/api/settings/*`,
`/api/backup`, `/api/backup/restore`, `/api/role-assignments`, `/api/templates`
(POST/PATCH/DELETE), `/api/users` (POST/PATCH/DELETE), `/api/admin/audit-log`,
`/api/dashboard/activity`.

---

## Authentication, sessions & CSRF

- **Local accounts**: bcrypt-hashed password, `users.password_hash`.
- **LDAP accounts**: `users.source = 'ldap'`, no local password.
- **Sessions**: HMAC-signed JWT in an HttpOnly cookie (`cm_session`).
- **CSRF**: double-submit cookie. The login endpoint sets a non-HttpOnly
  cookie `cm_csrf` plus a matching value the client must echo as
  `X-CSRF-Token` on every state-changing request. Required on every
  POST/PATCH/PUT/DELETE under `/api` except `/api/auth/login`.
  - Cookie is rotated on logout, healed by `GET /api/auth/me`.
  - The frontend `api` client in `artifacts/change-mgmt/src/lib/api.ts`
    reads the cookie and attaches the header automatically; on a 403 with
    "CSRF" in the body it transparently calls `/auth/me` to mint a fresh
    cookie and retries once.
- **Secrets at rest**: SMTP and LDAP bind passwords are encrypted with
  AES-256-GCM in `lib/secret-crypto.ts` using an HKDF-derived key from
  `APP_ENCRYPTION_KEY` (or `JWT_SECRET` as fallback).

### Auth endpoints

| Method | Path                       | Purpose                                  |
| ------ | -------------------------- | ---------------------------------------- |
| POST   | `/api/auth/login`          | Local + LDAP login, sets cookies         |
| POST   | `/api/auth/logout`         | Clears session + CSRF cookies            |
| GET    | `/api/auth/me`             | Current session, mints CSRF cookie       |
| GET    | `/api/auth/setup-status`   | Whether the `/setup` wizard should show  |
| POST   | `/api/auth/setup`          | First-run admin password set + auto-login|
| POST   | `/api/auth/change-password`| Self-service password change             |

---

## LDAP integration

Configured via Settings → LDAP and stored in `ldap_settings`. The same code
path runs both **user authentication** (`authenticateLdap`, called from
`/api/auth/login`) and **user lookup** (`lookupLdapUser`, called from
`POST /api/users/ldap-lookup` and during admin user creation when
`source=ldap`).

Lifecycle:

1. **connect** → ldapjs client (`ldap://` or `ldaps://`).
2. **service-bind** → bind as the service account from settings.
3. **search** → `cfg.userFilter` (with `{{username}}` placeholder) under
   `cfg.baseDn`.
4. **user-bind** → bind as the resolved DN with the user's password
   (skipped for lookup).
5. **ok** → return `{success, stage, message, userDn}`.

Each stage is logged via pino with `{ url, baseDn, usernameMasked, stage, code }`
(usernames are reduced to a fingerprint, never the password). The
**LDAP test** endpoint (`POST /api/settings/ldap/test`) returns the same
structured `LdapTestResult` so admins can pinpoint exactly where a failed
bind broke.

### Attribute mapping

`parseLdapEntry()` handles both ldapjs v3+ (`entry.pojo.attributes` array of
`{type, values}`) and the legacy v2 flat `entry.object` shape. `pickAttr()`
does case-insensitive lookup with sensible AD fallbacks:

- `displayName` → `cn` → `name` → `givenName + sn`
- `mail` → `userPrincipalName`
- `sAMAccountName` → `uid`

### Presets

The Settings → LDAP panel ships with one-click presets:

- **OpenLDAP**: `(uid={{username}})`
- **Active Directory (sAMAccountName)**: `(&(objectClass=user)(sAMAccountName={{username}}))`
- **Active Directory (UPN)**: `(&(objectClass=user)(userPrincipalName={{username}}))`

### TLS verification

`tlsRejectUnauthorized` (defaults ON) is honoured for both `ldaps://` and
StartTLS via `tlsOptions.rejectUnauthorized` in `lib/ldap.ts`. Turn it OFF
for self-signed AD certs, internal CAs Node doesn't trust, or hostname
mismatches (e.g. connecting by IP).

---

## Email & ICS notifications

- Configured via Settings → SMTP, stored in `smtp_settings`.
- Templated emails for: approval requested, approval reminder, approval
  escalation, change implemented, PIR due, CAB invitation, CAB agenda.
- The CAB **Send agenda** action emails every member the meeting metadata
  plus a per-change block (ref/title/track/status/risk/impact/planned
  start-end/full description) so members can review before the meeting.
- `GET /api/cab-meetings/:id/ics` returns a downloadable ICS calendar
  invite — members import it into their own calendar.
- `POST /api/settings/smtp/test` sends a test email to verify the
  configuration end-to-end.

Per-user notification preferences (`/api/users/:id/notification-preferences`)
let each user opt in/out of every event over email. Admins can additionally
flip an account-wide **Receives email notifications** master-switch from the
Users page — when off, the user is excluded from every notification regardless
of per-event preferences.

**New events introduced in v2:** `change.submitted`, `change.scheduled`,
`change.completed`, `change.assignee_changed`. Per-change assignees
(Technical Reviewer / Implementer / Tester) take precedence over the global
role pool when routing email; if no per-change override is set, the role pool
is used as a fallback.

**Pre-prod testing phase (Normal track):** when a change is created with
`hasPreprodEnv=true`, the lifecycle inserts an `in_preprod_testing` step
between `approved` and `scheduled`. Teams without a pre-prod environment
skip directly from `approved` to `scheduled` as before.

**Meeting-gated approvals (Normal track):** CAB approvals for Normal-track
changes can only be cast while the parent meeting is `in_progress` (started
via the **Process meeting** button on the meeting page) or already
`completed`. The Process Meeting panel embeds per-change Approve / Decline
controls so reviewers vote without leaving the meeting page.

**Categories:** managed under Settings → Categories. Each change picks a
category from this list. Deleting an in-use category soft-deactivates it
to preserve historical labels.

**SMTP / LDAP CA-cert anchors:** both relay configs accept an optional
PEM-encoded CA chain (and an LDAP issuer chain) appended to the Node trust
store at runtime, so internal CAs can be honoured without disabling TLS
verification. SMTP additionally exposes a **Skip TLS verification** toggle
for legacy relays.

---

## TLS / SSL

The `web` container's entrypoint generates a self-signed cert at
`./certs/server.{crt,key}` on first boot if none is supplied.

You have three ways to provide your own certificate:

1. **Drop it into `./certs/`** before starting the stack:
   `./certs/server.crt` + `./certs/server.key`. Picked up automatically.
2. **Upload via Settings → SSL/TLS** in the admin UI. Stored in
   `ssl_settings`; the entrypoint reuses whatever it finds in
   `/etc/nginx/certs` on next restart.
3. **Generate a CSR in-app** via Settings → SSL → "Generate CSR":
   `POST /api/settings/ssl/csr` — RSA 2048/3072/4096, DNS+IP SANs, key usage
   / extKeyUsage server-auth. The private key is persisted server-side
   until you upload the signed cert.

`DISABLE_TLS=true` in `.env` disables HTTPS entirely (HTTP only — not
recommended for production).

---

## Backup & restore

Settings → **Backup & Restore** tab (admin-only).

### Export

`GET /api/backup` returns a single JSON file containing every table in the
database (users, roles, change requests, approvals, CAB meetings, comments,
audit log, **and** all system settings including encrypted SMTP/LDAP
secrets). The export reads inside one
`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` transaction so the
snapshot is logically consistent across tables even under heavy concurrent
writes.

The download is gated by:

1. `requireAdmin` middleware (admin-only).
2. `requireSameOrigin` middleware that rejects any request whose `Origin`
   header doesn't match the `Host` — defence-in-depth against credentialed
   cross-origin reads given the global permissive CORS policy.

### Restore

`POST /api/backup/restore` (200 MB body limit) accepts the JSON payload from
a prior export and runs the entire wipe + reimport in **one transaction**:

1. Validate payload shape (version + every expected table present).
2. Temporarily `ALTER TABLE audit_log DISABLE TRIGGER USER` so the
   immutability triggers don't block the wipe.
3. `DELETE FROM` every table in **reverse FK order**.
4. `INSERT INTO` every table in **dependency order**.
5. Discover every serial / identity column via `pg_catalog` and reset each
   sequence with `setval(pg_get_serial_sequence(...), MAX(id) + 1, false)`
   so future inserts can't collide with imported ids.
6. Re-enable the audit triggers and `COMMIT`.

If anything fails, the transaction is rolled back and the audit triggers are
re-enabled in `finally`. The restore action itself is recorded in the
audit log of the freshly-restored dataset.

UI requires the admin to type **`RESTORE`** before the destructive action
runs and reloads the page on success so cached queries / auth pick up the
restored data.

---

## Audit log

- Append-only `audit_log` table.
- DB-level triggers (`audit_log_no_update`, `audit_log_no_delete`,
  `audit_log_no_truncate`) installed by `applyDbConstraints()` on boot
  RAISE EXCEPTION on any modification — the API hard-fails to start if the
  triggers can't be installed (so the application can never run without
  them).
- Captures: actor (uid + display name), action key, entity type + id,
  human-readable summary, JSONB before/after snapshots, IP address, user
  agent, timestamp.
- Logged actions include all change transitions, reverts, approvals,
  user/role/template CRUD, login/logout, password changes, settings updates,
  and `backup.export` / `backup.restore`.
- `GET /api/admin/audit-log` lists with filters; `GET /api/admin/audit-log/export`
  returns CSV.

---

## REST API reference

All endpoints live under `/api`. Auth is cookie-based; mutations require the
`X-CSRF-Token` header (see [CSRF](#authentication-sessions--csrf)).

### Health

- `GET /api/health` · `GET /api/healthz` — liveness probe (no auth).

### Auth

- `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me`
- `GET /api/auth/setup-status` · `POST /api/auth/setup`
- `POST /api/auth/change-password`

### Users

- `GET /api/users` (auth) — supports `?role=<key>&primary=1` filters.
- `POST /api/users/ldap-lookup` (admin) — preview AD/LDAP attributes.
- `POST /api/users` (admin) — create local or LDAP-sourced user.
- `GET /api/users/:id` (auth)
- `PATCH /api/users/me` (auth) · `PATCH /api/users/:id` (admin)
- `DELETE /api/users/:id` (admin)
- `GET /api/users/:id/notification-preferences` (auth)
- `PUT /api/users/:id/notification-preferences` (auth, self or admin)

### Roles

- `GET /api/roles` (auth)
- `GET /api/role-assignments` (admin)
- `POST /api/role-assignments` · `DELETE /api/role-assignments/:id` (admin)

### Templates (Standard changes)

- `GET /api/templates` (auth)
- `POST /api/templates` (admin) · `PATCH /api/templates/:id` · `DELETE`
- `GET /api/templates/:id` (auth)

### Changes

- `GET /api/changes` (auth) — filters: `status` (incl. virtual `active`),
  `track`, `mine`, `q`.
- `POST /api/changes` (auth)
- `GET /api/changes/:id` (auth)
- `PATCH /api/changes/:id` (auth, owner / change_manager / admin)
- `DELETE /api/changes/:id` (admin)
- `POST /api/changes/:id/transition` — apply allowed forward transition.
- `POST /api/changes/:id/revert` — controlled walk-back (change_manager / admin).

### Phases

- `GET/PUT /api/changes/:id/planning`
- `GET/PUT /api/changes/:id/testing`
- `GET/PUT /api/changes/:id/pir`

### Approvals

- `GET /api/changes/:id/approvals`
- `POST /api/approvals/:id/vote` — body `{ decision, comment }`.

### Comments

- `GET /api/changes/:id/comments`
- `POST /api/changes/:id/comments`

### CAB / eCAB meetings

- `GET /api/cab-meetings` (auth) — calendar view.
- `POST /api/cab-meetings` (cab_manager / admin)
- `GET /api/cab-meetings/:id` · `PATCH /api/cab-meetings/:id` · `DELETE`
- `GET /api/cab-meetings/:id/ics` — ICS download.
- `POST /api/cab-meetings/:id/send-agenda` — emails every attendee.

### Dashboard

- `GET /api/dashboard/summary` — KPI tiles + chart data.
- `GET /api/dashboard/upcoming-cab` — next CAB meetings.
- `GET /api/dashboard/my-tasks` — current user's open work.
- `GET /api/dashboard/activity` (admin) — recent audit events.

### Settings (admin-only)

- `GET/PUT /api/settings/smtp` · `POST /api/settings/smtp/test`
- `GET/PUT /api/settings/ldap` · `POST /api/settings/ldap/test`
- `GET/PUT /api/settings/ssl` · `POST /api/settings/ssl/csr`
- `GET/PUT /api/settings/workflow-timeouts`

### Audit (admin-only)

- `GET /api/admin/audit-log` — filtered list.
- `GET /api/admin/audit-log/export` — CSV download.

### Backup & Restore (admin-only, same-origin enforced)

- `GET /api/backup` — full-database JSON export.
- `POST /api/backup/restore` — full-database wipe + reimport.

---

## OpenAPI & codegen

The OpenAPI 3.1 spec at [`lib/api-spec/`](lib/api-spec/) is the **single
source of truth** for the API contract. Two generated packages flow from it:

- **`@workspace/api-zod`** — Zod schemas for request / response validation.
- **`@workspace/api-zod` (hooks)** — typed React Query hooks consumed by the
  frontend.

Regenerate after editing the spec:

```bash
pnpm --filter @workspace/api-spec run codegen
```

---

## Database management

Drizzle Kit lives in `lib/db/`. Schema changes flow:

```bash
# Edit lib/db/src/schema/<file>.ts
pnpm --filter @workspace/db run push      # dev: push directly to DB
pnpm --filter @workspace/db run generate  # generate SQL migration files
```

The `migrate` service in `docker-compose.yml` runs `pnpm --filter
@workspace/db run push` against the production DB on every `up`.

In addition to the Drizzle schema, `applyDbConstraints()`
([`lib/db-bootstrap.ts`](artifacts/api-server/src/lib/db-bootstrap.ts))
installs PL/pgSQL triggers that enforce `audit_log` immutability. The API
**refuses to start** if these can't be installed — running without them
silently weakens forensic integrity.

---

## Build, test & release

```bash
pnpm install
pnpm run typecheck            # typecheck everything (libs + apps)
pnpm -r --if-present run test # run all package tests
pnpm run build                # typecheck + build every package
```

Per-package builds:

```bash
pnpm --filter @workspace/api-server run build   # esbuild → dist/index.mjs
pnpm --filter @workspace/change-mgmt run build  # vite build → dist/
```

The multi-stage `Dockerfile` produces:

- `builder` — pnpm install + typecheck + build for both API and frontend.
- `api` — Node 24 Alpine + the API bundle + entrypoint.
- `web` — Nginx Alpine + the static frontend + entrypoint.

---

## Project scripts

| Script                       | Purpose                                                        |
| ---------------------------- | -------------------------------------------------------------- |
| `scripts/init-env.sh`        | Generate `.env` with strong random `POSTGRES_PASSWORD` + `JWT_SECRET` |
| `scripts/up.sh`              | `init-env` (if needed) + `docker compose up -d --build` + tail |
| `scripts/post-merge.sh`      | Post-merge dependency / migration sync helper                  |

Top-level pnpm scripts:

| Command                           | Purpose                              |
| --------------------------------- | ------------------------------------ |
| `pnpm run typecheck`              | Typecheck all packages               |
| `pnpm run build`                  | Typecheck + build every package      |
| `pnpm run test`                   | Run all package tests                |

---

## Security model & hardening

- **No default admin password** — first-run wizard forces the operator to
  set one.
- **Secrets at rest** — SMTP and LDAP bind passwords are encrypted with
  AES-256-GCM (`secret-crypto.ts`) using a key derived from
  `APP_ENCRYPTION_KEY` (or `JWT_SECRET`).
- **Session cookie** — HttpOnly, Secure (in production), SameSite=Lax,
  HMAC-signed JWT.
- **CSRF** — double-submit cookie required on every mutating `/api`
  request except `POST /api/auth/login`.
- **Backup endpoints** — admin-only **and** Origin must equal Host
  (defence-in-depth against credentialed cross-origin reads given the
  global permissive CORS policy used by the SPA).
- **Audit log** — DB-level triggers prevent UPDATE / DELETE / TRUNCATE.
- **Postgres** — internal-only by default in compose (no `ports:` mapping).
- **TLS by default** — Nginx auto-generates a self-signed cert on first
  boot; drop in your real cert at `./certs/server.{crt,key}` or upload via
  the UI.

Recommended for production:

1. Set strong `POSTGRES_PASSWORD` and `JWT_SECRET` (or let `init-env.sh`
   generate them).
2. Set `APP_ENCRYPTION_KEY` to a dedicated key independent of `JWT_SECRET`
   so rotating session secrets doesn't invalidate stored SMTP/LDAP secrets.
3. Replace the self-signed cert with a real one (file drop or in-app
   upload).
4. Take regular backups via `GET /api/backup` (cron + a service-account
   admin) and store them off-host.

---

## Troubleshooting

**Web container shows "preview unavailable" / `502 Bad Gateway`** — Check
that the API container is healthy: `docker compose logs api`. The web
container reverse-proxies `/api/*` to it.

**`/setup` keeps appearing after I set a password** — `RESET_ADMIN_PASSWORD=1`
is still set in the environment. Remove it from `.env` and restart the API.

**LDAP login works but the user's full name shows as their username** — The
search bind succeeded but the directory didn't return any of the expected
name attributes. Open Settings → LDAP, run **Test bind** with the same
username, and check the `attrs` log line in `docker compose logs api` for
the names your directory actually returns. Set `nameAttr` / `emailAttr` to
match.

**`audit_log is append-only` exception during restore** — Should never
happen via the UI; the restore route disables the triggers inside its
transaction. If you see this from a script, you're trying to UPDATE / DELETE
audit rows directly — the triggers are intentional and there is no
maintenance bypass.

**Backup restore fails with `Backup payload missing rows array for table 'X'`**
— You're trying to restore a backup taken from a different schema version.
The backup format embeds a version field; bump the version + add a
migration step in `lib/backup.ts` if you change the schema.

**Browser shows "Invalid or missing CSRF token" once after a long absence**
— The frontend's `api` client transparently calls `/auth/me` to mint a new
CSRF cookie and retries. If it persists, hard-refresh the page.

---

## License

MIT — see [`LICENSE`](LICENSE).
