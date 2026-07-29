---
name: Potential Standard Change promotion
description: Rules for the trial-template promotion workflow (potentialTemplateId, threshold, CAB flags)
---

Rule: promotion counting for "Potential Standard Change" templates must only count changes that are **track='normal' AND status='completed' AND not soft-deleted**. Links (`potentialTemplateId`) may only point at **disabled** templates; track switches away from normal must clear the link.

**Why:** architect review caught that counting without the track filter lets a change switched to standard/emergency (while still linked) inflate counts and prematurely flag templates as promotion-ready in the CAB agenda/PDF.

**How to apply:** any new surface that computes or displays promotion progress should go through the shared promotion helper (single source of truth for count semantics) rather than ad-hoc SQL; flag surfaces are: change detail header, CAB meeting docket, CAB agenda PDF per-change callout, Templates page counters. Global threshold lives in `template_settings` (key='global'), writable by admin/change_manager only.
