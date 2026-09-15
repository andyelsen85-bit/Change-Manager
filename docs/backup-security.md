# Backup security

The Backup & Restore page exports a complete database snapshot as JSON. The
JSON includes users, roles, change data, comments, audit history, and
configuration; it must be treated as sensitive operational data. The download
endpoint intentionally remains the legacy JSON API for compatibility. It does
not create, store, or manage an encryption key.

## Required handling

Immediately after downloading a backup:

1. Move it to a protected working directory and restrict access to the
   operator account.
2. Encrypt it with an approved external tool (age or GPG) before putting it on
   a backup share, attaching it to a ticket, or sending it to another system.
3. Verify that the encrypted file can be decrypted by the designated recovery
   operators.
4. Remove the plaintext JSON from the download directory and any temporary
   locations. Do not retain an unencrypted copy “for convenience”.

The encrypted artifact, not the JSON export, is the backup record. Protect the
passphrase using the organisation's approved password/secret-management
process. Never put a passphrase in a shell argument, script, command history,
ticket, or chat message.

## Restore session semantics

The legacy JSON export intentionally excludes the operational
`user_sessions` and `auth_login_throttle` tables. During restore, the
application locks the existing users and derives a session-generation barrier
greater than every pre-restore user generation. It clears both operational
tables in the same transaction before replacing users. Every imported user is
assigned that derived generation; any `session_generation` value supplied in a
JSON file is ignored. This prevents a pre-restore in-flight login from
becoming valid for a different user that reuses the same numeric ID. A
generation overflow aborts the restore rather than wrapping.

After a successful restore, all browser sessions are invalid and the restore
response clears the current session cookie. The web UI clears its in-memory
authentication state and requires a fresh login. A failed restore rolls back
the operational-table deletion together with the data changes.

## age passphrase example

The `-p` option makes age prompt for the passphrase on the terminal. It is not
included in the command below:

```sh
umask 077
mkdir -p ~/change-mgmt-backups
mv change-mgmt-backup-YYYY-MM-DDTHH-MM-SS-000Z.json ~/change-mgmt-backups/
cd ~/change-mgmt-backups
age -p -o change-mgmt-backup-YYYY-MM-DDTHH-MM-SS-000Z.json.age \
  change-mgmt-backup-YYYY-MM-DDTHH-MM-SS-000Z.json
rm -- change-mgmt-backup-YYYY-MM-DDTHH-MM-SS-000Z.json
```

To recover a copy, `age` prompts again when `-d` is used. Write the plaintext
only into a protected working directory and remove it after the restore:

```sh
umask 077
age -d -o /secure/recovery/change-mgmt-backup.json \
  ~/change-mgmt-backups/change-mgmt-backup-YYYY-MM-DDTHH-MM-SS-000Z.json.age
```

## GPG symmetric example

GPG also prompts for the passphrase when no passphrase is supplied as an
argument. `--pinentry-mode loopback` is intentionally not used here; use the
site's configured pinentry agent:

```sh
umask 077
gpg --symmetric --cipher-algo AES256 \
  --output change-mgmt-backup-YYYY-MM-DDTHH-MM-SS-000Z.json.gpg \
  change-mgmt-backup-YYYY-MM-DDTHH-MM-SS-000Z.json
rm -- change-mgmt-backup-YYYY-MM-DDTHH-MM-SS-000Z.json
```

Decrypt into a protected recovery path:

```sh
umask 077
gpg --output /secure/recovery/change-mgmt-backup.json \
  --decrypt ~/change-mgmt-backups/change-mgmt-backup-YYYY-MM-DDTHH-MM-SS-000Z.json.gpg
```

## Proposed retention policy

The following is a proposed operational policy for the deployment owner, not a
claim about an existing policy: keep encrypted daily backups for 14 days,
encrypted weekly backups for 12 weeks, and one encrypted monthly backup for
12 months. Review the schedule against recovery-point and legal requirements,
test a restore at least quarterly, and securely delete expired encrypted
artifacts according to the organisation's media-disposal process. Keep
passphrases and recovery access under separate administrative control.

Legacy JSON exports remain supported by the same API and restore format. The
application does not transparently decrypt age/GPG files; decrypt an approved
copy outside the application, then select the resulting JSON file in the
Restore control.