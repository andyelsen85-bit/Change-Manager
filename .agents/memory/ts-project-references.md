---
name: Stale TS project references
description: lib/db schema edits require rebuilding composite project refs before dependents typecheck correctly
---
Rule: `artifacts/api-server` and `artifacts/change-mgmt` use TypeScript project references to `lib/db` (composite, has tsconfig.tsbuildinfo). After editing `lib/db/src/schema/*`, plain `tsc --noEmit` in a dependent package resolves the OLD declarations and reports missing columns/exports.

**Why:** Project references consume the referenced project's built declaration output, which stays stale until rebuilt.

**How to apply:** Run `pnpm exec tsc -b lib/db --force` (workspace root) then `pnpm --filter <pkg> exec tsc -b` to typecheck dependents. Migrations are idempotent SCHEMA_UPGRADE_SQL in api-server db-bootstrap run at boot — no drizzle-kit push needed in dev.
