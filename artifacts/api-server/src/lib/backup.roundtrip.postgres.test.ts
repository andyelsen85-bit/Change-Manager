import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

// This destructive test is deliberately opt-in. It never reads DATABASE_URL:
// callers must provide a separate, migrated PostgreSQL database in
// BACKUP_TEST_DATABASE_URL. The test clones empty tables into a fresh,
// randomized schema and confines every write, restore, sequence reset, and
// trigger operation to that schema.
const isolatedDatabaseUrl = process.env["BACKUP_TEST_DATABASE_URL"];
const describeIsolated = isolatedDatabaseUrl ? describe : describe.skip;

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

describeIsolated("backup restore PostgreSQL round trip", () => {
  const originalDatabaseUrl = process.env["DATABASE_URL"];
  const schema = `backup_roundtrip_${randomUUID().replaceAll("-", "")}`;
  let pool:
    | {
        options: { max?: number };
        connect: () => Promise<{
          query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
          release: () => void;
        }>;
        end: () => Promise<void>;
      }
    | undefined;

  afterAll(async () => {
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      } finally {
        client.release();
        await pool.end();
      }
    }
    if (originalDatabaseUrl === undefined) delete process.env["DATABASE_URL"];
    else process.env["DATABASE_URL"] = originalDatabaseUrl;
  });

  it("round trips persistent Round 2 data, bytea, and clears OIDC transaction state", async () => {
    // @workspace/db requires DATABASE_URL at module initialization. Point it
    // only at the caller-supplied isolated test database, never the workspace
    // development database.
    process.env["DATABASE_URL"] = isolatedDatabaseUrl;
    const dbModule = await import("@workspace/db");
    pool = dbModule.pool;
    // With a single connection, export/import reuses the connection on which
    // search_path is scoped, avoiding any possibility of a public-schema write.
    pool.options.max = 1;
    const { BACKUP_EXCLUDED_TABLES, exportAll, importAll, TABLES } = await import("./backup");

    const client = await pool.connect();
    let clientReleased = false;
    try {
      await client.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      const inventory = [...TABLES, ...BACKUP_EXCLUDED_TABLES];
      for (const table of inventory) {
        await client.query(
          `CREATE TABLE ${quoteIdentifier(schema)}.${quoteIdentifier(table)} (LIKE public.${quoteIdentifier(table)} INCLUDING ALL)`,
        );
      }

      // LIKE preserves defaults pointing at public-schema sequences. Replace
      // every serial default with a sequence owned by the fresh schema table
      // so importAll's sequence reset cannot mutate the source schema.
      for (const table of inventory) {
        const { rows } = await client.query(
          `SELECT column_name
             FROM information_schema.columns
            WHERE table_schema = $1
              AND table_name = $2
              AND column_default LIKE 'nextval(%'`,
          [schema, table],
        );
        for (const row of rows) {
          const column = String(row.column_name);
          const sequence = `${table}_${column}_backup_roundtrip_seq`;
          await client.query(`CREATE SEQUENCE ${quoteIdentifier(schema)}.${quoteIdentifier(sequence)}`);
          await client.query(
            `ALTER SEQUENCE ${quoteIdentifier(schema)}.${quoteIdentifier(sequence)}
             OWNED BY ${quoteIdentifier(schema)}.${quoteIdentifier(table)}.${quoteIdentifier(column)}`,
          );
          await client.query(
            `ALTER TABLE ${quoteIdentifier(schema)}.${quoteIdentifier(table)}
             ALTER COLUMN ${quoteIdentifier(column)}
             SET DEFAULT nextval('${schema}.${sequence}'::regclass)`,
          );
        }
      }
      await client.query(`SET search_path TO ${quoteIdentifier(schema)}, public`);

      // LIKE does not copy foreign keys. Recreate them against the isolated
      // tables so this also verifies real dependency-safe delete/insert order.
      const foreignKeys = await client.query(
        `SELECT c.relname AS table_name, con.conname AS constraint_name,
                pg_get_constraintdef(con.oid) AS definition
           FROM pg_constraint con
           JOIN pg_class c ON c.oid = con.conrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND con.contype = 'f'
            AND c.relname = ANY($1::text[])`,
        [inventory],
      );
      for (const fk of foreignKeys.rows) {
        const definition = String(fk.definition).replaceAll("REFERENCES public.", `REFERENCES ${quoteIdentifier(schema)}.`);
        await client.query(
          `ALTER TABLE ${quoteIdentifier(schema)}.${quoteIdentifier(String(fk.table_name))}
           ADD CONSTRAINT ${quoteIdentifier(String(fk.constraint_name))} ${definition}`,
        );
      }

      // LIKE INCLUDING ALL does not copy triggers. Recreate all three
      // production audit immutability triggers in the isolated schema so a
      // successful restore is checked for append-only behavior and a failed
      // restore cannot leave the trigger disabled.
      await client.query(
        `CREATE FUNCTION ${quoteIdentifier(schema)}.${quoteIdentifier("audit_log_block_modifications")}()
         RETURNS trigger AS $$
         BEGIN
           RAISE EXCEPTION 'audit_log is append-only: % operations are not permitted', TG_OP
             USING ERRCODE = '0A000';
         END;
         $$ LANGUAGE plpgsql`,
      );
      await client.query(
        `CREATE TRIGGER ${quoteIdentifier("audit_log_no_update")}
           BEFORE UPDATE ON ${quoteIdentifier(schema)}.${quoteIdentifier("audit_log")}
           FOR EACH ROW EXECUTE FUNCTION ${quoteIdentifier(schema)}.${quoteIdentifier("audit_log_block_modifications")}()`,
      );
      await client.query(
        `CREATE TRIGGER ${quoteIdentifier("audit_log_no_delete")}
           BEFORE DELETE ON ${quoteIdentifier(schema)}.${quoteIdentifier("audit_log")}
           FOR EACH ROW EXECUTE FUNCTION ${quoteIdentifier(schema)}.${quoteIdentifier("audit_log_block_modifications")}()`,
      );
      await client.query(
        `CREATE TRIGGER ${quoteIdentifier("audit_log_no_truncate")}
           BEFORE TRUNCATE ON ${quoteIdentifier(schema)}.${quoteIdentifier("audit_log")}
           FOR EACH STATEMENT EXECUTE FUNCTION ${quoteIdentifier(schema)}.${quoteIdentifier("audit_log_block_modifications")}()`,
      );

      await client.query(
        "INSERT INTO users (id, username, email, full_name, password_hash) VALUES (1, 'backup-user', 'backup@example.test', 'Backup User', 'not-used')",
      );
      await client.query(
        "INSERT INTO change_requests (id, ref, title, track, owner_id) VALUES (1, 'CHG-ROUNDTRIP', 'Round-trip change', 'normal', 1)",
      );
      await client.query(
        "INSERT INTO change_requests (id, ref, title, track, owner_id, parent_change_id) VALUES (2, 'CHG-CHILD', 'Child change', 'normal', 1, 1)",
      );
      await client.query(
        "INSERT INTO cab_meetings (id, title, scheduled_start, scheduled_end) VALUES (1, 'CAB', now(), now() + interval '1 hour')",
      );
      await client.query(
        "INSERT INTO attachments (id, change_id, filename, mime_type, size, data, uploaded_by_id) VALUES (1, 1, 'proof.bin', 'application/octet-stream', 5, $1, 1)",
        [Buffer.from([0, 255, 17, 128, 66])],
      );
      await client.query(
        "INSERT INTO adfs_settings (key, enabled, issuer) VALUES ('global', true, 'https://adfs.example.test')",
      );
      await client.query(
        "INSERT INTO cab_attendees (id, meeting_id, user_id, name, email, present) VALUES (1, 1, 1, 'Backup User', 'backup@example.test', true)",
      );
      await client.query(
        "INSERT INTO external_changes (id, title, provider, start_at, created_by) VALUES (1, 'Provider maintenance', 'Provider', now(), 1)",
      );
      await client.query("INSERT INTO template_settings (key, promotion_threshold) VALUES ('global', 7)");
      await client.query("INSERT INTO discussion_reads (user_id, change_id) VALUES (1, 1)");
      await client.query(
        `INSERT INTO test_records
           (change_id, kind, test_plan, environment, overall_result, notes, cases)
         VALUES
           (1, 'production', 'Nested JSON test', 'isolated', 'pending', '', $1::jsonb),
           (2, 'production', 'Empty JSON test', 'isolated', 'pending', '', $2::jsonb)`,
        [
          JSON.stringify([
            {
              name: "nested",
              steps: "run nested fixture",
              expectedResult: "pass",
              actualResult: "",
              status: "pending",
              details: { owner: "test", values: [1, { enabled: true }] },
            },
          ]),
          JSON.stringify([]),
        ],
      );
      await client.query(
        `INSERT INTO audit_log
           (actor_id, actor_name, action, entity_type, entity_id, summary, before, after)
         VALUES
           (1, 'Backup User', 'backup.json-regression', 'change', 1, 'JSON primitives', $1::jsonb, $2::jsonb),
           (1, 'Backup User', 'backup.sql-null', 'change', 1, 'SQL NULL', NULL, NULL)`,
        [JSON.stringify("before primitive"), JSON.stringify("after primitive")],
      );
      client.release();
      clientReleased = true;

      const exported = JSON.parse(JSON.stringify(await exportAll()));
      expect(exported.tables.attachments[0].data).toEqual({
        __change_it_backup_encoding: "bytea",
        base64: Buffer.from([0, 255, 17, 128, 66]).toString("base64"),
      });
      for (const table of [
        "attachments",
        "adfs_settings",
        "cab_attendees",
        "external_changes",
        "template_settings",
        "discussion_reads",
      ]) {
        expect(exported.tables[table]).toHaveLength(1);
      }
      expect(exported.tables.test_records).toHaveLength(2);
      expect(exported.tables.test_records.map((row: Record<string, unknown>) => row.cases)).toEqual(
        expect.arrayContaining([
          [
            {
              name: "nested",
              steps: "run nested fixture",
              expectedResult: "pass",
              actualResult: "",
              status: "pending",
              details: { owner: "test", values: [1, { enabled: true }] },
            },
          ],
          [],
        ]),
      );
      const exportedAuditRows = exported.tables.audit_log.filter(
        (row: Record<string, unknown>) =>
          row.action === "backup.json-regression" || row.action === "backup.sql-null",
      );
      expect(exportedAuditRows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            before: "before primitive",
            after: "after primitive",
          }),
          expect.objectContaining({ before: null, after: null }),
        ]),
      );

      // Keep a child-before-parent payload ordering as a regression fixture;
      // the checked-in schema has no self-FK, so this ordering is harmless.
      const parentAndChild = exported.tables.change_requests.filter(
        (row: Record<string, unknown>) => row.id === 1 || row.id === 2,
      );
      expect(parentAndChild).toHaveLength(2);
      exported.tables.change_requests = [
        parentAndChild.find((row: Record<string, unknown>) => row.id === 2)!,
        parentAndChild.find((row: Record<string, unknown>) => row.id === 1)!,
      ];

      const mutationClient = await pool.connect();
      try {
        await mutationClient.query("DELETE FROM attachments");
        await mutationClient.query("UPDATE adfs_settings SET issuer = 'https://mutated.example.test'");
        await mutationClient.query(
          "INSERT INTO adfs_auth_transactions (state_hash, config_fingerprint, expires_at) VALUES ('stale', 'stale', now() + interval '1 hour')",
        );
        await mutationClient.query(
          "INSERT INTO audit_log (action, entity_type, summary) VALUES ('backup.restore-sentinel', 'system', 'must survive failed restore')",
        );
      } finally {
        mutationClient.release();
      }

      const invalidRestore = JSON.parse(JSON.stringify(exported));
      const invalidAttachment = invalidRestore.tables.attachments.find(
        (row: Record<string, unknown>) => row.id === 1,
      )!;
      invalidAttachment.data = {
        __change_it_backup_encoding: "bytea",
        base64: "!!!",
      };
      await expect(importAll(invalidRestore)).rejects.toThrow(/invalid bytea value/);

      const failedRestoreVerification = await pool.connect();
      try {
        const preservedIssuer = await failedRestoreVerification.query(
          "SELECT issuer FROM adfs_settings WHERE key = 'global'",
        );
        expect(preservedIssuer.rows[0]?.issuer).toBe("https://mutated.example.test");
        const preservedAudit = await failedRestoreVerification.query(
          "SELECT action FROM audit_log WHERE action = 'backup.restore-sentinel'",
        );
        expect(preservedAudit.rows).toHaveLength(1);
      } finally {
        failedRestoreVerification.release();
      }

      await importAll(exported);

      const restored = JSON.parse(JSON.stringify(await exportAll()));
      for (const table of [
        "attachments", "adfs_settings", "cab_attendees",
        "external_changes", "template_settings", "discussion_reads",
      ]) {
        expect(restored.tables[table]).toEqual(exported.tables[table]);
      }
      expect(restored.tables.test_records).toEqual(exported.tables.test_records);
      expect(
        restored.tables.change_requests.map((row: Record<string, unknown>) => ({
          id: row.id,
          parent_change_id: row.parent_change_id,
        })),
      ).toEqual(
        expect.arrayContaining([
          { id: 1, parent_change_id: null },
          { id: 2, parent_change_id: 1 },
        ]),
      );
      expect(
        restored.tables.audit_log.filter(
          (row: Record<string, unknown>) =>
            row.action === "backup.json-regression" || row.action === "backup.sql-null",
        ),
      ).toEqual(
        exported.tables.audit_log.filter(
          (row: Record<string, unknown>) =>
            row.action === "backup.json-regression" || row.action === "backup.sql-null",
        ),
      );

      const verificationClient = await pool.connect();
      try {
        const attachment = await verificationClient.query("SELECT data FROM attachments WHERE id = 1");
        expect(attachment.rows[0]?.data).toEqual(Buffer.from([0, 255, 17, 128, 66]));
        const restoredIssuer = await verificationClient.query("SELECT issuer FROM adfs_settings WHERE key = 'global'");
        expect(restoredIssuer.rows[0]?.issuer).toBe("https://adfs.example.test");
        const staleTransactions = await verificationClient.query(
          "SELECT count(*)::integer AS count FROM adfs_auth_transactions",
        );
        expect(staleTransactions.rows[0]?.count).toBe(0);

        const auditJson = await verificationClient.query(
          "SELECT before, after FROM audit_log WHERE action = 'backup.json-regression'",
        );
        expect(auditJson.rows[0]?.before).toBe("before primitive");
        expect(auditJson.rows[0]?.after).toBe("after primitive");
        const auditNull = await verificationClient.query(
          "SELECT before, after FROM audit_log WHERE action = 'backup.sql-null'",
        );
        expect(auditNull.rows[0]?.before).toBeNull();
        expect(auditNull.rows[0]?.after).toBeNull();

        await verificationClient.query("BEGIN");
        await expect(
          verificationClient.query(
            "UPDATE audit_log SET summary = 'tampered' WHERE action = 'backup.json-regression'",
          ),
        ).rejects.toThrow(/append-only/);
        await verificationClient.query("ROLLBACK");

        await verificationClient.query("BEGIN");
        await expect(
          verificationClient.query("DELETE FROM audit_log WHERE action = 'backup.json-regression'"),
        ).rejects.toThrow(/append-only/);
        await verificationClient.query("ROLLBACK");
      } finally {
        verificationClient.release();
      }
    } finally {
      if (!clientReleased) client.release();
    }
  }, 30_000);
});