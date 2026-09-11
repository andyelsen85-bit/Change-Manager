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
  fromName: text("from_name").notNull().default("Change-it"),
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

// OpenID Connect settings for Microsoft AD FS. The client secret is encrypted
// by the API before it is written; the CA is certificate material only.
export const adfsSettingsTable = pgTable("adfs_settings", {
  key: text("key").primaryKey().default("global"),
  enabled: boolean("enabled").notNull().default(false),
  displayName: text("display_name").notNull().default("Sign in with AD FS"),
  issuer: text("issuer").notNull().default(""),
  discoveryUrl: text("discovery_url").notNull().default(""),
  clientId: text("client_id").notNull().default(""),
  clientSecretEnc: text("client_secret_enc"),
  redirectUri: text("redirect_uri").notNull().default(""),
  scopes: text("scopes").notNull().default("openid profile email"),
  usernameClaim: text("username_claim").notNull().default("upn"),
  emailClaim: text("email_claim").notNull().default("email"),
  displayNameClaim: text("display_name_claim").notNull().default("name"),
  caCertPem: text("ca_cert_pem"),
});

// One short-lived, hashed row per OIDC authorization attempt. Consuming this
// row with a guarded update gives replay protection across API instances.
export const adfsAuthTransactionsTable = pgTable("adfs_auth_transactions", {
  stateHash: text("state_hash").primaryKey(),
  configFingerprint: text("config_fingerprint").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
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

// Standard-template promotion. Single-row table (key='global').
// `promotionThreshold` = how many NORMAL changes linked to a disabled
// template must reach status 'completed' before the CAB is flagged that the
// template is a candidate for being enabled as a standard change.
export const templateSettingsTable = pgTable("template_settings", {
  key: text("key").primaryKey().default("global"),
  promotionThreshold: integer("promotion_threshold").notNull().default(5),
});

// ManageEngine ServiceDesk Plus (on-premises) integration. Single-row table
// (key='global'). The technician key is encrypted at rest like other secrets.
// `webhookSecret` authenticates inbound webhook calls from SD+ custom triggers;
// the lastWebhook* columns let the admin UI confirm the webhook path works.
export const sdpSettingsTable = pgTable("sdp_settings", {
  key: text("key").primaryKey().default("global"),
  enabled: boolean("enabled").notNull().default(false),
  baseUrl: text("base_url").notNull().default(""),
  technicianKeyEnc: text("technician_key_enc"),
  webhookSecret: text("webhook_secret").notNull().default(""),
  tlsRejectUnauthorized: boolean("tls_reject_unauthorized").notNull().default(true),
  // SD+ status name applied to the originating request right after a change
  // is created from it (e.g. "Waiting for Change-it"). Must exist in SD+
  // (Admin → Helpdesk Customizer → Request Status). Empty = skip the update.
  onCreateStatusName: text("on_create_status_name").notNull().default("Waiting for Change-it"),
  lastWebhookAt: timestamp("last_webhook_at", { withTimezone: true }),
  lastWebhookRequestId: text("last_webhook_request_id"),
  lastWebhookStatus: text("last_webhook_status"),
});
