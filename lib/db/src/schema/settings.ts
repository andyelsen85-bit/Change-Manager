import { pgTable, text, boolean, integer, timestamp } from "drizzle-orm/pg-core";

// Single-row tables (key = constant 'global').
export const smtpSettingsTable = pgTable("smtp_settings", {
  key: text("key").primaryKey().default("global"),
  host: text("host").notNull().default(""),
  port: integer("port").notNull().default(587),
  secure: boolean("secure").notNull().default(false),
  username: text("username").notNull().default(""),
  passwordEnc: text("password_enc"),
  fromAddress: text("from_address").notNull().default(""),
  fromName: text("from_name").notNull().default("Change Management"),
  enabled: boolean("enabled").notNull().default(false),
  // When false, skip TLS certificate validation when sending mail. Useful
  // for internal/legacy SMTP relays with self-signed certificates.
  // Default true (verify). Surfaced in the admin UI with a warning.
  tlsRejectUnauthorized: boolean("tls_reject_unauthorized").notNull().default(true),
  // Optional PEM-encoded CA certificate appended to Node's trust store for
  // the SMTP TLS handshake — lets you keep verification ON with an internal CA.
  caCertPem: text("ca_cert_pem"),
});

export const ldapSettingsTable = pgTable("ldap_settings", {
  key: text("key").primaryKey().default("global"),
  enabled: boolean("enabled").notNull().default(false),
  url: text("url").notNull().default(""),
  bindDn: text("bind_dn").notNull().default(""),
  bindPasswordEnc: text("bind_password_enc"),
  baseDn: text("base_dn").notNull().default(""),
  userFilter: text("user_filter").notNull().default("(uid={{username}})"),
  usernameAttr: text("username_attr").notNull().default("uid"),
  emailAttr: text("email_attr").notNull().default("mail"),
  nameAttr: text("name_attr").notNull().default("cn"),
  tls: boolean("tls").notNull().default(false),
  // When false, the TLS handshake to the directory will accept any
  // server certificate (self-signed, expired, hostname mismatch).
  // Default is true (verify). Disabling is a security trade-off and is
  // surfaced in the admin UI with a warning. Honoured by both
  // ldaps:// and StartTLS code paths in lib/ldap.ts.
  tlsRejectUnauthorized: boolean("tls_reject_unauthorized").notNull().default(true),
  // Optional PEM-encoded CA certificate(s) appended to Node's trust store for
  // the LDAPS / StartTLS handshake. Use this to anchor an internal AD CA.
  caCertPem: text("ca_cert_pem"),
  // Optional PEM-encoded issuer (intermediate) certificate completing the chain.
  issuerCertPem: text("issuer_cert_pem"),
});

export const sslSettingsTable = pgTable("ssl_settings", {
  key: text("key").primaryKey().default("global"),
  certificatePem: text("certificate_pem"),
  privateKeyPem: text("private_key_pem"),
  chainPem: text("chain_pem"),
  forceHttps: boolean("force_https").notNull().default(false),
  hstsEnabled: boolean("hsts_enabled").notNull().default(false),
});

// Notification batching configuration. Single-row table (key='global').
// `batchIntervalMinutes` controls how often the worker drains the queue;
// `lastRunAt` is updated by the worker after each run so the UI can show
// "next send in N minutes". Defaults to a 15-minute interval which empirically
// balances responsiveness against email volume for a small change-mgmt team.
export const notificationSettingsTable = pgTable("notification_settings", {
  key: text("key").primaryKey().default("global"),
  batchIntervalMinutes: integer("batch_interval_minutes").notNull().default(15),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
});

export const workflowTimeoutsTable = pgTable("workflow_timeouts", {
  key: text("key").primaryKey().default("global"),
  approvalReminderHours: integer("approval_reminder_hours").notNull().default(24),
  approvalEscalationHours: integer("approval_escalation_hours").notNull().default(48),
  cabReminderHours: integer("cab_reminder_hours").notNull().default(24),
  pirDueDays: integer("pir_due_days").notNull().default(7),
  emergencyApprovalMinutes: integer("emergency_approval_minutes").notNull().default(60),
});
