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

// Idempotent column additions for fields the validator requires that pre-date a fresh
// drizzle-kit migration. Safe to run on every boot.
const SCHEMA_UPGRADE_SQL = `
ALTER TABLE standard_templates ADD COLUMN IF NOT EXISTS usage_count integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
`;

// Cleanup: per policy update, Technical Reviewer and Business Owner are no longer
// distinct approvers on Normal-track changes. Drop any STILL-PENDING approval rows
// for these roles so in-flight changes can proceed; rows already decided
// (approved/rejected/abstain) are preserved for the historical audit trail.
const CLEANUP_OBSOLETE_APPROVERS_SQL = `
DELETE FROM approvals
WHERE decision = 'pending'
  AND role_key IN ('technical_reviewer', 'business_owner');
`;

export async function applyDbConstraints(): Promise<void> {
  try {
    await db.execute(sql.raw(SCHEMA_UPGRADE_SQL));
    await db.execute(sql.raw(AUDIT_IMMUTABLE_SQL));
    const cleanup = await db.execute(sql.raw(CLEANUP_OBSOLETE_APPROVERS_SQL));
    logger.info(
      { obsoleteApproverRowsRemoved: (cleanup as { rowCount?: number }).rowCount ?? 0 },
      "DB constraints applied: audit_log is append-only; schema upgrades synced; obsolete approver rows pruned.",
    );
  } catch (err) {
    logger.error({ err }, "Failed to apply DB bootstrap (audit triggers / schema upgrade / cleanup)");
    throw err;
  }
}
