---
name: API route test mocking
description: How api-server route tests mock the DB and libs, and why new imports break old suites
---
Rule: every `*.test.ts` in `artifacts/api-server/src/routes/` mocks `@workspace/db` with an explicit table map and mocks `drizzle-orm` fn-by-fn. When a route gains a new import (a table like `cabMeetingsTable`, or a lib like `../lib/notification-routing`), previously passing suites for that route return 500 until the mock is extended.

**Why:** The DbMock is queue-based and the module mocks are allowlists; unmocked imports are `undefined` or hit the real module at import time.

**How to apply:** After adding any import to a route file, grep its test files and add the table to the `vi.mock("@workspace/db", ...)` map, the operator to the `drizzle-orm` mock (`and`, `sql`, ...), and `vi.mock` for new lib modules (e.g. `resolveRecipients: vi.fn().mockResolvedValue([])`). Note: 18 unrelated pre-existing test failures exist at baseline (July 2026) — compare against HEAD via `git archive` to /tmp before assuming regressions.
