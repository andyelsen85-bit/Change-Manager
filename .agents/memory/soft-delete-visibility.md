---
name: Soft-delete visibility gate
description: Rules for keeping recycle-binned changes invisible and race-safe across all API routes
---

Changes use soft delete (`deleted_at`/`deleted_by_id` on change_requests) with an admin-only recycle bin.

**Rule:** Any route that loads a change row — including subresource routes (approvals, votes, comments, attachments, assignees, phases/planning/testing/PIR, discussion read/unread) and dashboard joins (my-tasks pending-approval innerJoin, owner/assignee queries) — must treat `deletedAt != null` as 404/excluded. New routes must add the same guard.

**Why:** An architect review found deleted changes remained reachable/mutable through every subresource endpoint and leaked into /dashboard/my-tasks even after the main list/get routes were filtered — the gate does not compose automatically.

**How to apply:** At each `db.select().from(changeRequestsTable)` lookup, extend `if (!chg)` to `if (!chg || chg.deletedAt)`; in joins add `isNull(changeRequestsTable.deletedAt)`. Restore and empty-bin purge must use conditional writes (`... AND deleted_at IS NOT NULL`) so a concurrent restore/purge cannot clobber each other. Audit log is never purged.
