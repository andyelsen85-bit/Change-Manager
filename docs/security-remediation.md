# Security remediation assessment and compliance matrix

This document records the remediation assessment for the Change-it baseline.
It is not a declaration of full production compliance. A source change,
documentation statement, or workflow definition is not evidence that CI,
production configuration, a database migration, or an owner decision has
actually been exercised.

## Assessment

The repository contains a pinned GitHub Actions workflow exporting the three
Dockerfile targets (`builder`, `api`, and `web`) as gzip Docker archives,
checksums, and commit metadata. On 2026-09-15 the owner selected downloadable
artifacts instead of direct Nexus pushes because no internal runner exists.
Jobs use GitHub-hosted Ubuntu runners and require no registry credentials.
Canonical release tags are still validated against both package versions.
Artifacts are retained for seven days; controlled long-term storage and
optional internal Nexus promotion are operator responsibilities.

Successful build/download/load and any manual Nexus promotion still require
observed evidence. No sibling Nemesys
workflow was available for comparison, and no claim is made that this
workflow matches unknown CI behavior.

The implementation now includes:

- authentication through PostgreSQL-backed
  `express-session` rows with a 12-hour lifetime, session-ID regeneration on
  authentication, logout row deletion, fresh account checks and generation-based
  central revocation across replicas;
- encryption no longer has a silent `APP_ENCRYPTION_KEY` to `JWT_SECRET`
  fallback and production secret handling requires at least 32 random bytes;
- bounded authentication throttling/lockout and generic external error
  responses, with production error logs limited to safe diagnostic fields.
  Every pre-authentication attempt atomically reserves both a normalized,
  SHA-256 identity bucket (a five-attempt cycle with progressive
  1/5/15/30-minute locks for strike levels 1–4) and a separate per-source-IP
  aggregate window (approximately 60 attempts per minute). Active locks
  never extend from blocked traffic; an expired identity lock permits one
  retry and retains its strike level for the next five-attempt cycle, while a
  quiet 24-hour period resets that level. Successful authentication clears
  only its identity bucket, not the shared IP aggregate.
- backup protection follows the mandatory external age-encryption procedure
  in [Backup security](backup-security.md); and
- broad authenticated visibility of standard change/CAB data remains the
  current product policy, explicitly reconfirmed by the project owner on
  2026-09-15. Edit permissions and pentest restrictions remain unchanged.

MFA and Kerberos are outside this remediation scope. AD FS/OIDC is documented
separately and is not evidence that MFA is provided by this application.

## Required actions before marking green

1. Retain successful hosted-run URLs, download and checksum all three target
   archives, and verify image loading on the approved Docker host.
2. For optional internal Nexus promotion, confirm the transfer host trusts
   the authentic CA and Nexus enforces immutable version/SHA tags.
3. Apply and verify the PostgreSQL session schema against the externally
   managed production database; test expiration, ID regeneration, logout
   deletion, and revocation from every replica.
4. Before deploy, preserve the exact existing encryption material. Never
   silently replace it. Test decrypting existing SMTP/LDAP values after
   setting the explicit key.
5. Verify all generated/provided production secrets are at least 32 random
   bytes and that startup rejects missing or short values.
6. Run authentication rate-limit, error-hygiene, backup age-encryption,
   restore, and rollback tests. Keep backup keys and application encryption
   keys separate and recoverable.
7. **Owner confirmation completed on 2026-09-15.** The project owner answered
   “Yes, confirm the existing visibility policy” to the explicit question
   about all authenticated users continuing to view organization-wide
   change-management and CAB data. This confirms existing read visibility
   only; edit permissions and pentest restrictions remain unchanged.

## Verification performed

API and frontend typechecks and builds passed. Focused tests cover session
generation, missing session middleware, proxy-header handling, AD FS session
integration, secret validation and encryption independence, safe errors, and
transactional restore invalidation. Shell generation checks verify explicit
fresh-install acknowledgement and no silent replacement of existing keys.

