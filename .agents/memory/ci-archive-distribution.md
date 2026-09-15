---
name: CI archive distribution
description: Owner-selected alternative to an unavailable internal runner
---

Use GitHub-hosted builds with GHCR `latest` publishing and downloadable image
archives, not direct private Nexus publishing.

**Why:** No internal runner was available; a self-hosted-only workflow stayed
queued. The owner initially chose archives but subsequently explicitly requested
GHCR `latest` on 2026-09-15 to match existing Kubernetes image references.
The owner corrected the earlier naming request: use `change-manager-builder`,
not `change-manager-migrate`, for the builder target.

**How to apply:** Keep Nexus credentials out of hosted builds. Internal
promotion is an operator step; do not assume a private runner or expose Nexus
to make CI work.