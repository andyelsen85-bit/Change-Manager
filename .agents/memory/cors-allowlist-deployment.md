---
name: API CORS allowlist & production deployment
description: How the api-server builds its credentialed-CORS allowlist and why it must not require a hand-set env var
---

# API CORS allowlist is self-configuring from REPLIT_DOMAINS

The api-server uses a strict credentialed-CORS allowlist (never `origin: true`,
which would let any site read authenticated responses with
`fetch(..., { credentials: "include" })`).

**The allowlist is built from, in order:** `ALLOWED_ORIGINS` (optional explicit
comma-separated override) + `REPLIT_DOMAINS` (platform-provided serving
hostnames, turned into `https://<host>` origins) + localhost dev ports (dev only).
Production refuses to start only if the resulting set is empty.

**Why:** An earlier security fix hard-required `ALLOWED_ORIGINS` and threw at
startup in production if it was unset — this crashed the autoscale deployment
because nobody had set it. Deriving from `REPLIT_DOMAINS` makes the deployment
self-configuring while preserving the strict (non-open) allowlist.

**How to apply:** Don't reintroduce a hard requirement for a manually-set CORS
env var. In this app the frontend (change-mgmt) and api-server are served on the
SAME deployed origin via path routing (`/api`), so frontend→API calls are
same-origin in production; CORS mainly guards against third-party origins. Keep
`REPLIT_DOMAINS` as the automatic source of the app's own origin.
