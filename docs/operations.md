# Production operations runbook

This runbook describes the deployment boundaries and the actions an operator
must complete for a production Change-it installation. It deliberately does
not claim that a CI job has run, that a private runner exists, or that an
unconfirmed mirror is available. Record the values and evidence for the
installation in the change ticket; do not put secrets in this repository.

## Deployment boundaries

- Production uses CHdN's externally managed, centrally backed-up and monitored
  PostgreSQL service supplied by the deployment baseline. Set `DATABASE_URL`
  to that service and complete the approved schema bootstrap/migration before
  starting the API.
- The `db` service in `docker-compose.yml` is a local/test convenience only.
  It is not the production database and must not be used as a production
  backup, failover, or data-retention strategy.
- No Kubernetes, Helm, or Argo deployment is defined by this repository.
  Production operators should use the approved host/container process for the
  target environment.
- TLS termination and the private Nexus CA are infrastructure responsibilities.
  Do not copy private CA material into the image or frontend.

## CI image publishing (FIX1)

`.github/workflows/build-images.yml` publishes the `builder`, `api`, and `web`
Dockerfile targets to the configured Nexus repository on pushes to `main` and
on canonical semantic version tags (`vX.Y.Z` or `X.Y.Z`, with an optional
valid prerelease such as `-rc.1`). SemVer build metadata (`+build`) is
rejected with a clear validation error because `+` is not compatible with the
Docker image tag emitted by the workflow. It creates:

- `main` for the moving main-branch channel;
- the normalized release version (for example `2.3.4`) for a validated version
  tag; and
- `sha-<full Git commit SHA>` for every build.

The workflow's default registry is
`srvnexusint.hopital.chdn.lan:6443/infra`, matching the verified destination
used by `update.sh`. A confirmed alternative may be selected with the
`CONTAINER_REGISTRY` repository variable, but it must be a
`host[:port]/repository` value. Set `RUNNER_LABEL` if the approved private
self-hosted runner uses a label other than the explicit `self-hosted`
default. The default is not evidence that a runner with that label exists.

Before enabling a run, an administrator must:

1. Register the approved self-hosted runner with the repository and confirm
   that it has Docker Engine, Buildx, Node.js, and `curl`.
2. Give the runner DNS and firewall reachability to the Nexus host.
3. Install the authentic Nexus CA in the runner's OS trust store (for example,
   through the platform's approved CA package process) and in Docker's
   `/etc/docker/certs.d/<host:port>/ca.crt` trust directory, then restart the
   Docker service as required. The workflow intentionally does not use
   `--insecure`; its TLS preflight must fail if the CA is not trusted.
4. Configure the `NEXUS_USERNAME` and `NEXUS_PASSWORD` GitHub Actions secrets
   with the least-privileged push account. Do not echo, commit, or place these
   values in image layers.
5. Configure Nexus tag policy before the first production push. Version tags
   and `sha-<full SHA>` tags must reject overwrites. The full SHA tag is the
   immutable content identifier used for promotion and rollback. The `main`
   tag is intentionally a moving branch pointer; if the Nexus policy cannot
   express immutable release/SHA tags alongside a moving pointer, use the
   approved separate channel/repository rather than weakening release
   immutability.
6. Treat only an observed completed workflow run and its recorded pushed digest
   as evidence for an image promotion. This document does not report a run
   that has not actually been observed.

If an additional image source or mirror is later confirmed by infrastructure
owners, perform an equivalent mirror step: copy the exact target image by
digest from the verified Nexus source, verify the destination digest, and
preserve the immutable `sha-<full SHA>` tag and policy. No such source,
workflow, or sibling CI behavior is asserted here.

## Pre-deploy checklist

1. Confirm the approved image digest for `builder`, `api`, and `web`; do not
   deploy an unverified moving `main` tag when a release/SHA digest is
   available.
2. Confirm the externally managed PostgreSQL endpoint, backup/monitoring
   ownership, and approved schema bootstrap/migration procedure.
3. Take and verify a protected backup according to
   [Backup security](backup-security.md). The export contains sensitive
   operational and account data; it is not safe to leave unencrypted on a
   workstation or in an artifact store.
4. Confirm the preferred `SESSION_SECRET` (or explicitly retained
   compatibility `JWT_SECRET`), `APP_ENCRYPTION_KEY`, database credentials,
   TLS material, and identity-provider credentials are supplied through the
   deployment secret manager. Values must meet the documented minimums; a
   missing or short production secret is a deployment failure.
5. Preserve the exact existing encryption material before changing any
   environment variables. Capture the key identifier/version and a protected
   recovery copy through the approved secret-management process. Never
   silently generate or substitute an encryption key during an upgrade.
