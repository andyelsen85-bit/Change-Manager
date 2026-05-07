import { Client } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("[pre-migrate] DATABASE_URL not set; skipping");
  process.exit(0);
}

const STATEMENTS: { label: string; sql: string }[] = [
  {
    label: "sso_settings table",
    sql: `
      CREATE TABLE IF NOT EXISTS sso_settings (
        key text PRIMARY KEY DEFAULT 'global',
        enabled boolean NOT NULL DEFAULT false,
        service_principal text NOT NULL DEFAULT '',
        keytab_b64 text,
        krb5_conf text NOT NULL DEFAULT '',
        strip_realm boolean NOT NULL DEFAULT true,
        default_email_domain text NOT NULL DEFAULT '',
        auto_create_users boolean NOT NULL DEFAULT true
      );
      INSERT INTO sso_settings (key) VALUES ('global') ON CONFLICT DO NOTHING;`,
  },
  {
    label: "test_records.kind column",
    sql: `
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables
                   WHERE table_name='test_records') THEN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name='test_records' AND column_name='kind') THEN
            ALTER TABLE test_records ADD COLUMN kind text NOT NULL DEFAULT 'production';
          END IF;
          BEGIN
            ALTER TABLE test_records DROP CONSTRAINT test_records_pkey;
          EXCEPTION WHEN undefined_object THEN NULL;
          END;
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid='test_records'::regclass AND contype='p'
          ) THEN
            ALTER TABLE test_records ADD PRIMARY KEY (change_id, kind);
          END IF;
        END IF;
      END $$;`,
  },
];

async function main() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    for (const { label, sql } of STATEMENTS) {
      try {
        await client.query(sql);
        console.log(`[pre-migrate] OK: ${label}`);
      } catch (err) {
        console.error(`[pre-migrate] FAILED: ${label}`, err);
        throw err;
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[pre-migrate] aborting", err);
  process.exit(1);
});
