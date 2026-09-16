import { pool } from "@workspace/db";
import { logger } from "./logger";

// Version 3 makes the Round 2 tables mandatory in every newly-created backup.
// Versions 1 and 2 remain importable, even though they pre-date some tables.
export const BACKUP_VERSION = 3;

// Backups produced by older versions are still importable — `validate()` only
// requires the version-appropriate table list to be present. Older payloads that
// reference dropped columns (e.g. notification_preferences.in_app_enabled,
// users without notifications_enabled) are handled by the per-row column
// filter in importAll(): we read the live table schema and silently drop
// any column from the backup row that no longer exists in the database.
const BACKUP_MIN_SUPPORTED_VERSION = 1;

// Tables in FK-safe insert order. The reverse of this order is used for the
// pre-restore wipe. Every table the application uses MUST appear here — a
// missing table means that data is silently dropped on restore.
export const TABLES = [
  "roles",
  "users",
  "role_assignments",
  "cab_meetings",
  "cab_members",
  "cab_attendees",
  "standard_templates",
  "template_settings",
  "change_categories",
  "change_requests",
  "change_assignees",
  "cab_changes",
  "attachments",
  "planning_records",
  "test_records",
  "pir_records",
  "approvals",
  "comments",
  "discussion_reads",
  "external_changes",
  "pentest_test_types",
  "pentest_requests",
  "pentest_collaborators",
  "pentest_attachments",
  "notification_preferences",
  "ref_counters",
  "smtp_settings",
  "ldap_settings",
  "adfs_settings",
  "ssl_settings",
  "notification_settings",
  "sdp_settings",
  "notification_queue",
  "notification_routing_rules",
  "audit_log",
] as const;

// Tables that did not exist in older backup formats. They are optional only
// when importing a legacy v1/v2 payload; a v3 export must include every TABLES
// entry, including all six persistent Round 2 additions.
export const TABLES_OPTIONAL = new Set<string>([
  "sdp_settings",
  "change_categories",
  "change_assignees",
  "notification_settings",
  "notification_queue",
  "notification_routing_rules",
  "pentest_test_types",
  "pentest_requests",
  "pentest_collaborators",
  "pentest_attachments",
  "attachments",
  "adfs_settings",
  "cab_attendees",
  "external_changes",
  "template_settings",
  "discussion_reads",
]);

// These tables are deliberately operational and are never part of a backup
// payload. A restore invalidates every persisted session and must not carry
// login-throttle state between environments. adfs_auth_transactions contains
// only short-lived, hashed OIDC state/fingerprint rows: they expire naturally
// and are deleted after one guarded consume, so restoring them would revive
// stale authorization attempts. Clear it with the other operational state.
export const BACKUP_EXCLUDED_TABLES = [
  "user_sessions",
  "auth_login_throttle",
  "adfs_auth_transactions",
] as const;
const RESTORE_INVALIDATION_TABLES = BACKUP_EXCLUDED_TABLES;
const MAX_SESSION_GENERATION = 2_147_483_647;
const BYTEA_ENCODING_KEY = "__change_it_backup_encoding";

export type BackupPayload = {
  version: number;
  exportedAt: string;
  tables: Record<string, Array<Record<string, unknown>>>;
};

function exportValue(value: unknown): unknown {
  // pg returns bytea as Buffer. Convert it before the API serializes the
  // payload; JSON.stringify(Buffer) otherwise produces a Node-specific object
  // which pg cannot restore as bytea.
  if (Buffer.isBuffer(value)) {
    return { [BYTEA_ENCODING_KEY]: "bytea", base64: value.toString("base64") };
  }
  return value;
}

function importBytea(value: unknown, table: string, column: string): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value && typeof value === "object") {
    const encoded = value as Record<string, unknown>;
    if (
      encoded[BYTEA_ENCODING_KEY] === "bytea" &&
      typeof encoded.base64 === "string" &&
      Object.keys(encoded).length === 2
    ) {
      const base64 = encoded.base64;
      const bytes = Buffer.from(base64, "base64");
      if (bytes.toString("base64") === base64) return bytes;
    }

    // v1/v2 backups were JSON-stringified directly. Preserve the bytea
    // representation Node generated for those legacy Buffer instances.
    if (
      encoded.type === "Buffer" &&
      Array.isArray(encoded.data) &&
      encoded.data.every((item) => typeof item === "number" && Number.isInteger(item) && item >= 0 && item <= 255)
    ) {
      return Buffer.from(encoded.data);
    }
  }
  throw new BackupValidationError(`Backup payload has invalid bytea value for '${table}.${column}'`);
}

/**
 * Validation failures are safe to show to an administrator. Keeping a
 * distinct type prevents the restore route from deciding whether arbitrary
 * exception text is suitable for an API response.
 */
export class BackupValidationError extends Error {
  readonly isBackupValidationError = true;

  constructor(message: string) {
    super(message);
    this.name = "BackupValidationError";
  }
}

