# ADR: durable tenant-aware job queue

## Status and decision

Accepted. Use a durable broker with partition keys set to tenant ID, consumer groups, and an
idempotency record in the same database transaction as each job's durable outcome. Delivery is
at-least-once; exactly-once external effects are not promised.

## Ordering and concurrency

Partitioning by tenant preserves FIFO start order within a tenant while different partitions run
concurrently. A tenant sequence number detects gaps. Long jobs must not hold a partition lock;
they checkpoint and renew a bounded lease.

## Idempotency and acknowledgement

Every submission carries an immutable job ID. A worker claims the ID, checks the idempotency table,
performs the effect using the same key when the downstream supports it, commits the result, and
only then acknowledges. A crash before acknowledgement causes safe redelivery and lookup.

## Retries and dead letters

Retry transient failures with exponential backoff and jitter, a maximum attempt count, and an
absolute age limit. Permanent or exhausted jobs move to a dead-letter queue containing reason,
attempts, payload reference, and trace ID. Replay requires operator authorization and retains the
same idempotency key.

## Backpressure and overload

Enforce per-tenant admission quotas, a global queue-depth ceiling, and worker concurrency limits.
Return an explicit overload response before accepting work that cannot meet retention guarantees.
Autoscaling uses oldest-message age as well as depth, with a hard database connection budget.

## Observability and recovery

Measure enqueue-to-start latency, execution latency, redelivery, retry, dead-letter, lease expiry,
and per-tenant backlog. Propagate trace IDs through producer, broker, worker, and external call.
Back up broker metadata and the idempotency/result database; quarterly restore drills verify RPO
and RTO. During regional recovery, fence the old consumers before activating the replica.

## Rejected alternatives

An in-memory queue loses accepted jobs on restart. A database polling table is simpler but creates
hot scans and weaker backpressure at 20x bursts. Exactly-once delivery was rejected because an
atomic transaction cannot span arbitrary external systems; idempotent at-least-once processing is
the enforceable contract.
