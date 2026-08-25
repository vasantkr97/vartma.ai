# Operations and recovery

This runbook covers the failures an operator must be able to diagnose and recover without exposing
provider keys or losing canonical session data. PostgreSQL and the external secret manager are the
authoritative durable systems; containers are replaceable.

## Service objectives and alerts

Set explicit targets for each deployment before accepting traffic. The recommended starting point
is 99.9% monthly gateway availability, p95 routing overhead below 250 ms excluding provider time,
and zero acknowledged canonical transcript loss. Alert on readiness failure, elevated 5xx rate,
provider circuit opening, retry or escalation spikes, database connection saturation, evaluation
regression, and spend-budget breach. Provider latency must be charted separately from Vartma
overhead.

## Backup policy

- Run encrypted PostgreSQL backups at least daily and retain write-ahead logs when point-in-time
  recovery is required. Keep copies in a different failure domain.
- Back up the encrypted `.vartma/credentials.json` vault and router configuration snapshots as
  sensitive data. Store `VARTMA_MASTER_KEY` and provider keys only in the secret manager, separately
  from ciphertext backups.
- Record backup time, database migration version, application commit, checksum, retention expiry,
  and restore-test result. A backup is not accepted until a restore drill reads Vartma data.
- Choose RPO and RTO for the deployment. A sensible initial target is RPO <= 24 hours with daily
  dumps, or RPO <= 5 minutes with continuous WAL archiving, and RTO <= 60 minutes.

The repository includes a destructive-safe drill that creates only uniquely named, temporary
PostgreSQL 17 containers, applies every Prisma migration, inserts a Vartma session and authenticated
encrypted canonical transcript, streams a custom-format dump directly into a fresh database,
decrypts and verifies the restored transcript and migration history, and removes both containers:

```sh
npm run smoke:postgres-recovery
```

The script never touches the configured production database or a Docker volume. For production,
use the platform's snapshot/PITR mechanism or `pg_dump --format=custom`; restore into a new database,
never over the only healthy copy. Apply this sequence:

1. Freeze writes or record the recovery timestamp, preserve the failed database, and identify the
   last known-good backup and its checksum.
2. Restore into an isolated PostgreSQL instance with the same or newer compatible major version.
3. Set `DATABASE_URL` only for a verification process and run `npx prisma migrate status`.
4. Run `/readyz`, a routed canary, session/trace reads, and a transcript-decryption check with the
   production master key.
5. Change application traffic to the restored instance through the deployment control plane.
6. Monitor errors, costs, and session continuity; retain the old instance until the rollback window
   closes.

## Endurance gate

`npm run smoke:soak` requires `DATABASE_URL`, an applied Vartma schema, and `VARTMA_MASTER_KEY`, so
the production gate uses the same PostgreSQL attempt/session/usage stores and encrypted canonical
history as a deployed gateway. It runs for 15 minutes by default at 20 requests per second with
concurrency 20 and 100 accumulating canonical sessions. Every fifth request uses SSE streaming. It
fails on any request error, incomplete terminal stream, failed post-run readiness probe, p95 above
2 seconds, event-loop p99 above 500 ms, or peak total RSS above 512 MiB. A short local calibration
may explicitly set `VARTMA_SOAK_ALLOW_IN_MEMORY=true`; an in-memory result is not production
evidence. Override the thresholds only to match a documented deployment envelope:

- `VARTMA_SOAK_DURATION_MS`
- `VARTMA_SOAK_CONCURRENCY`
- `VARTMA_SOAK_TARGET_RPS`
- `VARTMA_SOAK_MIN_RPS_RATIO` (defaults to 0.9)
- `VARTMA_SOAK_SESSION_POOL`
- `VARTMA_SOAK_MAX_P95_MS`
- `VARTMA_SOAK_MAX_EVENT_LOOP_P99_MS`
- `VARTMA_SOAK_MAX_RSS_MB`
- `VARTMA_SOAK_ALLOW_IN_MEMORY` (development calibration only)

## Incident procedures

### Provider outage or rate limiting

Confirm provider health and circuit state with `vartma doctor --json` and `vartma status --json`.
Do not disable safe fallback globally. Remove an unhealthy model from eligibility or lower its
traffic weight in a validated configuration, then restart or roll out the configuration normally.
Verify that pre-output failures reroute and that streams which already emitted visible output fail
without replay. Restore traffic gradually after half-open probes succeed.

### Gateway or database outage

Drain the unhealthy gateway and keep another replica serving if available. A database readiness
failure must remove the instance from traffic rather than silently switching to volatile storage.
Check connection limits, disk, locks, and migration state. Restore using the procedure above when
the database cannot be repaired inside the RTO. Never run a development migration or reset command
against production.

### Provider-key or gateway-key compromise

Revoke the affected upstream key first, rotate it through the secret manager, update the encrypted
BYOK reference, restart affected processes, and run provider conformance. Rotate gateway keys with
an overlap window when clients cannot change atomically. Search redacted logs by request ID, not by
secret value. If `VARTMA_MASTER_KEY` is exposed, rotate every encrypted credential and transcript
key; changing only the passphrase is insufficient assurance.

### Bad release or configuration

Stop the rollout, preserve request IDs and metrics, and redeploy the previously signed image digest
with its matching configuration and migration compatibility. Configuration mutations made by the
CLI are locked, backed up, drift checked, and exactly undoable; use `vartma config undo` rather than
editing generated state. Database migrations must be forward-compatible during the rollback window.
Never use `prisma migrate reset` in an incident.

## Verification cadence

- Every change: unit/integration suite, dependency audits, load smoke, clean-install smoke, and the
  one-minute CI endurance profile.
- Before release: run the default 15-minute `npm run smoke:soak` gate and review latency,
  event-loop delay, failures, and RSS growth; also run provider conformance for every enabled
  family, fixed/Balanced/Eco evaluation, a container canary, and configuration rollback.
- Monthly: run a production-shaped extended soak (for example,
  `VARTMA_SOAK_DURATION_MS=14400000 npm run smoke:soak` for four hours) against deployment-sized
  persistence and concurrency limits.
- Quarterly: restore a production-shaped backup into isolation and record measured RPO/RTO.
- After every incident: assign an owner and due date to each corrective action and add a regression
  test where possible.
