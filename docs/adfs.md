# AD FS / OpenID Connect authentication

Change-it can use Microsoft AD FS as an additional sign-in method. It does not
replace local-password or LDAP sign-in, and it does not change the application's
session model. AD FS is an optional integration: leave all `ADFS_*` values
empty when it is not being used.

This guide is for the Change-it deployment in this repository:

- The Express API runs on port `8080` behind the Nginx web container.
- The React SPA and API are normally same-origin; the browser reaches the API
  under `/api`.
- PostgreSQL 16 and Drizzle are used for persisted settings.
- The normal application session is the `cm_session` HttpOnly cookie. AD FS
  tokens are used only while completing the sign-in transaction and are not
  stored by Change-it.
- Local users and LDAP users remain available. AD FS does **not** auto-provision
  an account in this project: the identity must resolve to an existing,
  enabled user row.

## Requirements and security boundaries

### AD FS and OIDC

Use AD FS on **Windows Server 2019 or later**. This application requires
PKCE, and Microsoft's [AD FS OIDC/OAuth flows and application
scenarios](https://learn.microsoft.com/en-us/windows-server/identity/ad-fs/overview/ad-fs-openid-connect-oauth-flows-scenarios#proof-key-for-code-exchange-pkce-support-for-oauth)
documentation states that AD FS supports PKCE starting with Windows Server
2019; it also says the `code_verifier` token-request option applies to AD FS
2019 and later. Microsoft's broader [OIDC/OAuth concepts
page](https://learn.microsoft.com/en-us/windows-server/identity/ad-fs/development/ad-fs-openid-connect-oauth-concepts)
covers AD FS 2016 and later, but that does not establish the PKCE capability
required here. AD FS 2016 is therefore not a supported baseline for this
integration unless it is upgraded to a PKCE-capable release.

The AD FS installation must provide standards-compliant OpenID Connect
discovery, Authorization Code flow, PKCE with `S256`, signed ID tokens, and
JWKS key discovery. Keep AD FS and Windows Server fully patched and confirm
that OIDC is enabled by checking the discovery document before registering
the application. The discovery document must contain HTTPS authorization,
token, issuer, and JWKS endpoints.

The application must have a stable public HTTPS origin. A reverse proxy may
terminate TLS, but it must preserve the original host and scheme in the
forwarded headers that reach the API. Do not register a preview, internal
container name, IP address, or an HTTP URL as the production callback.

AD FS HTTPS certificate validation is always enabled. A private/internal CA
may be supplied as described in [Internal CA certificates](#internal-ca-certificates),
but it is appended to Node.js's normal trusted roots. It does not replace
public roots. Never use `NODE_TLS_REJECT_UNAUTHORIZED=0`, an
`https.Agent` with `rejectUnauthorized: false`, or an equivalent workaround.
Do not use `DISABLE_TLS=true` for an AD FS-enabled production deployment.

### Users and authorization

The project-specific provisioning policy is **match existing enabled users
only**:

1. The configured username claim (default `upn`) is normalized and matched to
   an existing `users.username`.
2. If that does not identify one user, the configured email claim (default
   `email`) is normalized and matched to `users.email`.
3. A missing, ambiguous, conflicting, disabled (`is_active = false`), or
   otherwise unusable account fails safely with a user-facing sign-in error.

The integration must not silently merge accounts, create a new account, grant
administrator status, or derive application roles from AD FS claims. The
matched row supplies the existing `is_admin`, source, and role assignments.
Normal Change-it access checks still apply after the application session is
created.

### Token and session handling

The callback performs all of these checks before creating a Change-it session:

- OIDC discovery and HTTPS endpoint validation.
- Cryptographically random, short-lived, signed state and a matching
  HttpOnly state cookie.
- PKCE `S256` verifier/challenge and one-time authorization-code exchange.
- A cryptographically random nonce, checked against the validated ID token.
- JWKS signature, issuer, audience/client ID, time, and token-expiry
  validation.
- Safe handling of provider errors and replayed or substituted responses.

Access tokens, refresh tokens, ID tokens, authorization codes, client secrets,
and full sensitive claim sets are never persisted or logged. After validation,
Change-it creates its normal application session. The session keeps its
existing 12-hour lifetime and secure cookie settings; AD FS does not extend it
by storing a provider token.

## Registering the AD FS application

### 1. Choose the public callback URL

Let `<public-origin>` be the real externally reachable HTTPS origin of this
Change-it installation, including its non-default port if one is in use. The
redirect URI is:

```text
https://<public-origin>/api/auth/adfs/callback
```

For example, `https://changes.example.invalid` below is deliberately a
documentation placeholder, not a deployment hostname:

```text
https://changes.example.invalid/api/auth/adfs/callback
```

Register the URI exactly in AD FS, including scheme, host, path, and port.
Avoid a trailing-slash variation unless the application is configured with
that exact URI. Set `ADFS_REDIRECT_URI` or the saved `redirectUri` setting to
this exact value. This implementation has no configured public-URL setting
from which to derive a redirect URI, so an explicit redirect URI is required;
it is never derived from an unsigned `returnTo` value or an arbitrary request
host.

### 2. Register an OIDC client

In the AD FS application group/client registration:

1. Create an OIDC client for this Change-it origin.
2. Enable Authorization Code flow and PKCE. Require `S256`, not `plain`.
3. Add the exact callback above as the only Change-it redirect URI.
4. Record the generated client ID.
5. Select one of the client types below.

Do not use a client registration intended to call a separate protected API.
Change-it only needs identity sign-in; it does not request
`user_impersonation`.

### 3. Public PKCE client (no secret)

A public client is appropriate when the AD FS registration has no usable
client secret:

- Leave the client secret empty; do not put a placeholder secret in the
  deployment.
- Set `ADFS_CLIENT_ID` and the issuer/discovery values.
- The authorization request contains a fresh PKCE challenge.
- The token request contains `code_verifier` but **does not contain
  `client_secret`**.

If changing an existing confidential registration to public, clear the stored
secret explicitly through the AD FS settings form/API with
`"clientSecret": null`. Omitting the field means “keep the current value,”
not “make this client public.”

### 4. Confidential client (optional secret)

A confidential client is appropriate when AD FS issues a secret to the
server-side application:

- Store the secret only in an API deployment secret or in the administrator
  settings form; never put it in frontend/Vite variables.
- The API encrypts a configured secret at rest using the existing
  `APP_ENCRYPTION_KEY` facility (falling back to `JWT_SECRET` as documented in
  the main README).
- The secret is sent only by the server during the token exchange. It is
  never returned by the settings API and never written to logs or audit
  snapshots.
- Rotate it at AD FS and Change-it together. Send a new non-empty
  `clientSecret` to replace it; send `null` to clear it.

## Required claims and scopes

Use these defaults unless the AD FS tenant has a documented claim naming
scheme:

| Purpose | Default claim | Requirement |
| --- | --- | --- |
| Stable OIDC identity | `sub` | Required from the validated ID token; AD FS supplies it. |
| Change-it username | `upn` | Recommended and the default matching claim. |
| Email | `email` | Recommended; used as the safe matching fallback. |
| Display name | `name` | Recommended; used for the session/user display name. |

Configure the claim fields through the settings API/UI if the outgoing AD FS
claim names differ. The values in the ID token must be the claims named by the
settings, not merely similarly named claims in the directory.

Recommended AD FS issuance mappings are:

| Directory value | OIDC claim emitted to Change-it |
| --- | --- |
| `userPrincipalName` | `upn` |
| `mail` (or the approved directory email attribute) | `email` |
| `displayName` (or the approved directory display attribute) | `name` |

Preserve AD FS's stable `sub` claim. In AD FS, implement these mappings as
issuance transform rules for the registered OIDC client and verify the
resulting ID token with a token inspection tool that does not upload
production tokens. Do not put the token or its contents in a ticket, log, or
browser storage.

Request these scopes:

```text
openid profile email
```

`openid` is mandatory for OIDC and ID-token issuance. `profile` and `email`
are recommended for the configured `name` and `email` claims. Do **not**
request `user_impersonation`: Change-it does not call a separate AD
FS-protected Web API, and that permission expands the registration without
providing a sign-in benefit.

## Configure Change-it

### Environment fallbacks

The root `.env.example` contains empty, safe placeholders for every AD FS
variable. Copy it to `.env` and keep `.env` private (`scripts/init-env.sh`
sets mode `0600` when it creates the file). Do not commit a populated `.env`,
client secret, or CA certificate.

| Variable | Meaning | Empty/default behavior |
| --- | --- | --- |
| `ADFS_ENABLED` | Enables the AD FS button and flow when configuration is valid. | Disabled. |
| `ADFS_DISPLAY_NAME` | Optional login button label. | `Sign in with AD FS`. |
| `ADFS_ISSUER` | Expected OIDC issuer/authority URL. | Must be supplied by the stored settings or deployment. |
| `ADFS_DISCOVERY_URL` | OIDC discovery URL, when it is not derived from the issuer. | Derived/used from issuer when supported by the deployment. |
| `ADFS_CLIENT_ID` | Registered AD FS client ID. | AD FS is not usable until supplied. |
| `ADFS_CLIENT_SECRET` | Optional confidential-client secret. | Public PKCE exchange; no secret is sent. |
| `ADFS_REDIRECT_URI` | Explicit public callback URI. | Required for AD FS to be usable; no current-URL derivation is performed. |
| `ADFS_SCOPES` | Space-delimited OIDC scopes. | `openid profile email`. |
| `ADFS_USERNAME_CLAIM` | Username/UPN claim name. | `upn`. |
| `ADFS_EMAIL_CLAIM` | Email claim name. | `email`. |
| `ADFS_DISPLAY_NAME_CLAIM` | Display-name claim name. | `name`. |
| `ADFS_CA_CERT_PEM` | Optional PEM CA certificate/chain for AD FS HTTPS. | Node's normal trusted roots only. |

These are **API-server** variables. A value in the repository root `.env` is
not automatically visible inside an arbitrary container; the `api` service
must receive the variables through its deployment environment. In the
repository's Docker Compose stack the relevant values belong on the `api`
service, not in the `web` image or a `VITE_*` variable. When using an external
secret manager, inject the same names into the API container.

### Stored settings take precedence

The administrator settings row is the authoritative configuration once it
exists. The precedence is:

1. A saved database setting row, including `false`, an empty optional value,
   or an explicit clear, wins.
2. If no saved settings row exists, the corresponding `ADFS_*` environment
   fallback is used.
3. Built-in defaults are used last (`openid profile email`, `upn`, `email`,
   and `name`).

In particular, clearing a stored client secret or CA does not silently
re-enable an old environment value. This makes it possible to switch from a
confidential to a public client and to remove an internal CA intentionally.
Environment changes require the API process/container to be restarted; saved
settings invalidate the relevant discovery/JWKS/HTTP caches when changed.

### Settings API contract

Both endpoints are under the API's existing cookie/session security model and
are administrator-only:

```text
GET /api/settings/adfs
PUT /api/settings/adfs
```

`GET` returns configuration suitable for the Settings page:

```json
{
  "enabled": false,
  "displayName": "Sign in with AD FS",
  "issuer": "",
  "discoveryUrl": "",
  "clientId": "",
  "secretConfigured": false,
  "redirectUri": "",
  "scopes": "openid profile email",
  "usernameClaim": "upn",
  "emailClaim": "email",
  "displayNameClaim": "name",
  "caConfigured": false
}
```

The exact response may include an equivalent `clientSecretConfigured` or
`caCertConfigured` boolean, but it must not include `clientSecret` or the
complete `caCertPem`. The CA is public certificate material, yet returning it
unnecessarily increases exposure and is not needed to show configuration
status.

`PUT` accepts the same ordinary fields plus these write-only fields:

```json
{
  "enabled": true,
  "displayName": "Sign in with AD FS",
  "issuer": "https://adfs.example.invalid/adfs",
  "discoveryUrl": "https://adfs.example.invalid/adfs/.well-known/openid-configuration",
  "clientId": "<registered-client-id>",
  "redirectUri": "https://changes.example.invalid/api/auth/adfs/callback",
  "scopes": "openid profile email",
  "usernameClaim": "upn",
  "emailClaim": "email",
  "displayNameClaim": "name",
  "clientSecret": null,
  "caCertPem": null
}
```

`<registered-client-id>` and the hostnames above are placeholders; replace
them with values owned by the deployment. For `clientSecret` and `caCertPem`:

- omitted means **leave the currently stored value unchanged**;
- a non-empty string replaces the current value;
- JSON `null` explicitly clears the current value.

The API validates a replacement CA value as a PEM certificate/chain before
saving it. `clientSecret` is encrypted before persistence. Neither value is
returned by `GET`, exposed in errors, or included in audit output.

Use the Settings page where possible. A direct browser `PUT` must include
credentials and the existing `X-CSRF-Token` header matching the `cm_csrf`
cookie. The frontend API helper already uses `credentials: "include"` and
adds the CSRF header for mutating requests. Do not exempt `/api/settings/adfs`
from the global CSRF middleware.

### Internal CA certificates

Use a custom CA only when the AD FS endpoint is signed by an internal
certificate authority that is not already in the Node.js trust store:

1. Obtain the issuing CA certificate or complete CA chain from the PKI team.
   It must be PEM certificate material, not a private key and not the AD FS
   server's private key.
2. In the administrator Settings → AD FS panel, paste or upload the PEM, or
   provide `ADFS_CA_CERT_PEM` as an API-container secret fallback.
3. Save the setting and check that the masked response reports the CA as
   configured.
4. Ensure the AD FS hostname is present in the server certificate's SAN. A CA
   does not make a hostname mismatch valid.

The configured CA extends normal Node.js roots and is used for discovery,
token exchange, and JWKS retrieval. It is not a global process setting and
must not weaken TLS for other outbound requests. Replace or remove it by
submitting a new PEM or `caCertPem: null`; environment-only changes require
an API restart.

## Sign-in, deep links, and logout

### Callback contract

AD FS returns the authorization response to:

```text
GET /api/auth/adfs/callback
```

The callback accepts the provider's `code`, `state`, and error fields. It
trusts neither an unsigned `returnTo` query parameter nor a provider response
whose state cookie, PKCE verifier, nonce, issuer, audience, signature, or
expiry is invalid. It creates the normal `cm_session` and `cm_csrf` cookies
only after every validation succeeds, then redirects to the signed local
return target.

Authentication errors show a safe, actionable message. Authorization codes,
tokens, secrets, raw upstream responses, and complete claims are not shown to
the browser or written to logs.

### Deep links

An unauthenticated visit to a protected local route preserves its path, query
string, and fragment through login. Examples include:

```text
/changes/123
/requests/456?tab=history
/changes/123?tab=planning#approvals
```

The frontend captures the current location (including the fragment, which is
not sent in an HTTP request), validates it as a local path, and the signed
state carries it through AD FS. The callback validates it again before
redirecting. An absent or invalid value falls back to `/`.

Only local application paths are accepted. Reject absolute URLs, protocol
relative values beginning with `//`, backslashes, control characters,
CRLF/header-injection data, malformed encodings, `javascript:` or any other
scheme, and another origin. Never “fix” a rejected value by redirecting to
an external URL.

### Session-expiry reauthentication

On successful AD FS sign-in, the browser may receive the non-sensitive
`cm_login_method=adfs` preference cookie. It is approximately one year,
`SameSite=Lax`, `Secure` in production, and does not contain a token.

When the normal 12-hour application session expires and that preference is
present, the SPA starts AD FS again once per browser tab and preserves the
current local route. A tab-scoped `sessionStorage` marker prevents a redirect
loop if AD FS or the application repeatedly rejects the login. AD FS decides
whether its own SSO session permits silent sign-in; Change-it does not use an
insecure hidden iframe or store provider tokens in localStorage.

Explicit logout keeps the existing Change-it logout semantics, ends the
application session, clears `cm_session` and `cm_csrf`, clears
`cm_login_method`, and does not immediately start AD FS again. The user can
choose another login method from the login page.

## Migration and startup

The AD FS settings persistence and shared replay protection are additive schema
changes. They add the singleton `adfs_settings` table and the short-lived
`adfs_auth_transactions` table. Each authorization attempt stores only a hash
of its state, a configuration fingerprint, expiry, and a consumed timestamp.
An atomic guarded update consumes a transaction once, so replay protection
works across API processes/replicas without storing authorization codes or
tokens. These changes must not rewrite existing `users`, roles, password
hashes, LDAP settings, or sessions, and they must not drop data. Existing
installations are upgraded through the repository's Drizzle startup path:

1. The Compose `db` service becomes healthy.
2. The one-shot `migrate` service runs
   `pnpm --filter @workspace/db run push` (including the repository's
   pre-migration safety step).
3. The `api` service starts only after `migrate` completes successfully.

For a local database, the equivalent command is:

```bash
pnpm --filter @workspace/db run push
```

Take the normal database backup before changing a production installation.
Do not manually delete a pre-existing settings table or user/authentication
rows. If an upgrade is interrupted, fix the migration issue and rerun the
same additive migration; do not bypass it with a destructive or
`--force`-style operation against production.

## Docker deployment in this repository

No production hostname, AD FS authority, client ID, secret, certificate, or
Kubernetes namespace is committed to this repository. Substitute values owned
by the target installation; the names below are the actual repository service
and file names.

### First deployment or a local Docker host

```bash
cp .env.example .env
./scripts/init-env.sh
# Edit .env with deployment-owned PostgreSQL/JWT and ADFS_* values.
docker compose up -d --build
```

`scripts/init-env.sh` creates strong PostgreSQL/JWT values and sets `.env` to
mode `0600`; it does not invent AD FS details. `scripts/up.sh` is the
repository wrapper that bootstraps a missing `.env`, runs
`docker compose up -d --build`, and follows logs. Do not overwrite an
existing production `.env` with `.env.example`.

The Compose services are `db`, `migrate`, `api`, and `web`. The API is
internal on port `8080`; Nginx publishes the configured HTTP/HTTPS ports.
The root `.env` values for `ADFS_*` are forwarded by `docker-compose.yml` to
the `api` service only; they are not placed on `web`, `migrate`, or a
frontend build. Compose defaults keep AD FS disabled (`ADFS_ENABLED=false`)
and use only the documented display-name, scope, and claim-name defaults; the
issuer, client ID, redirect URI, secret, and CA remain empty.
For production, leave `DISABLE_TLS=false` and supply a certificate trusted by
the users' browsers, either as `./certs/server.crt` plus
`./certs/server.key` or through the existing SSL settings process. This
certificate protects browser-to-Change-it traffic; an AD FS internal CA is a
separate outbound trust setting.

### Existing Docker deployment

Preserve the existing `.env`, volumes, TLS files, and database. Pull the
approved revision, ensure the API service receives the AD FS environment
fallbacks, and run:

```bash
docker compose up -d --build
```

Compose runs the additive `migrate` service before the API. Confirm the API
starts only after migration succeeds, then open the real HTTPS origin and
save/test the AD FS settings as an administrator. A failed or stale stored
settings row takes precedence over `.env`; inspect the masked
`GET /api/settings/adfs` response rather than exposing a secret.

### Image publishing convention

The repository has `update.sh`, not a checked-in CI workflow. The script
pulls with `git pull --ff-only`, builds the Compose images without cache, and
publishes these actual image names using the version in
`artifacts/api-server/package.json`:

```text
srvnexusint.hopital.chdn.lan:6443/infra/change-manager-builder:<version>
srvnexusint.hopital.chdn.lan:6443/infra/change-manager-api:<version>
srvnexusint.hopital.chdn.lan:6443/infra/change-manager-web:<version>
```

The registry and project name are overridable by `REGISTRY` and `PROJECT`;
the values above are the script defaults, not a guarantee that every
environment can reach that registry. Publish only from an authorized,
clean checkout and only after reviewing the image tags. There are no
Kubernetes manifests or known namespace/deployment names in this repository,
so Kubernetes rollout commands must come from the target platform's
deployment owner rather than being guessed here.

## Troubleshooting

### The AD FS button is missing

Check that `ADFS_ENABLED` is true in the effective API configuration and that
issuer, client ID, and redirect URI are present. Verify that the API
container actually received the variables; a root `.env` alone does not
forward variables into a container unless Compose maps them. A saved settings
row overrides the environment fallback, including a saved `enabled=false`.
The button is intentionally hidden when configuration is incomplete.

### Discovery fails or returns an unexpected document

Open the configured discovery URL from the API host, not only from a
developer laptop. It must be HTTPS and return valid OIDC metadata. Check
that `ADFS_ISSUER` exactly matches the metadata `issuer`, including path and
trailing-slash behavior, and that the AD FS endpoint is reachable through
firewalls and proxies. Configure the issuing CA if the certificate is
private. Never solve this by disabling certificate verification.

### TLS or certificate errors

Confirm the hostname is in the AD FS certificate SAN and that the PEM
contains the correct issuing CA/chain. A CA setting cannot repair a hostname
mismatch, expired certificate, or wrong server. Use Settings → AD FS or
`ADFS_CA_CERT_PEM`, then invalidate/reload the configured connection as
directed by the deployment. Do not set `NODE_TLS_REJECT_UNAUTHORIZED=0` and
do not turn off TLS validation.

### Token exchange, JWKS, or signature failure

Confirm that the API can reach the token and JWKS URLs from discovery, that
the AD FS signing keys are available, and that the server clock is accurate.
After an authority or CA rotation, save the changed setting so the discovery
and JWKS caches are invalidated. Do not accept an unsigned token or bypass a
signature failure. A key rollover may require waiting for the provider's
published keys to become available, not disabling validation.

### Issuer or audience mismatch

The ID token `iss` must equal the configured discovery issuer and its `aud`
must contain the registered Change-it client ID. Do not “fix” this by
accepting any issuer or audience. Check for accidentally using a different
AD FS application group/client, tenant path, or client ID between the
authorization and token requests.

### Nonce, state, PKCE, or authorization-code errors

These normally mean a stale/replayed callback, a second tab, a browser that
discarded cookies, a proxy that changed the external origin, or a callback
being retried after the code was used. Start a fresh login from the same
browser origin and check that HTTPS, cookie forwarding, and the exact
redirect URI are preserved. Never weaken state, nonce, or PKCE checks and
never accept a callback with a mismatched state cookie.

### Required claim or user errors

Inspect the AD FS client issuance rules and the claim names configured in
Change-it. The validated ID token must contain `sub` plus the configured
username claim (`upn` by default); email and display name are recommended.
The claim value must match one existing enabled Change-it user after
normalization. Pre-create the user or correct its username/email; AD FS
authentication does not create or merge accounts. A disabled or ambiguous
match is rejected intentionally.

### Settings save returns a CSRF error

Use an authenticated administrator session, include browser credentials, and
send `X-CSRF-Token` equal to the non-HttpOnly `cm_csrf` cookie. The frontend's
API helper does this automatically and can refresh a stale CSRF cookie once
through `/api/auth/me`. Do not exempt the AD FS settings route from CSRF.

### Deep link is lost or the browser loops on reauthentication

Use a local path rather than an absolute URL and start from the deployed
origin. The fragment must be captured by the SPA before navigation because
browsers do not send it to the server. Clear the tab's stale reauthentication
marker only after confirming the session and AD FS configuration; explicit
logout clears the login-method preference and must not immediately restart
AD FS.

### Migration/API startup failure

Check the one-shot `migrate` service and database connectivity. The API
depends on successful startup migration, so it should not be forced to start
against a partially upgraded schema. Confirm that the database user can
apply the additive Drizzle schema change, rerun the normal `docker compose up
-d --build`, and preserve the database before investigating further. Do not
drop existing tables or run a destructive migration to make the API start.

## Safe repository delivery

At the time this guide was written, `main` tracks the GitHub `origin/main`
remote (`https://github.com/andyelsen85-bit/Change-Manager`), and the
repository also has a `gitsafe-backup` remote. No `.github/workflows` or
other CI workflow is checked in; `update.sh` is the visible build/publish
convention. The attachment showing `git fetch && git reset --hard
origin/main` is destructive and should not be used when local work must be
preserved.

For a documentation-only delivery, use a clean, reviewable sequence:

```bash
git status --short --branch
git fetch origin
git diff --check
git diff -- docs/adfs.md .env.example README.md
git add docs/adfs.md .env.example README.md
git commit -m "Document AD FS authentication setup"
git push origin HEAD:main
```

Only run the final commit/push from an authorized checkout after reviewing
the diff and confirming that no `.env`, secret, certificate, package change,
version bump, or unrelated work is staged. If `origin/main` advanced, stop,
preserve the work, rebase/merge according to the repository owner's review
policy, and push only after resolving the review. Do not claim a CI run or
deployment from this repository when no workflow or deployment target is
known.