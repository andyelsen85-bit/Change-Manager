import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";

// Database-level guarantees that complement the ORM schema. These run on every server
// boot and are idempotent. Most importantly: enforce immutability of the audit log via
// triggers so even a compromised application cannot UPDATE or DELETE audit rows.

const AUDIT_IMMUTABLE_SQL = `
CREATE OR REPLACE FUNCTION audit_log_block_modifications() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % operations are not permitted', TG_OP
    USING ERRCODE = '0A000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_block_modifications();

DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log;
CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_block_modifications();

DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_block_modifications();
`;

export async function applyDbConstraints(): Promise<void> {
  try {
    await db.execute(sql.raw(AUDIT_IMMUTABLE_SQL));
    logger.info("DB constraints applied: audit_log is now append-only at the database layer.");
  } catch (err) {
    logger.error({ err }, "Failed to apply audit_log immutability triggers");
    throw err;
  }
}
