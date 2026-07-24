---
name: CAB recurrence timezone handling
description: How recurring CAB meeting occurrences preserve wall-clock time across DST
---

Recurring CAB meeting creation preserves the creator's *wall-clock* time across DST transitions.

**Rule:** the frontend sends the creator's IANA `timeZone` (Intl.resolvedOptions) with the create payload; the server steps an **unadjusted** base sequence (`first + k*step` in ms) and shifts each candidate by the UTC-offset delta between the first occurrence and the candidate (`tzOffsetMs` via Intl.formatToParts). The `recurrenceUntil` inclusive cutoff is end-of-day in that timezone, not UTC. Unknown timezones are rejected with 400 (no silent fallback).

**Why:** naive "+N weeks in milliseconds" drifts ±1h when summer/winter time flips; and adjusting relative to the *previous already-corrected* occurrence applies the delta twice (bug found in first attempt) — always adjust each candidate against the first occurrence from the raw sequence.

**How to apply:** any future recurrence/scheduling feature (reminders, series edits, freeze windows) should reuse the same pattern; don't add ms-based week arithmetic on stored UTC timestamps for user-facing schedules.
