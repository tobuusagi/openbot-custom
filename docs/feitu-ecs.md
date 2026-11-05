# Aliyun ECS gateway draft

This document records local deployment templates for the Plan 011 gateway. It does not deploy a
service or change the existing `feitu.net.cn` website. The templates are drafts for review.

The target is one Aliyun ECS in Shanghai with Ubuntu 24.04, 2 vCPU, 2 GiB RAM, 40 GiB storage,
public IP `47.100.169.222`, and a listed maximum network speed of 200 Mbps. The actual bandwidth,
traffic charges and capacity are not confirmed. The ECS is for account and gateway services only.
It will not run Agent, Provider, model API or FCM sender processes. The Surface Host and clients
must open outbound TCP 443 connections when the relay is implemented. ECS access to Google is
unavailable and this runbook does not test it.

`api.feitu.net.cn` and `connect.feitu.net.cn` are approved subdomains. The base domain and its
existing website stay outside these templates. DNS, certificate issuance, host access, service
account creation and production data access were not performed.

## Current service boundary

The local runtime in `apps/auth-api/src/self-hosted/entry.ts` serves email sign-in start and verify,
`/v1/me`, logout, the public ticket JWKS endpoint, and liveness/readiness checks. It binds to
`127.0.0.1:3187`. Its SQLite adapter validates an exact schema and does not apply migrations at
runtime. Readiness stays `503` until SQLite, the schema, the ES256 ticket key pair, SMTP and the
auth handlers are ready.

The runtime does not implement WSS. The `connect.feitu.net.cn` block returns `503` for every
request, including WebSocket upgrade attempts. It does not forward traffic to Cloudflare or another
relay. The `api.feitu.net.cn` block forwards only the current account and health paths to loopback;
other paths return `404`.

This service shell is still in progress. A green `/health/ready` response proves only the checks
listed by the current runtime. It does not prove full account API compatibility, D1 data import,
rate-limit parity, WSS, remote-session delivery, backup recovery or production readiness. Do not
expose it to production clients until those areas have current review and test evidence.

## Files

- `deploy/feitu-ecs/Caddyfile` contains site blocks only. It has no global Caddy options.
- `deploy/feitu-ecs/openbot-account-gateway.service` runs the account runtime as
  `openbot-gateway`, with code under `/opt/openbot-runtime` and SQLite state under
  `/var/lib/openbot-gateway`.
- The service opts in to a fixed-name systemd credential reader. It has no `LoadCredential` source
  paths yet, so starting this draft fails closed until an approved secret-provisioning process adds
  them. Do not install or enable this unit as-is.

The unit expects a pre-existing locked system account named `openbot-gateway`. This task does not
create it. The release tree under `/opt/openbot-runtime` must be owned by a deployment administrator
and read-only to the service account. It must contain the exact workspace package files and
dependencies for the selected release. No deployment packaging process is included here.

The repository pins Bun `1.4.2` and sets a Node engine floor of `24.0.0`. The service command uses
the repository's Bun script. Before any staging run, confirm that the installed Bun `1.4.2` supports
the runtime's `node:sqlite` use. The source pins alone do not prove this. No runtime installation or
version check was made for this draft. Set the unit's Bun path to the verified executable if it is
not `/usr/local/bin/bun`.

The local reader is implemented in
`apps/auth-api/src/self-hosted/systemd-credentials.ts`. When
`OPENBOT_SELF_HOSTED_SYSTEMD_CREDENTIALS=true`, it requires systemd's `CREDENTIALS_DIRECTORY` and
reads only the eight literal filenames in the table below. It does not source a shell file, parse an
environment file, enumerate the directory, or follow symlinks. Each file must be a regular file no
larger than 16 KiB and contain one trimmed, nonempty UTF-8 value with no NUL or line breaks. Errors
name the setting and safe error code but never include its value. Without the opt-in, existing
environment/default behavior is unchanged. The unit selects the opt-in and production mode, with
development-code exposure disabled.

The local fixture verifies allowlisted values, missing files, invalid/duplicate-line values,
symlinks, oversize files and error redaction. It does not prove systemd's runtime credential
directory permissions or the host's `LoadCredential` behavior. Systemd man-page documentation and a
host for `systemd-analyze verify` were unavailable here. Secret provisioning, credential source
ownership/permissions, and systemd verification remain blocked; the unit is not deploy-ready.

## Runtime settings and secrets

The unit sets the listener, database path and production flags. Do not change the listener from
loopback. The opt-in systemd reader maps these eight credential filenames to these runtime names
before readiness can succeed:

| Variable | Secret | Use |
|---|---:|---|
| `OPENBOT_SELF_HOSTED_TICKET_PRIVATE_JWK` | Yes | ES256 ticket signing private key. Keep this key stable across service restarts. |
| `OPENBOT_SELF_HOSTED_TICKET_PUBLIC_JWKS` | No | Matching public ticket keys served by the JWKS route. |
| `OPENBOT_SELF_HOSTED_TICKET_KEY_ID` | No | Active key ID in the public JWKS. |
| `EMAIL_SMTP_HOST` | No | SMTP host. |
| `EMAIL_SMTP_PORT` | No | Must be `465`; the adapter uses verified implicit TLS. |
| `EMAIL_SMTP_USERNAME` | No | SMTP login address. |
| `EMAIL_SMTP_PASSWORD` | Yes | SMTP app password. |
| `EMAIL_FROM` | No | Verified sender address. |

