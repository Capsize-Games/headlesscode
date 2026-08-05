# Stack rules: PostgreSQL

Applies when the target project uses PostgreSQL (a postgres driver in Python
dependencies, a postgres-image service in a compose file, or a
migrations/alembic directory).

## Migrations

- Check every schema migration for backward-compat with the code currently
  deployed during rollout. Adding a NOT NULL column to a large table without a
  safe default or a backfill strategy is a classic outage — prefer additive
  steps (add nullable → backfill → tighten the constraint) and keep the
  migration reversible.
- Run migrations against a REAL (containerized) Postgres in tests, not a mock —
  dialect behavior, constraints, and locking only show up against the real
  thing.

## Multi-tenant data access

- Any new query touching tenant-scoped tables must go through the project's
  existing tenant-scoping helper — never a raw unscoped query, or it becomes a
  cross-tenant data leak.
- When a route/endpoint reads or writes tenant data, take the tenant id from
  the project's account/tenant-resolution layer (auth/session), never from
  client-supplied input.

## Connections & resources

- Check for an existing connection-pooling config before adding a new direct
  connection — a worker spinning up unpooled connections in a loop is a common
  self-inflicted resource-exhaustion bug.
