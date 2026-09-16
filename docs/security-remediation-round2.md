# Security remediation — Round 2

## Assessment

The uploaded Round 2 plan's four findings were confirmed against the source:

- The backup inventory contained 29 tables; the Drizzle schema exported 36.
  Six missing tables contain persistent data: `attachments`, `adfs_settings`,
  `cab_attendees`, `external_changes`, `template_settings`, `discussion_reads`.
- `adfs_auth_transactions` is the remaining schema table. Its hashed OIDC
  state is time-limited and consumed once; it is not configuration or durable
  business data. Like `user_sessions` and `auth_login_throttle` (operational
  bootstrap tables outside the Drizzle exports), it is deliberately excluded
  and cleared during restore.
- README's every-table claim and two permissive-CORS descriptions were false.
  CORS actually uses same-origin/explicit-allowlist decisions.
- ServiceDesk Plus was implemented but lacked README documentation.

## Implemented changes

All **35 persistent tables** are now exported in one repeatable-read snapshot
and restored in dependency order. Reverse deletion order respects dependents.
Binary `bytea` fields are explicitly base64-encoded and decoded to Buffers;
legacy Node Buffer JSON is supported. Invalid encodings fail rather than
silently corrupt attachment content.

Backup **format 3** requires every current table. Legacy formats 1/2 can omit
historically absent tables; those restore empty. Old backups cannot recover
attachments or other records that were never exported. Take a new encrypted
backup after upgrading. Preserve the encryption key for provider secrets.

The schema-coverage test introspects actual exported Drizzle tables and
requires an explicit inventory or exclusion decision. Image publishing
depends on the backup-test job, which also runs restore regression tests
against a disposable PostgreSQL service, never deployment credentials.

README now describes the inventory, exclusions, binary/legacy behavior,
actual CORS policy, and ServiceDesk Plus configuration, header-authenticated
webhooks, idempotency, status mapping and write-back.

## Verification and compliance matrix

Statuses describe this remediation's source and test scope, not a claim that
an operator has restored a production backup or completed a portfolio audit.

| Item | Status | Evidence / boundary |
| --- | --- | --- |
| Six missing persistent tables | Passed | Included in export/restore inventory; row coverage tests. |
| Temporary OIDC-state decision | Passed | Expiry/consume behavior inspected; explicit exclusion and transactional invalidation. |
| Binary attachment transport | Passed | Explicit encoding/decoding with legacy support; JSON round-trip tests. |
| New-backup completeness / old-backup compatibility | Passed | Format 3 requires the full inventory; formats 1/2 retain legacy omissions. |
| Schema drift prevention | Passed | Actual Drizzle export introspection; mandatory CI dependency before image publishing. |
| Isolated PostgreSQL restore | Partially Passed | Automated disposable-database test added; retain a successful CI execution before claiming verified database round-trip. |
| README backup claim | Passed | Inventory count/source and deliberate exclusions documented. |
| README CORS description | Passed | Both stale references replaced; explicit allowlist bullet added. |
| ServiceDesk Plus documentation | Passed | Configuration, webhook security and synchronization documented from source. |
| Session architecture | Passed | Existing generation/username revocation preserved; restore invalidates operational authentication state. |
| Encryption-key independence | Passed | Unchanged. |
| Application-key strength | Passed | Unchanged; database-password policy remains administrator-controlled as requested. |
| Login throttling | Passed | Unchanged. |
| Error hygiene | Passed | Existing safe validation error boundary preserved. |
| Backup encryption | Passed | Mandatory external-encryption alternative preserved; actual operator encryption remains operational. |
| Broad authenticated visibility | Passed | Existing owner confirmation preserved; pentest restrictions unchanged. |
| Password hashing / AD FS / CSRF | Passed | Existing controls unchanged. Live identity-provider verification is outside this change. |
| Immutable audit history | Passed | Production audit protections not weakened by this change. |
| Threat model / no default admin | Passed | Existing controls and documentation retained. |
| Externally managed production PostgreSQL | Passed | Existing deployment boundary preserved; production data not accessed. |
| New MFA, Kerberos, Kubernetes, Helm, ArgoCD | Not Applicable | Explicitly excluded from this remediation. |

Application version remains **2.4.1**; backup-format versioning is separate
from application versioning. No production restore is performed by these changes.