No credential source paths are provided. An approved provisioning change may add one systemd
`LoadCredential` entry for each filename below, with protected source files kept outside this
repository. Example syntax only; replace each placeholder with a protected source path before a
separately reviewed staging installation:

```ini
LoadCredential=OPENBOT_SELF_HOSTED_TICKET_PRIVATE_JWK:/secure/source/path/ticket-private-jwk
LoadCredential=OPENBOT_SELF_HOSTED_TICKET_PUBLIC_JWKS:/secure/source/path/ticket-public-jwks
LoadCredential=OPENBOT_SELF_HOSTED_TICKET_KEY_ID:/secure/source/path/ticket-key-id
LoadCredential=EMAIL_SMTP_HOST:/secure/source/path/smtp-host
LoadCredential=EMAIL_SMTP_PORT:/secure/source/path/smtp-port
LoadCredential=EMAIL_SMTP_USERNAME:/secure/source/path/smtp-username
LoadCredential=EMAIL_SMTP_PASSWORD:/secure/source/path/smtp-password
LoadCredential=EMAIL_FROM:/secure/source/path/email-from
```

Do not add a secret environment file or source one from a shell. Provision secrets only through an
approved secret-management process. Do not generate a production key in this repository, store
plaintext secrets here, or send a secret in chat. The private JWK, public JWKS and active key ID form
one signing configuration and must match. The unit intentionally has no credential source paths;
until they are provisioned and reviewed, the process exits before listening, so the health endpoint
is unavailable. A runtime that starts with another required dependency missing answers `503` on
`/health/ready`.

The current account sessions use opaque stored tokens; the current runtime has no separate account
session signing-root setting. Preserve the ticket signing key with the account database. If a
separate session signing root is added later, include it in the same protected recovery set.
Changing a ticket signing key does not revoke opaque account sessions.

Do not enable `OPENBOT_SELF_HOSTED_EXPOSE_DEVELOPMENT_CODE` or development mode on a public
listener. The systemd unit sets production mode and turns code exposure off.

## Local schema creation

The only initializer currently available accepts a new, nonexistent SQLite file below the ignored
`.openbot-build/011-self-hosted/` directory. It applies the runtime's listed auth migrations once
and records their names and hashes. It rejects an existing file. The service itself never migrates
an existing database.

For a local rehearsal only, use a new filename that does not exist:

```sh
bun run --cwd apps/auth-api self-hosted:init --database feitu-stage.sqlite
```

This creates an empty local schema. It does not import Cloudflare D1 or production data. The
initializer currently rejects `/var/lib/openbot-gateway/account.sqlite`, so do not point it at ECS,
try a symlink or bypass its path guard. A reviewed production initialization and file handoff
procedure is still required. No production database, migration or import command is provided here.

If the chosen local file already exists, select a different new name. Do not remove or overwrite an
existing database to make this command pass.

## Staged rollout review

Do not start a second Caddy process or replace the existing global Caddy configuration. First
record which service owns ports 80 and 443, inspect the active Caddy import tree and existing site
routes, and confirm the website's current behavior. If another proxy owns these ports, stop and
prepare an integration change for its owner. The subdomain blocks must be imported into the existing
proxy only after this review. They contain no route for `feitu.net.cn` itself.

Before any later staging deployment, review these gates in order:

1. Confirm the intended release tree, dependency lock and Bun runtime. Keep the application code
   read-only. Confirm the systemd account exists and can write only to its state and private temp
   paths.
2. Provision protected credential source files and add the eight `LoadCredential` entries to a
   reviewed staging copy of the unit. Verify source ownership and permissions on that host. The
   checked-in unit remains blocked without them. Do not reuse production credentials for a local
   rehearsal. Do not put secrets in command arguments or logs.
3. Initialize only a new local database for a local rehearsal. A production database import or
   schema upgrade needs a separate compatibility, backup and rollback review.
4. Review the Caddy snippet against the active configuration. Check the full integrated config
   with `caddy validate` before any reload. Caddy's managed TLS requires the approved subdomain DNS
   records and reachable certificate challenge ports; this task does not check or create them.
5. Review the unit with `systemd-analyze verify` before installing or starting it. The unit has
   initial limits of 150% CPU, 1 GiB memory high-water and 1280 MiB memory maximum. These are
   resource-bound proposals for a 2 GiB host, not measured capacity limits. Adjust them only from
   staging evidence. Caddy and the operating system also use this host's memory and CPU.
6. On an isolated staging host, start the account service and check local health endpoints. A
   liveness response of `200` means the process answers. Readiness must return `200` before account
   traffic is considered available. It returns `503` while a required dependency is missing.
7. Confirm through staging that the API routes behave as reviewed and the relay hostname always
   returns `503`. Do not claim that a client can connect through WSS. Do not test ECS access to
   Google or FCM.
