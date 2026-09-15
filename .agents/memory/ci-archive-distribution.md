---
name: CI archive distribution
description: Owner-selected alternative to an unavailable internal runner
---

Use GitHub-hosted builds with downloadable image archives, not direct private
Nexus publishing or GHCR, unless the owner changes the distribution decision.

**Why:** No internal runner was available; a self-hosted-only workflow stayed
queued. The owner explicitly chose downloadable archives over GHCR and private
network connectivity on 2026-09-15.

**How to apply:** Keep Nexus credentials out of hosted builds. Internal
promotion is an operator step; do not assume a private runner or expose Nexus
to make CI work.