export async function exportAll(): Promise<BackupPayload> {
  const tables: Record<string, Array<Record<string, unknown>>> = {};
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    for (const t of TABLES) {
      const r = await client.query(`SELECT * FROM ${t}`);
      tables[t] = r.rows.map((row) =>
        Object.fromEntries(Object.entries(row).map(([column, value]) => [column, exportValue(value)])),
      );
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
  if (!payload || typeof payload !== "object") throw new BackupValidationError("Backup payload must be an object");
  const p = payload as Record<string, unknown>;
  const version =
    typeof p.version === "number"
      ? p.version
      : typeof p.version === "string"
        ? Number(p.version)
        : Number.NaN;
  if (!Number.isInteger(version) || version < BACKUP_MIN_SUPPORTED_VERSION || version > BACKUP_VERSION) {
    throw new BackupValidationError(
      `Unsupported backup version ${
        Number.isFinite(version) ? version : "unknown"
      } (supported: ${BACKUP_MIN_SUPPORTED_VERSION}–${BACKUP_VERSION})`,
    );
  }
  if (!p.tables || typeof p.tables !== "object") {
    throw new BackupValidationError("Backup payload missing 'tables' object");
  }
  const tables = p.tables as Record<string, unknown>;
  for (const t of TABLES) {
    if (version < BACKUP_VERSION && TABLES_OPTIONAL.has(t)) continue;
    if (!Array.isArray(tables[t])) {
      throw new BackupValidationError(`Backup payload missing rows array for table '${t}'`);
    }
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
): Promise<Record<string, Map<string, string>>> {
  const tablesList = TABLES.map((t) => `'${t}'`).join(", ");
  const { rows } = await client.query(
    `SELECT table_name, column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name IN (${tablesList})`,
  );
  const out: Record<string, Map<string, string>> = {};
  for (const r of rows) {
    const t = String(r.table_name);
    const c = String(r.column_name);
    if (!out[t]) out[t] = new Map();
    out[t].set(c, String(r.data_type));
  }
  return out;
}

async function deriveRestoreSessionGeneration(client: {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}): Promise<number> {
  // Lock existing users while deriving the barrier. Password/session
  // generation updates use the same rows, so they serialize with restore and
  // cannot race the max-generation calculation.
  const { rows } = await client.query(
    `SELECT id, session_generation
       FROM users
      FOR UPDATE`,
  );
  let maxGeneration = -1;
  for (const row of rows) {
    const generation = row.session_generation;
    if (
      typeof generation !== "number" ||
      !Number.isSafeInteger(generation) ||
      generation < 0 ||
      generation > MAX_SESSION_GENERATION
    ) {
      throw new Error("Cannot restore backup: users.session_generation contains an invalid value");
    }
    maxGeneration = Math.max(maxGeneration, generation);
  }
  if (maxGeneration >= MAX_SESSION_GENERATION) {
    throw new Error("Cannot restore backup: users.session_generation would overflow");
  }
  return maxGeneration + 1;
}

export async function importAll(payload: unknown): Promise<{ restored: Record<string, number> }> {
  validate(payload);
  const restored: Record<string, number> = {};
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const restoreSessionGeneration = await deriveRestoreSessionGeneration(client);
    // Session rows contain numeric user IDs. If they survived a restore, a
    // cookie from before the restore could authenticate as the user now
    // occupying the same ID in the imported dataset. Clear both operational
    // stores in this transaction, before any user rows are replaced.
    for (const table of RESTORE_INVALIDATION_TABLES) {
      await client.query(`DELETE FROM ${table}`);
    }
    await client.query("ALTER TABLE audit_log DISABLE TRIGGER USER");

    // Wipe in reverse FK order.
    for (let i = TABLES.length - 1; i >= 0; i--) {
      await client.query(`DELETE FROM ${TABLES[i]}`);
    }

    const liveCols = await loadLiveColumns(client);
    const userRows = (payload.tables.users ?? []) as Array<Record<string, unknown>>;
    if (userRows.length > 0 && !liveCols.users?.has("session_generation")) {
      throw new Error("Cannot restore backup: users.session_generation column is unavailable");
    }

    for (const t of TABLES) {
      const rows = (payload.tables[t] ?? []) as Array<Record<string, unknown>>;
      restored[t] = rows.length;
      const allowed = liveCols[t] ?? new Map<string, string>();
      for (const row of rows) {
        // Drop any column from the backup that the live schema no longer
        // recognises (e.g. legacy `in_app_enabled`). This keeps older
        // backups importable across schema migrations.
        // Never trust a generation supplied by a backup. Every restored user
        // receives one barrier generation that is greater than every
        // pre-restore user generation.
        const cols = Object.keys(row).filter(
          (c) => allowed.has(c) && !(t === "users" && c === "session_generation"),
        );
        if (t === "users" && allowed.has("session_generation")) cols.push("session_generation");
        if (cols.length === 0) continue;
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
        const colList = cols.map((c) => `"${c}"`).join(", ");
        const values = cols.map((c) =>
          t === "users" && c === "session_generation"
            ? restoreSessionGeneration
            : allowed.get(c) === "bytea"
              ? importBytea(row[c], t, c)
              : row[c],
        );
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