8. Do not proceed to public production traffic until account behavior, rate limits, session
   revocation, D1 compatibility, secret handling, backup recovery and rollback have current review
   and test evidence. The current plan has no approved production gate.

After the runtime is running on an isolated host, these read-only probes check its HTTP status:

```sh
curl -i http://127.0.0.1:3187/health/live
curl -i http://127.0.0.1:3187/health/ready
```

The health response contains dependency states, not secret values. Do not include authentication
codes, tokens or full environment output in a report. The Caddy validation and systemd verification
commands above are for a later staging host; they were not run in this task.

## Resource and disk limits

The systemd unit proposes a 1 GiB `MemoryHigh`, a 1280 MiB `MemoryMax` and a 150% CPU quota. These
limits leave capacity for Caddy and the operating system, but they are not a performance claim.
The ECS has 40 GiB of disk for the OS, code, SQLite, logs and local staging backups. Monitor free
space and keep verified backups outside the ECS. The 200 Mbps figure is a listed maximum and is not
a guaranteed rate. No concurrency or throughput target is established here.

The ECS does not run Agents or Providers. Keep Provider API traffic on the Surface Host. The Surface
Host and clients use outbound 443 when WSS support exists; the current relay response remains 503.
No global proxy, firewall, DNS, certificate or host setting is changed by these files.

## Backup and restore

The account database and signing configuration are a recovery set. Store backups encrypted and
restrict access. Keep a copy outside the ECS. Before a backup, enter maintenance and stop the
service cleanly. Do not copy only `account.sqlite` while SQLite is open. Copy `account.sqlite` and
every sidecar that exists, including `account.sqlite-wal` and `account.sqlite-shm`, as one set. The
current adapter does not enable WAL mode, but the backup procedure must keep a WAL file if one is
present. Preserve the matching ticket private JWK, public JWKS and key ID through the approved
secret store. The credential reader is implemented, but production provisioning and its backup path
are not designed, so a complete recovery
set cannot be created from this draft.

Use a new, unique backup directory so that a previous backup cannot be replaced. Record checksums
and the release identifier beside the backup. Keep enough free space before copying; the ECS disk
is only 40 GiB. A copy on the same disk is not an off-host backup.

For a later approved maintenance window, run this template from a root maintenance shell. Set
`backup_dir` to a new path on an encrypted, access-controlled backup volume before use. The
`mkdir` fails if the path already exists. If a command fails, keep the service stopped and resolve
the incomplete backup before leaving maintenance.

```sh
set -eu
backup_dir=/encrypted-backup-volume/feitu/replace-with-unique-UTC-id
test ! -e "$backup_dir"
mkdir -m 0700 -- "$backup_dir"
systemctl stop openbot-account-gateway.service

db=/var/lib/openbot-gateway/account.sqlite
cp --archive -- "$db" "$backup_dir/account.sqlite"
for suffix in -wal -shm; do
  sidecar="${db}${suffix}"
  if [ -f "$sidecar" ]; then
    cp --archive -- "$sidecar" "$backup_dir/"
  fi
done
(
  cd "$backup_dir"
  sha256sum account.sqlite* > SHA256SUMS
  sha256sum --check SHA256SUMS
)
systemctl start openbot-account-gateway.service
```

This command template backs up SQLite only. It is not a complete account recovery set until the
credential provisioning and its protected backup path are reviewed. It was not run or tested.

Restore only under fail-closed maintenance. Keep public ingress closed or leave the relay and API
unavailable. Restore a validated database copy and its matching SQLite sidecars to a separate,
new data path. Restore or reprovision the matching signing configuration. Check the restored copy
before pointing a service at it. Never restore files over the only live database. Reprovision the
matching signing configuration through the approved secret store; its loader and recovery path
remain unresolved.

The safe file step is to copy the backup into a new candidate filename while the service is
stopped, after checking `SHA256SUMS`. Preserve the sidecar names with the candidate database name.
Do not change the unit to use the candidate until a reviewed, read-only SQLite integrity check and
the application's exact schema validation pass. The current deployment files do not provide a
restore validator or a live-path cutover command. Keep public traffic closed until those steps and
the session invalidation below are complete.

A database rollback can restore opaque account sessions that were revoked after the backup. It can
also restore old remote authorizations. Restoring the database and signing key alone is not a safe
recovery guarantee. Before reopening public service, a separately reviewed and supported
transaction must invalidate restored live account sessions and revoke linked remote sessions using
the existing trigger/outbox semantics. Require affected users to sign in again and re-pair where
needed. The current runtime has no reviewed bulk invalidation command, so this runbook provides no
SQL or automatic invalidation step. If that supported operation is not available or cannot be
verified, keep the service offline. Rotating the ticket signing key alone does not revoke opaque
account sessions.

Rollback to older code is safe only with a database schema and signing configuration that the old
release supports. The schema validator checks exact migration names and hashes; a code rollback
does not reverse schema changes. Do not run migrations against an imported or existing database as
a rollback step. The current initializer is for new local databases only. Production import,
schema upgrades and rollback remain separate review gates. No restore, overwrite, deletion or
production database action was run for this draft.
