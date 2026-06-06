# Threat Model

## Project Overview

This project is an ITIL-aligned IT change-management platform delivered as a pnpm monorepo with an Express 5 API (`artifacts/api-server`), a React/Vite web client (`artifacts/change-mgmt`), and a PostgreSQL database (`lib/db`). It manages sensitive operational records such as change requests, approvals, comments, attachments, CAB meetings, user accounts, notification settings, audit history, and confidential penetration-test engagements.

Production security analysis should focus on the API server and browser client. `artifacts/mockup-sandbox/` is a development-only canvas helper and should be ignored unless production reachability is demonstrated.

The app supports self-hosted/public deployments in addition to Replit development previews. For scanning purposes, assume production traffic is internet-reachable unless deployment visibility is explicitly private/password-protected. TLS termination is handled by the platform or fronting proxy; this threat model focuses on application-layer controls.

## Assets

- **User accounts and session state** — local passwords, LDAP-backed identities, JWT session cookies, CSRF tokens, admin status, and role assignments. Compromise enables impersonation and privilege escalation.
- **Change-management records** — change descriptions, timelines, implementation plans, rollback plans, testing results, PIR notes, assignees, comments, and attachments. These records can reveal internal systems, maintenance windows, and operational weaknesses.
- **Administrative datasets** — backup exports, audit logs, notification-routing rules, SMTP/LDAP/SSL settings metadata, and workflow settings. Exposure can reveal internal infrastructure and sensitive org metadata; restore actions are integrity-critical.
- **Confidential pentest data** — pentest requests, findings summaries, remediation actions, collaborators, and attachments. These are explicitly treated as TopSecret/need-to-know data.
- **Application secrets** — JWT signing material plus encrypted SMTP/LDAP secrets and any environment-provided bootstrap credentials. Disclosure can compromise authentication or external integrations.

## Trust Boundaries

- **Browser to API** — every request from `artifacts/change-mgmt` crosses into the Express API. The browser is untrusted; the API must enforce authentication, authorization, and cross-origin protections itself.
- **API to PostgreSQL** — the API has broad database access. Query scoping and authorization checks at the API layer are therefore security-critical.
- **Public to authenticated** — login, health, and first-run setup status are publicly reachable; most application data should require a valid session.
- **Authenticated to admin** — settings, backups, full user directory management, and audit endpoints must remain admin-only.
- **Authenticated to governance / need-to-know roles** — change visibility is narrower than generic login for some records, and pentest data is more sensitive still, requiring explicit collaborator or `pentest_mgmt` access.
- **Production to dev-only tooling** — mockup sandbox and development workflows are out of production scope unless separately exposed.

## Scan Anchors

- Production entry points: `artifacts/api-server/src/app.ts`, `artifacts/api-server/src/index.ts`, `artifacts/api-server/src/routes/*.ts`
- Highest-risk areas: auth/bootstrap (`lib/auth.ts`, `routes/auth.ts`, `seed.ts`), global middleware/CORS, change access control (`routes/changes.ts`, `comments.ts`, `phases.ts`, `approvals.ts`, `attachments.ts`), admin exports/settings (`routes/backup.ts`, `settings.ts`, `audit.ts`), and pentest confidentiality (`routes/pentest.ts`)
- Public surfaces: `/api/health`, `/api/auth/login`, `/api/auth/setup-status`, `/api/auth/setup` during uninitialized bootstrap
- Authenticated surfaces: most `/api/**` routes
- Admin surfaces: `/api/settings/**`, `/api/backup*`, `/api/admin/audit-log*`, parts of `/api/users`, notification routing updates
- Dev-only areas to usually ignore: `artifacts/mockup-sandbox/**`

## Accepted Risk and Scope Notes

- The operator has explicitly accepted the risk of the public first-run bootstrap flow. Future scans should not repropose the initial `/api/auth/setup` admin-claim behavior unless deployment assumptions change, the setup window becomes persistent rather than first-run/recovery-only, or new evidence shows the instance is exposed before trusted setup completes.
- The operator has also clarified that authenticated users are intentionally allowed to view organization-wide change-management and CAB data. Future scans should therefore treat broad authenticated visibility of standard change/CAB records as in-scope product behavior unless a route exposes data that is documented as need-to-know, conflicts with this policy, or leaks a more sensitive class such as pentest or admin-only records.

## Threat Categories

### Spoofing

The application relies on JWT cookies for session identity and optional LDAP authentication for some users. The API must verify the session cookie on every protected request and reject tampered tokens. The current first-run bootstrap flow is an accepted deployment-time risk rather than an automatically re-reportable vulnerability under this threat model; revisit it only if the deployment model or reset behavior changes.

### Tampering

Authenticated users can mutate change records, approvals, attachments, settings, and backups. The API must enforce server-side role and object-level authorization on every write path, including status transitions and destructive admin actions. Backup restore and settings updates are especially sensitive because they can overwrite system-wide state.

### Information Disclosure

This application stores detailed operational and security data. Standard change-management and CAB records are currently treated by the operator as visible to any authenticated user, while pentest and admin datasets remain need-to-know. Cross-origin browser protections still matter because the app uses cookie auth; authenticated GET responses, downloads, audit logs, backups, settings metadata, and any protected records must not be readable from attacker-controlled origins.

### Denial of Service

Public or low-privilege endpoints such as login, setup status, large JSON uploads, attachments, and backup restore can consume CPU, memory, or database capacity. The production system should bound payload sizes and avoid exposing expensive operations to unauthenticated callers. Missing rate limits are most relevant on authentication/bootstrap surfaces because they can amplify brute-force or resource exhaustion attacks.

### Elevation of Privilege

The project has multiple privilege tiers: anonymous, authenticated, governance roles, admin, and pentest-specific need-to-know access. The API must enforce these boundaries consistently for admin and pentest actions, and for any data classes the product treats as restricted. The current first-run administrator bootstrap path is an accepted deployment-time exception under this threat model and should only be revisited when deployment assumptions materially change.