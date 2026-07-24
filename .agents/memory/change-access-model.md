---
name: Change access & deputy permission model
description: How change read/write authz and CAB-member/deputy visibility work in the ITIL change-mgmt api-server
---

# Change access model (api-server)

Two distinct gates in `src/lib/auth.ts`:
- `getChangeAccess()` — WRITE/mutating gate: admin, owner, assignee, or a GOVERNANCE role (change_manager, ecab_member, cab_chair).
- `getChangeViewAccess()` — READ gate: returns `getChangeAccess()` result OR a CHANGE_VIEWER role (cab_member) OR the `"authenticated"` fallback — change visibility is org-wide by explicit user requirement (every logged-in user can read every change). Never widen this to pentests: pentest routes have their own strict need-to-know gate that must stay separate.
- `isPrivilegedAccess()` — must stay WRITE-only (admin + governance). Never add viewer roles here or CAB members gain lock-override / privileged writes.

**Rule:** change READ endpoints (GET detail, comments, assignees, approvals, attachments, phases planning/testing/preprod/pir) use `getChangeViewAccess`; every mutating path (PATCH/DELETE/transition, POST vote, POST comment, PUT assignees/attachments/phases, signed-off planning lock) uses `getChangeAccess`.

**Why:** CAB members (and their deputies) need to *see* a change under review but must not edit it. Before this split, cab_member was in neither role set, so CAB members/deputies got a 403/empty window on open. Later, users complained that role-less users got empty pages on others' changes — the owner explicitly decided all authenticated users must read all changes (writes stay gated).

## Deputies have NO separate permission model
`loadUserRoles` ignores the `isDeputy` flag on role_assignments, so a deputy resolves to exactly the same role as its primary. Do NOT add deputy-specific authz branches — "give deputies the same perms as primaries" is already true at the role layer; the real gap is always which role_key is granted access, not deputy vs primary. (Voting eligibility in approvals.ts also finds the deputy via role_assignments regardless of isDeputy; the separate `cab_members` table is per-meeting pre-selection only.)

## api-server route test-mock gotchas
Route handlers that notify call `resolveRecipients` from `../lib/notification-routing`; auth test files that don't mock it make POST/creation handlers 500 (this is the cause of several long-standing failing tests, e.g. comments POST). Also mock drizzle `and` (not just `eq`) when a handler builds composite where-clauses, or it throws. When an endpoint's gate changes from getChangeAccess to getChangeViewAccess, the test must mock the *actual* function the handler imports (the real getChangeViewAccess calls the real getChangeAccess, so mocking only getChangeAccess won't control the path).