6. Apply the session schema/bootstrap (including the `user_sessions` table)
   to the production PostgreSQL database before the API rollout. Confirm the
   session table is writable by the API role and included in the database
   backup/restore plan.
7. Roll out all API replicas from the same configuration. Do not leave a
   replica on an old session or key configuration.

## Session migration and revocation

The target session design is `express-session` with a PostgreSQL-backed table:

- sessions expire after 12 hours;
- authentication regenerates the session ID;
- logout destroys the server-side row; and
- revocation is central because every replica reads the shared PostgreSQL
  store.

During the migration from the former stateless cookie design, plan a
one-time logout of all users after all replicas run the new code. Invalidate
old client cookies and communicate the reauthentication window. Verify that
logout removes the row and that a request using a revoked session fails at
every replica; do not claim central revocation from a single-node test.

The session table is not a substitute for the application database backup.
Include it in the approved PostgreSQL backup scope and protect it with the
same access controls.

## Secret and encryption-key rotation

`APP_ENCRYPTION_KEY` is independent of `JWT_SECRET` and must be at least
32 random bytes in production. It protects values such as encrypted SMTP and
LDAP credentials. A deployment must fail rather than fall back to a different
secret or silently create a replacement key.

Before deploying the no-fallback configuration:

1. Identify the exact key that encrypted existing rows and preserve it in the
   approved secret manager under a versioned name.
2. If the older deployment used the `JWT_SECRET` fallback, its `enc:v1`
   ciphertext was derived from the exact UTF-8 text of that secret using
   HKDF-SHA256 with empty salt and the `change-mgmt:secret-v1` context.
   This derivation is unchanged. If the old value passes the new strength
   validation, explicitly configure that exact text as `APP_ENCRYPTION_KEY`
   through the approved secret manager, and independently generate a new
   `SESSION_SECRET`. Do not substitute a decoded hex/base64 value or a
   pre-derived AES key. Verify decryption of representative SMTP, LDAP,
   AD FS and ServiceDesk settings before releasing the deployment.
   If the old material is below the new minimum, stop: preserve the old
   deployment and encrypted backup, then arrange controlled re-encryption
   with the old and new keys or recovery of the original provider credentials.
   Do not work around startup validation, discard ciphertext, or simply
   replace the key. Once migration is verified, remove an obsolete
   `JWT_SECRET` compatibility setting/file according to the rollback policy.
3. Keep the old key available for the documented rollback window. Do not
   overwrite or delete it until restored data and application rollback have
   been tested.
4. Rotate session/authentication secrets only as a deliberate operation. A
   rotation invalidates sessions; with the server-side session migration,
   perform the planned one-time logout/all-replica check rather than relying
   on an accidental cookie failure.

Never print secret values in logs, shell history, CI output, backup files, or
change tickets.

## Local/test secret bootstrap

Fresh key generation is permitted only for an explicitly requested new
local/test installation with no `.env` file:

```bash
./scripts/init-env.sh --fresh-install
```

The normal invocation must fail safe. If an `.env` already exists but a
required key is absent, weak, or unknown, do not generate a replacement and
do not start the deployment. Restore the exact existing key material from the
approved secret manager/recovery record first, especially
`APP_ENCRYPTION_KEY`, then rerun validation. Production should receive keys
from its approved secret manager rather than this bootstrap script. The
`up.sh` convenience wrapper is not authorization to rotate or invent
production keys.

## Schema bootstrap, backup, and rollback

The production database is externally managed. Coordinate schema changes with
the database owner, run the approved bootstrap/migration against that
endpoint, and verify the session table and audit immutability constraints
before traffic is enabled. The local Compose `db` container can validate a
developer procedure but cannot prove production readiness.

Before a destructive restore or rollback:

- verify the backup decrypts with the mandatory external age procedure;
- record the source image digest and database schema/application versions;
- preserve the exact `APP_ENCRYPTION_KEY` and other recovery secrets;
- understand that restoring application data without the matching encryption
  material can make encrypted settings unrecoverable; and
- use a maintenance window and the approved external PostgreSQL restore
  controls. A restore is not a substitute for a tested rollback plan.

After rollback, verify health, login, session-row creation/destruction,
encrypted settings decryption, audit-trigger enforcement, and all replicas.

## Operational evidence and open confirmations

For each production change, retain the workflow run URL and image digests,
runner/CA readiness evidence, schema migration result, backup verification,
key-preservation record, and post-deploy checks. The security remediation
matrix remains pending until those artifacts, CI execution, and the business
owner's access-model confirmation are available. See
[Security remediation assessment](security-remediation.md) and the
[threat model](../threat_model.md).