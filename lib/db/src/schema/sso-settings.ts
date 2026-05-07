import { pgTable, text, boolean } from "drizzle-orm/pg-core";

// Single-row table (key='global') holding the Kerberos / SPNEGO ("Sign in
// with Windows") configuration. The keytab and krb5.conf are stored as
// PEM-style text/base64 in the database so they survive container
// recreation; the api entrypoint script materialises them onto disk and
// points KRB5_KTNAME / KRB5_CONFIG at the resulting files.
export const ssoSettingsTable = pgTable("sso_settings", {
  key: text("key").primaryKey().default("global"),

  // Master toggle. When false, the /auth/sso endpoint always returns 404
  // and the "Sign in with Windows" button on the login page is hidden.
  enabled: boolean("enabled").notNull().default(false),

  // The service principal the API server presents during the SPNEGO
  // handshake — usually `HTTP/<external-host>@<REALM>`. Must match the
  // SPN registered against the AD service account that owns the keytab
  // (`setspn -A HTTP/host.corp.local svc-changemgmt`). Browsers compute
  // this from the URL hostname, so the URL the user types must resolve
  // to the same hostname that's in the SPN.
  servicePrincipal: text("service_principal").notNull().default(""),

  // Base64-encoded keytab file containing the long-term key for
  // `servicePrincipal`. Generated on the AD side with `ktpass` (Windows)
  // or `ktutil` (Linux) and uploaded via the admin Settings UI. Stored
  // in the DB so a fresh container can recover it without an out-of-band
  // file mount.
  keytabB64: text("keytab_b64"),

  // Optional krb5.conf contents. For most AD deployments the defaults
  // baked into the container are enough, but admins occasionally need to
  // pin specific KDCs / disable weak enctypes / set `dns_lookup_kdc =
  // true`. Empty string means "use the file shipped in the image".
  krb5Conf: text("krb5_conf").notNull().default(""),

  // When true, a successful SPNEGO bind for `alice@CORP.LOCAL` is mapped
  // onto the local username `alice`. When false, the full principal is
  // used verbatim (`alice@CORP.LOCAL`). Default ON because that's what
  //99% of installations want — it lines the user up with their LDAP
  // sAMAccountName.
  stripRealm: boolean("strip_realm").notNull().default(true),

  // Email domain appended to the username when auto-provisioning a new
  // user from a successful SSO bind. Only used if no LDAP settings are
  // configured to look up `mail`. e.g. "corp.local" → "alice@corp.local".
  defaultEmailDomain: text("default_email_domain").notNull().default(""),

  // When true, a successful SPNEGO bind for an unknown user creates a
  // local user record on the fly (mirrors the LDAP self-registration
  // path). When false, the user must be pre-provisioned (admin creates
  // them first) or the SSO attempt is rejected with a clear error.
  autoCreateUsers: boolean("auto_create_users").notNull().default(true),
});
