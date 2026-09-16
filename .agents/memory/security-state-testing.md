---
name: Security state transition testing
description: Why authentication state machines need real PostgreSQL transition tests, not only mocked SQL assertions
---

Use real, isolated PostgreSQL state-transition tests for authentication
throttling and revocation. Mocked query assertions are useful for contracts
but cannot establish that SQL transitions have the intended security behavior.

**Why:** Review repeatedly found that plausible atomic UPSERTs passed mock
tests while preventing lockout recovery, erasing aggregate protection after a
successful login, or making progressive stages unreachable. A database-backed
session migration also changes the security meaning of numeric user IDs during
backup restore.

**How to apply:** Test active-lock stability, the first retry after expiry,
success cleanup, multiple lock cycles, aggregate-window rollover and concurrent
admission with scoped temporary keys. Treat backup restore and password reset
as session-revocation events, including logins already in flight. Never run a
restore against the shared development dataset merely to test these rules.

Ephemeral authentication state must survive routine upgrades even when it is
deliberately excluded from backups.

**Why:** Backup restoration is an intentional revocation boundary; an ordinary
schema push is not. Treating bootstrap-owned tables as obsolete can erase
active sessions and lockout state during deployment.

**How to apply:** Keep migration ownership separate from backup policy. Protect
bootstrap-managed tables from schema reconciliation, but do not exempt
schema-managed OIDC tables merely because their rows are excluded from backups.