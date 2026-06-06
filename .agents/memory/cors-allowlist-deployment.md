---
name: API CORS — same-origin matching for self-hosted/aliased deployments
description: How the api-server decides credentialed CORS, why it matches Origin against inbound Host, and what must never change
---

# API CORS allows same-origin by Origin-vs-Host match (no hardcoded domains)

The api-server uses a per-request CORS delegate (`cors(corsOptionsDelegate)` in
artifacts/api-server/src/app.ts), NOT a static origin list. A request is allowed
when EITHER:
- it is genuinely same-origin: `new URL(Origin).host` equals the inbound host
  (`X-Forwarded-Host`, falling back to `Host`), OR
- its Origin is in the explicit allowlist built from `ALLOWED_ORIGINS` +
  `REPLIT_DOMAINS` (+ localhost in dev).
Otherwise no `Access-Control-Allow-Origin` is emitted (browser blocks the read).
`origin: true` (reflect ANY origin) is forbidden — the only truly unsafe setting.

**Why this exists (do not regress):**
- The app is deployed on customer infrastructure with MANY domain aliases
  (test/prod, internal `.lan` domains). `REPLIT_DOMAINS` is empty there, so a
  static allowlist cannot know the serving domain and cannot be hardcoded.
- Frontend (change-mgmt) reaches the API on the SAME host via `/api` path
  routing, so frontend↔API is same-origin. BUT browsers still send an `Origin`
  header on same-origin MUTATING requests (POST/PUT/PATCH/DELETE), so a static
  allowlist rejects logins/saves/edits with "CORS: origin '…' is not allowed"
  even though they are not cross-site. Matching Origin host == inbound host fixes
  every alias automatically.
- Production must NOT crash when no allowlist is configured: an empty allowlist
  is the most locked-down state (denies all cross-origin), not an open one — log
  a warning, never throw.

**Security rationale:** a cross-site attacker's browser sends its own Origin
(evil.example) while the inbound Host still resolves to THIS API, so origin !=
host → denied. Host/X-Forwarded-Host are set by the browser/edge for
browser-mediated requests and are not attacker-controllable in that context.

**How to apply:** Keep the same-origin (Origin-vs-Host) branch. Don't reintroduce
a hard requirement for a manually-set CORS env var, don't throw on empty
allowlist, and never switch to `origin: true`. `app.set("trust proxy", true)` is
required so forwarded headers/scheme are honored.
