import { describe, expect, it } from "vitest";
import { getTableName } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as schema from "@workspace/db/schema";
import { BACKUP_EXCLUDED_TABLES, TABLES, TABLES_OPTIONAL } from "./backup";

describe("backup schema coverage", () => {
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