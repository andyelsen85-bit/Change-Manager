---
name: db dist rebuild
description: Why @workspace/db must be rebuilt after schema edits before api-server typechecks/runs.
---

The `@workspace/api-server` package resolves `@workspace/db` types from the
package's compiled `dist/` output, not its `src/`. After editing any Drizzle
schema (new table, column, exported symbol) you MUST rebuild the db package:

```
pnpm --filter @workspace/db exec tsc --build
```

**Why:** Without the rebuild, `pnpm --filter @workspace/api-server exec tsc --noEmit`
fails with errors about missing tables/columns/exports that you just added — the
types it sees are the stale `dist/` declarations.

**How to apply:** Any task that touches `lib/db` schema → rebuild db, then
typecheck api-server. Also run `drizzle-kit push` to sync the actual database.
