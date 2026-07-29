---
name: pnpm lockfile drizzle split
description: pnpm add/remove in a subpackage can split drizzle-orm into two peer-resolved instances, breaking typecheck monorepo-wide
---

Running `pnpm add`/`pnpm remove` inside one workspace package (e.g. temporarily installing playwright-core in the api-server) can rewrite pnpm-lock.yaml so `drizzle-orm@0.45.2` resolves twice: once plain and once as `drizzle-orm@0.45.2(@types/pg)(pg)`. TypeScript then fails everywhere with "Types have separate declarations of a private property 'shouldInlineParams'".

**Why:** autoInstallPeers is false; re-resolving one importer can drop the pg-peer variant for it while lib/db keeps the peered one, giving two type-incompatible drizzle instances.

**How to apply:** if this error appears after a temporary dep install/removal, run `git checkout pnpm-lock.yaml && pnpm install` (assuming the lockfile previously typechecked), then re-run typecheck. Don't try to fix the code — it's a dependency-graph artifact.
