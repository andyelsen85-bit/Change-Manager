import { describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as schema from "@workspace/db/schema";
import { BACKUP_EXCLUDED_TABLES, TABLES, TABLES_OPTIONAL } from "./backup";

describe("backup schema coverage", () => {
  it("preserves bootstrap-managed security tables during schema pushes", async () => {
    // Load the separate DB package's tooling config at runtime; it is not
    // part of the API's TypeScript build.
    const { default: migrationConfig } = await vi.importActual<{
      default: { tablesFilter?: string | string[] };
    }>("../../../../lib/db/drizzle.config");
    const schemaTables = Object.values(schema)
      .filter((value) => value instanceof PgTable)
      .map((table) => getTableName(table as PgTable));
    const bootstrapTables = BACKUP_EXCLUDED_TABLES.filter((table) => !schemaTables.includes(table));
    // Keep this exact: no wildcard may hide ordinary schema changes, and
    // Drizzle-managed adfs_auth_transactions must not be excluded from pushes.
    expect(migrationConfig.tablesFilter).toEqual(bootstrapTables.map((table) => `!${table}`));
  });

  it("accounts for every exported Drizzle PostgreSQL table", () => {
    // Schema exports, not a hand-maintained table list, are the source of
    // truth. Adding a pgTable export without updating backup policy fails here.
    const schemaTables: string[] = Object.values(schema)
      .filter((value) => value instanceof PgTable)
      .map((table) => getTableName(table as PgTable));
    const accountedFor = new Set([...TABLES, ...TABLES_OPTIONAL, ...BACKUP_EXCLUDED_TABLES]);

    expect(schemaTables).not.toHaveLength(0);
    expect([...new Set(schemaTables)].sort()).toEqual(schemaTables.sort());
    expect(schemaTables.filter((table) => !accountedFor.has(table))).toEqual([]);
    // Legacy optionality never excuses omitting a table from new exports.
    expect([...TABLES_OPTIONAL].filter((table) => !(TABLES as readonly string[]).includes(table))).toEqual([]);
    // user_sessions and auth_login_throttle are deliberately operational
    // bootstrap tables rather than Drizzle schema exports. All Drizzle-backed
    // exclusions must still correspond to a real schema table.
    expect(BACKUP_EXCLUDED_TABLES.filter((table) => schemaTables.includes(table))).toEqual([
      "adfs_auth_transactions",
    ]);
  });
});