import { pool } from "@workspace/db";
import { logger } from "./logger";

export const BACKUP_VERSION = 1;

// Tables in FK-safe insert order. The reverse of this order is used for the
// pre-restore wipe. Every table the application uses MUST appear here — a
// missing table means that data is silently dropped on restore.
const TABLES = [
  "roles",
  "users",
  "role_assignments",
  "cab_meetings",
  "cab_members",
  "standard_templates",
  "change_requests",
  "cab_changes",
  "planning_records",
  "test_records",
  "pir_records",
  "approvals",
  "comments",
  "notification_preferences",
  "ref_counters",
  "smtp_settings",
  "ldap_settings",
  "ssl_settings",
  "workflow_timeouts",
  "audit_log",
] as const;

export type BackupPayload = {
  version: number;
  exportedAt: string;
  tables: Record<string, Array<Record<string, unknown>>>;
};

export async function exportAll(): Promise<BackupPayload> {
  const tables: Record<string, Array<Record<string, unknown>>> = {};
  // Use a single REPEATABLE READ READ ONLY transaction so every table is read
  // from the same MVCC snapshot. Without this, concurrent writes between
  // table reads can produce a logically inconsistent backup (e.g. a comment
  // referencing a change_request that wasn't included in the snapshot).
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    for (const t of TABLES) {
      const r = await client.query(`SELECT * FROM ${t}`);
      tables[t] = r.rows;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return { version: BACKUP_VERSION, exportedAt: new Date().toISOString(), tables };
}

function validate(payload: unknown): asserts payload is BackupPayload {
  if (!payload || typeof payload !== "object") throw new Error("Backup payload must be an object");
  const p = payload as Record<string, unknown>;
  if (p.version !== BACKUP_VERSION) {
    throw new Error(`Unsupported backup version ${String(p.version)} (expected ${BACKUP_VERSION})`);
  }
  if (!p.tables || typeof p.tables !== "object") throw new Error("Backup payload missing 'tables' object");
  const tables = p.tables as Record<string, unknown>;
  for (const t of TABLES) {
    if (!Array.isArray(tables[t])) throw new Error(`Backup payload missing rows array for table '${t}'`);
  }
}

// After restore we discover every serial/identity column in the backed-up
// tables from pg_catalog and advance its sequence past the largest imported
// id. Doing this dynamically (instead of a hand-maintained list) means a new
// serial column added to the schema is automatically handled and we can't
// silently miss one — the architect flagged that omission as a real risk.
async function resetAllSequences(client: { query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }): Promise<void> {
  const tablesList = TABLES.map((t) => `'${t}'`).join(", ");
  const { rows } = await client.query(
    `SELECT c.table_name AS table_name,
            c.column_name AS column_name
       FROM information_schema.columns c
      WHERE c.table_schema = current_schema()
        AND c.table_name IN (${tablesList})
        AND pg_get_serial_sequence(c.table_name, c.column_name) IS NOT NULL`,
  );
  for (const r of rows) {
    const table = String(r.table_name);
    const column = String(r.column_name);
    await client.query(
      `SELECT setval(
         pg_get_serial_sequence($1, $2),
         COALESCE((SELECT MAX("${column}") FROM "${table}"), 0) + 1,
         false
       )`,
      [table, column],
    );
  }
}

export async function importAll(payload: unknown): Promise<{ restored: Record<string, number> }> {
  validate(payload);
  const restored: Record<string, number> = {};
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // audit_log has triggers blocking UPDATE/DELETE/TRUNCATE for forensic
    // integrity; we are doing an explicit, authenticated full restore so we
    // disable them for the duration of the transaction only.
    await client.query("ALTER TABLE audit_log DISABLE TRIGGER USER");

    // Wipe in reverse FK order.
    for (let i = TABLES.length - 1; i >= 0; i--) {
      await client.query(`DELETE FROM ${TABLES[i]}`);
    }

    // Insert in dependency order.
    for (const t of TABLES) {
      const rows = (payload.tables[t] ?? []) as Array<Record<string, unknown>>;
      restored[t] = rows.length;
      for (const row of rows) {
        const cols = Object.keys(row);
        if (cols.length === 0) continue;
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
        const colList = cols.map((c) => `"${c}"`).join(", ");
        const values = cols.map((c) => row[c]);
        await client.query(`INSERT INTO ${t} (${colList}) VALUES (${placeholders})`, values);
      }
    }

    // Advance every serial/identity sequence in the backed-up tables past the
    // largest imported id so future inserts don't collide.
    await resetAllSequences(client);

    await client.query("ALTER TABLE audit_log ENABLE TRIGGER USER");
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    // Re-enable triggers even if the restore failed mid-flight.
    await client.query("ALTER TABLE audit_log ENABLE TRIGGER USER").catch(() => undefined);
    logger.error({ err }, "Backup restore failed; transaction rolled back");
    throw err;
  } finally {
    client.release();
  }
  return { restored };
}
