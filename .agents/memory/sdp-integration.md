---
name: ServiceDesk Plus integration decisions
description: Design decisions and constraints for the SD+ (on-prem) integration in Change-it
---

- SD+ is **on-premises**: auth is a static `technician_key` header against REST API v3; body is form-encoded `input_data` JSON. Status names used on tickets: only **Resolved** and **Rejected** (no Closed), per user requirement.
- Inbound flow is **manual**: a technician clicks a "Create Change" custom trigger in SD+ which POSTs to `/api/integrations/sdp/create-change`, authenticated by a shared secret in the `X-Webhook-Secret` header only (never query param — leaks into proxy logs).
- **Why header-only + timing-safe compare + CSRF exemption:** server-to-server webhook has no session; any new webhook path must be added to `CSRF_EXEMPT_POST_PATHS` in api-server `app.ts` or it 403s.
- Idempotency is guaranteed by a **partial unique index** on `change_requests.sdp_request_id WHERE deleted_at IS NULL`, with insert-conflict fallback returning the winner. Read-then-insert alone loses concurrent-delivery races (architect finding).
- Terminal write-back fires from TWO places: the transition endpoint (completed/rejected) AND the approvals auto-flip to rejected. Any new path that sets a terminal status must also call `sdpSyncTerminalState` (fire-and-forget, audited as `integration.sdp_synced`/`_sync_failed`).
- Resolution text pushed to SD+ = milestone timeline built from `audit_log` rows (change.created/transitioned/reverted, approval.voted) + rejection note.
- `audit_log` is append-only (DB trigger blocks DELETE/UPDATE) — cleanup scripts must not touch it and multi-statement psql commands touching it roll back everything.
- TLS to internal SD+: `tlsRejectUnauthorized` toggle implemented via undici Agent dispatcher; undici v8 types clash with global fetch types — build init as `Record<string, unknown>` and cast at the fetch call.