One browser pass against the development app verified local UI login, exact
deep-link return, PostgreSQL session persistence across reloads, CSRF rejection
without logout, successful logout and old-cookie replay rejection, account
generation revocation and subsequent login, and the backup warning. Only a
disposable account was changed and it was removed afterward. No real
LDAP/AD FS/SMTP calls or existing-data restore were performed.

The failing existing business-test suites were compared against the
pre-remediation code using the same installed dependencies. Twelve failures
already existed in change creation/transition, comment permissions, and
notification-preference tests. Obsolete JWT test fixtures and the intentional
structured-logging expectation changes are updated separately.

See [Additional scan findings](security-scan-findings.md) for the dependency,
static-analysis and privacy scan results. The dependency advisories require
separate remediation and preclude a repository-wide vulnerability-free claim.

## Compliance matrix

**Passed** means implemented and checked within the stated development/source
scope. **Partially Passed** means implementation or documentation exists but
operational evidence or owner approval is still needed. These statuses do not
assert that the changes have been deployed.

| Baseline control | Status | Evidence / remaining action |
| --- | --- | --- |
| Container images built by GitHub Actions | Partially Passed | Hosted-runner archive workflow implemented; retain successful build and load evidence. Sibling workflow unavailable for comparison. |
| Nexus runner reachability and trusted private CA | Not Applicable | CI exports archives without connecting to Nexus. CA/reachability checks remain required on any internal manual-promotion host. |
| Version tag matches API and web package versions | Passed | Strict canonical SemVer and package match validation implemented; actual release execution still part of CI verification. |
| Immutable release and full-SHA image tags | Partially Passed | Tags emitted by workflow; Nexus overwrite policy and resulting digests need operational verification. |
| Session architecture | Passed | PostgreSQL sessions, fixed 12h TTL, regeneration, logout deletion, fresh identity/generation checks. Browser persistence/replay/revocation checks passed. Production rollout still required. |
| Encryption-key fallback | Passed | Removed, with independence and failure tests. Preserve and verify existing production ciphertext key before rollout. |
| Secret minimum length | Passed | Startup validation and explicit fresh-install generation tests passed; operators must supply genuinely random production material. |
| Rate limiting / brute-force protection | Passed | Pre-auth shared PostgreSQL admission controls cover local/LDAP; bounded inputs and proxy trust prevent trivial bypass. No live LDAP bind test performed. |
| Error message hygiene | Passed | Generic client errors and production allowlisted error logging; provider/backup and credential-redaction regression tests. |
| Backup encryption in transit/at rest | Partially Passed | Mandatory external encryption alternative implemented in UI/docs. Actual operator encryption, HTTPS configuration, retention and recovery drills remain operational controls. |
| Ready acceptance of broad authenticated visibility | Passed | Project owner explicitly reconfirmed existing organization-wide authenticated change/CAB read visibility on 2026-09-15. Edit permissions and pentest restrictions remain unchanged. |
| Local password hashing (bcrypt) | Passed | Preserved; local browser login and unit tests passed. |
| AD FS/OpenID Connect security controls | Partially Passed | Protocol code preserved and automated tests pass; real IdP authentication after migration not verified here. |
| CSRF protection | Passed | Existing scheme preserved; browser rejected logout without CSRF and accepted normal UI logout. |
| Immutable audit log | Passed | Existing database trigger enforcement preserved; development schema bootstrap completed. Production migration must retain it. |
| Written threat model | Passed | Updated for new session, secret, backup and CI boundaries; owner visibility confirmation recorded on 2026-09-15. |
| No default admin password | Passed | Existing setup requirement preserved and setup tests pass. |
| Production external PostgreSQL | Passed | Documented per supplied deployment baseline; bundled Compose database explicitly local/test only. No production connection was inspected or changed. |
| MFA | Not Applicable | Explicitly out of scope; not inferred from AD FS/OIDC. |
| Kerberos | Not Applicable | Explicitly out of scope. |

If a second image source or mirror is later confirmed, add an equivalent
digest-preserving mirror verification step to the evidence; do not claim that
an unknown sibling workflow or CI system has been matched.