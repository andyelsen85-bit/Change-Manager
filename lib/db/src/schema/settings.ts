import { pgTable, text, boolean, integer } from "drizzle-orm/pg-core";

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
});

export const sslSettingsTable = pgTable("ssl_settings", {
  key: text("key").primaryKey().default("global"),
  certificatePem: text("certificate_pem"),
  privateKeyPem: text("private_key_pem"),
  chainPem: text("chain_pem"),
  forceHttps: boolean("force_https").notNull().default(false),
  hstsEnabled: boolean("hsts_enabled").notNull().default(false),
});

export const workflowTimeoutsTable = pgTable("workflow_timeouts", {
  key: text("key").primaryKey().default("global"),
  approvalReminderHours: integer("approval_reminder_hours").notNull().default(24),
  approvalEscalationHours: integer("approval_escalation_hours").notNull().default(48),
  cabReminderHours: integer("cab_reminder_hours").notNull().default(24),
  pirDueDays: integer("pir_due_days").notNull().default(7),
  emergencyApprovalMinutes: integer("emergency_approval_minutes").notNull().default(60),
});
