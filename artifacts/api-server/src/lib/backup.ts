import { pool } from "@workspace/db";
import { logger } from "./logger";

export const BACKUP_VERSION = 2;

// Backups produced by older versions are still importable — `validate()` only
// requires the *current* table list to be present. Older payloads that
// reference dropped columns (e.g. notification_preferences.in_app_enabled,
// users without notifications_enabled) are handled by the per-row column
// filter in importAll(): we read the live table schema and silently drop
// any column from the backup row that no longer exists in the database.
const BACKUP_MIN_SUPPORTED_VERSION = 1;

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
  "change_categories",
  "change_requests",
  "change_assignees",
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
  "sso_settings",
  "ssl_settings",
  "workflow_timeouts",
  "audit_log",
] as const;

// Tables that are new in the current backup version. Older backups (v1)
// don't include these — that's fine, we leave them empty after restore.
const TABLES_OPTIONAL = new Set<string>(["change_categories", "change_assignees", "sso_settings"]);

export type BackupPayload = {
  version: number;
  exportedAt: string;
  tables: Record<string, Array<Record<string, unknown>>>;
};

export async function exportAll(): Promise<BackupPayload> {
  const tables: Record<string, Array<Record<string, unknown>>> = {};
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
  const version = typeof p.version === "number" ? p.version : Number(p.version);
  if (!Number.isFinite(version) || version < BACKUP_MIN_SUPPORTED_VERSION || version > BACKUP_VERSION) {
    throw new Error(
      `Unsupported backup version ${String(p.version)} (supported: ${BACKUP_MIN_SUPPORTED_VERSION}–${BACKUP_VERSION})`,
    );
  }
  if (!p.tables || typeof p.tables !== "object") throw new Error("Backup payload missing 'tables' object");
  const tables = p.tables as Record<string, unknown>;
  for (const t of TABLES) {
    if (TABLES_OPTIONAL.has(t)) continue;
    if (!Array.isArray(tables[t])) throw new Error(`Backup payload missing rows array for table '${t}'`);
  }
}

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

// Pull the live column set for every table we know about so we can filter
// per-row keys before INSERT. Without this, restoring a v1 backup that still
// has `notification_preferences.in_app_enabled` would error out — the
// dropped column doesn't exist in the live schema.
async function loadLiveColumns(
  client: { query: (text: string) => Promise<{ rows: Array<Record<string, unknown>> }> },
): Promise<Record<string, Set<string>>> {
  const tablesList = TABLES.map((t) => `'${t}'`).join(", ");
  const { rows } = await client.query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name IN (${tablesList})`,
  );
  const out: Record<string, Set<string>> = {};
  for (const r of rows) {
    const t = String(r.table_name);
    const c = String(r.column_name);
    if (!out[t]) out[t] = new Set();
    out[t].add(c);
  }
  return out;
}

export async function importAll(payload: unknown): Promise<{ restored: Record<string, number> }> {
  validate(payload);
  const restored: Record<string, number> = {};
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE audit_log DISABLE TRIGGER USER");

    // Wipe in reverse FK order.
    for (let i = TABLES.length - 1; i >= 0; i--) {
      await client.query(`DELETE FROM ${TABLES[i]}`);
    }

    const liveCols = await loadLiveColumns(client);

    for (const t of TABLES) {
      const rows = (payload.tables[t] ?? []) as Array<Record<string, unknown>>;
      restored[t] = rows.length;
      const allowed = liveCols[t] ?? new Set<string>();
      for (const row of rows) {
        // Drop any column from the backup that the live schema no longer
        // recognises (e.g. legacy `in_app_enabled`). This keeps older
        // backups importable across schema migrations.
        const cols = Object.keys(row).filter((c) => allowed.has(c));
        if (cols.length === 0) continue;
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
        const colList = cols.map((c) => `"${c}"`).join(", ");
        const values = cols.map((c) => row[c]);
        await client.query(`INSERT INTO ${t} (${colList}) VALUES (${placeholders})`, values);
      }
    }

    await resetAllSequences(client);

    await client.query("ALTER TABLE audit_log ENABLE TRIGGER USER");
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.query("ALTER TABLE audit_log ENABLE TRIGGER USER").catch(() => undefined);
    logger.error({ err }, "Backup restore failed; transaction rolled back");
    throw err;
  } finally {
    client.release();
  }
  return { restored };
}
