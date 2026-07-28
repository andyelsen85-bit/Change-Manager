---
name: CAB outcomes & attendance
description: Design rules for CAB meeting outcomes, postpone flow, attendance, and results PDF/email.
---

- Only `postponed` is stored explicitly on `cab_changes.outcome`; approved/rejected are **derived at read time** from the approvals table (results PDF and UI must never contradict recorded votes).
- **Why:** avoids a second source of truth that drifts from votes.
- Postpone is an upsert on the target meeting that resets `outcome/outcome_note/postponed_to_meeting_id` to null — a change postponed back and forth must show as active on the target, not stale-postponed.
- Meeting PATCH must **diff** `cab_changes` (never delete-all + reinsert) or outcome columns get wiped; a changeIds-only PATCH carries no column updates, so skip the empty UPDATE (drizzle throws "No values to set").
- Attendance GET merges role-holders (cab_member/cab_chair; ecab_member for eCAB) with stored rows; stored present/absent wins. PUT replaces wholesale. Externals are unique by lowercase email.
- Results email on complete: `notify()` dedups by userId only, so externals get synthetic **negative** userIds (skips `userWantsEmail` pref check via `userId > 0` guard) and recipients must be pre-deduped by normalized email. Mail failure must never block meeting completion.
- Abstain was removed as a voting option (vote route accepts approved/rejected only); historical abstain rows stay readable — the read/display enum in openapi keeps `abstain`, only the vote-request enum dropped it.
