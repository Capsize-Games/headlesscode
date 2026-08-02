# UwUChat code-credits accounting — real-dollar prepaid balance for admin coding sessions

## Status: scoped for dispatch (2026-08-02) — self-contained, no other plan doc required

## Who you are working on this for

You are implementing this against the `airunner` repository
(`~/Projects/airunner`) — a multi-tenant AI chat framework. UwUChat is one
product built on it, living under `projects/uwuchat/{server,client}`. Read
`CLAUDE.md` at the repo root in full before touching anything — it defines a
hard framework/project separation: framework code goes in `server/src/
airunner_services/` or `client/src/`, UwUChat-only behavior goes under
`projects/uwuchat/`. This task is 100% UwUChat-specific.

This is item 5 of `plans/uwuchat-integration.md`'s Tier 1 build order (a
different repo's plan doc — you do not need to read it; everything required
is below). Tier 1 lets an admin drive a general coding-agent harness
(headlesscode — a separate Node/TypeScript CLI project, checked out
separately at `~/Projects/headlesscode`) from inside a UwUChat conversation,
using the **system-owned** OpenRouter key (never the admin's own — BYOK was
explicitly rejected because it would leak system prompts into a user's own
OpenRouter dashboard). Because that key is shared and coding rounds have
open-ended, unpredictable cost (unlike a flat per-turn chat cost), spend
needs a real prepaid-dollar accounting layer with a hard stop — this task
builds that layer. **It does not need working headlesscode invocation to be
useful or testable**: it consumes `.headlesscode/usage/*.jsonl`, a file
format that already exists and is stable, so this task can be built and
fully tested against fixture files before any invocation code exists.

## Verified current state (re-confirm before starting; report if anything
has drifted)

- **Zero credits/metered-dollar-spend mechanism exists anywhere in this
  repo today** (re-confirmed via grep for `code_credits`/`CodeCredit`,
  2026-08-02: no hits outside plan docs). All existing billing is flat
  Stripe subscription tiers metered by counting turns/tokens, not dollars:
  `extensions/auth/server/stripe_routes.py` defines `TIER_CAPS`,
  `TIER_DAILY_CAPS`, `TIER_DAILY_TOKEN_CAPS` (turn/token counts per tier,
  e.g. `"starter": 9_000` monthly turns); `projects/uwuchat/server/
  quota_service.py`'s `get_quota()`/`is_over_quota()` count
  `PipelineTokenUsage.call_chain_id` rows per tenant per period. None of
  this is a purchasable/decrementing dollar balance — it's a periodic
  counter that resets. Do not extend `TIER_CAPS` or `quota_service.py` for
  this feature; build the parallel dollar-balance model described below
  instead, since the semantics (prepaid wallet, real-dollar debit, hard
  stop at zero, no periodic reset) are fundamentally different from a
  resetting turn counter.
- `Account` (`extensions/auth/server/models.py`) lives in the **public**
  schema (loaded via `public_session_scope()`, not a tenant schema — see
  `quota_service.py`'s usage) and has `is_superuser: Column(Boolean)`. The
  credits balance is admin-only for now, so store it on `Account` directly
  (public schema) rather than inventing per-tenant-schema storage — this
  sidesteps the multi-tenant migration complexity `CLAUDE.md` warns about
  for tenant-scoped tables, since `Account` is a single shared table.
  Re-confirm `Account`'s current columns before writing the migration (it
  may have changed since this doc was written).
- `extensions/auth/server/dependencies.py`'s `require_superuser` is the
  established admin-gating dependency (401 unauthenticated, 403
  non-admin). Use it for every new endpoint here — same pattern as
  `stripe_routes.py`'s admin endpoints (e.g. line ~562, ~648) and
  `routes_admin.py`.
- `projects/uwuchat/server/quota_routes.py` is the precedent for a small
  UwUChat-only route module, mounted via the registration list in
  `server/src/airunner_services/api/server_routes.py` (search for
  `"projects.uwuchat.server.quota_routes"`).
- **The real cost data source** (headlesscode's own accounting, already
  built and stable — verified by reading `~/Projects/headlesscode/src/
  engine/usage.ts`):
  - `<workspaceRoot>/.headlesscode/usage/<sessionId>.jsonl` — one
    append-only JSONL file per session. Each line is a `UsageRecord`:
    `{sessionId, mode, model, iterations, inputTokens, outputTokens,
    cachedTokens?, costUsd, startedAt, endedAt, status: "success"|"error"|
    "budget", workspaceRoot}`. `costUsd` is the authoritative real-dollar
    cost for that completed session.
  - `<workspaceRoot>/.headlesscode/usage/<sessionId>.live.json` — a single
    JSON object (NOT JSONL, overwritten in place), same shape minus
    `endedAt`, `status: "running"`, updated after every iteration while a
    session is in progress. This is what "real-time" debiting reads from
    for an in-flight session; the `.jsonl` line is what finalizes the debit
    once the session ends.
  - `~/Projects/headlesscode/src/dashboard/aggregate.ts` already reads both
    of these for its own dashboard — read it for the exact parsing/loose-
    validation idiom (malformed/partial lines are skipped, not fatal) and
    match it rather than re-deriving your own JSONL reader from scratch.
  - `~/Projects/headlesscode/src/budget/budget.ts`'s `BudgetTracker` is the
    enforcement primitive already built on the headlesscode side:
    `sessionBudgetFromEnv()` reads `HEADLESSCODE_MAX_COST_USD` /
    `HEADLESSCODE_MAX_DURATION_MS` and, when set, the tracker throws
    `BudgetExceededError` once cost/duration/iterations are exceeded. This
    task's hard-stop-at-zero requirement is satisfied by **computing the
    admin's remaining balance and passing it as `HEADLESSCODE_MAX_COST_USD`
    when a session is launched** — this task does not need to modify
    headlesscode itself, only compute and pass that env var correctly (the
    actual launch/invocation code is separate follow-on work, item 1/3 of
    the Tier 1 build order — this task should stub or accept an injected
    "launch a session" function it does not implement).

## What to build

### 1. `code_credits` balance on `Account` (public schema)

New migration (per `CLAUDE.md`'s Database section — generate via
`docker compose exec server airunner-generate-migration "add code_credits
balance to accounts"`, never hand-write raw SQL, probe column existence
before destructive DDL, must be idempotent since it runs on startup):

- `code_credits_usd: Column(Numeric(10, 4), nullable=False, default=0)` —
  four decimal places to represent sub-cent LLM costs precisely (existing
  cost values from headlesscode are floats with many decimal places; do not
  use `Float` for a balance that gets debited — use `Numeric`/`Decimal`
  throughout to avoid floating-point drift across many small debits).

Do not add this column to any tenant-schema table — `Account` is public-
schema only, confirmed above.

### 2. `projects/uwuchat/server/code_credits_service.py`

```python
from decimal import Decimal

def get_balance(account_id: int) -> Decimal: ...

def add_credits(account_id: int, amount_usd: Decimal, *, note: str) -> Decimal:
    """Admin-only manual top-up. Returns new balance. Rejects amount_usd <= 0."""

def debit_session_usage(
    account_id: int, session_id: str, cost_usd: Decimal
) -> Decimal:
    """Idempotent debit for one headlesscode session's real cost.

    Must be safe to call more than once for the same session_id without
    double-debiting (a crashed/retried poller could call this twice) —
    persist which session_ids have already been debited (see item 3 for
    where this ledger lives) and no-op on a repeat.
    """

def remaining_budget_usd(account_id: int) -> Decimal:
    """Current balance, clamped to >= 0 — the value to pass as
    HEADLESSCODE_MAX_COST_USD when launching a session for this account."""
```

### 3. A debit ledger table, not just a running balance column

A bare balance column can't give idempotency (item 2's requirement) or an
audit trail (an admin will want to see where spend went). Add a second
table, `code_credit_transactions`, via the same migration:

- `id` (PK), `account_id` (FK to `accounts`), `amount_usd` (Numeric(10,4),
  negative for debits, positive for top-ups), `kind` (`"topup"` |
  `"session_debit"`), `session_id` (nullable string — set for
  `session_debit` rows, used for the idempotency check in
  `debit_session_usage`), `note` (nullable string), `created_at`
  (DateTime, server default now).

`get_balance()` sums `amount_usd` across this table for the account (or
maintain the `Account.code_credits_usd` column as a denormalized running
total updated transactionally alongside each insert — either is
acceptable; if you denormalize, both values must be updated in the same
DB transaction so they can never drift, and `get_balance()` should read
the column, not re-sum, for performance). Document whichever you choose
in your report.

### 4. Real-time debiting — a polling reconciler

New module, `projects/uwuchat/server/code_credits_reconciler.py`. Since
this task does not build session launching (that's separate follow-on
work), build this as a standalone function that a future launcher calls
periodically, plus a small CLI/admin-triggerable entry point so it's
independently testable now:

```python
def reconcile_session_usage(
    account_id: int, workspace_root: str, session_id: str
) -> Decimal:
    """Read <workspace_root>/.headlesscode/usage/<session_id>.live.json
    (if present, session still running) or the finalized .jsonl line (if
    present, session ended) and debit the delta since the last known cost
    for this session. Returns current remaining balance.

    Must handle: file doesn't exist yet (session hasn't started writing
    usage — return current balance unchanged, not an error); malformed/
    partial JSON (loose-validate exactly like headlesscode's own
    readUsageFile/readLiveUsageFile do — skip, don't crash); a session
    that appears in both .live.json and .jsonl (finalized while being
    read) — the .jsonl record wins, since it's authoritative per
    usage.ts's own documented precedence.
    """
```

"Debit the delta since the last known cost" (not the full `costUsd` every
poll) matters because `.live.json` is an overwritten snapshot of
cumulative cost, not an increment — read it repeatedly across polls and
you must debit only the difference from the last poll, or you'll debit the
same spend many times. Store "last known cost debited for this
session_id" — the sum of prior `session_debit` transactions for that
`session_id` in the ledger (item 3) already gives you this; no separate
state needed.

### 5. Hard stop at zero

`remaining_budget_usd()` (item 2) must clamp to `>= 0` — negative balances
should never be presented to a caller as spendable budget, even though the
ledger itself may show a slightly negative running total (the last debit
before hitting zero can overshoot the exact remaining balance by a small
amount, since a session's real cost is only known after the fact — this is
expected and acceptable; the hard stop is enforced going forward by
refusing to launch a *new* session when `remaining_budget_usd() <= 0`, not
by trying to claw back an already-completed session's overshoot). Add:

```python
def has_credits(account_id: int) -> bool:
    """False when remaining_budget_usd() <= 0 — the gate a future session
    launcher must check before starting a new headlesscode session."""
```

This task does not wire `has_credits()` into an actual launch path (no
launcher exists yet) — expose it as the function the future launcher task
will call, and cover it with a direct unit test.

### 6. Admin-only API

New file `projects/uwuchat/server/code_credits_routes.py`, same shape as
`quota_routes.py`, all endpoints `Depends(require_superuser)`:

- `GET /api/v1/uwuchat/code-credits/{account_id}` → `{balance_usd: str,
  recent_transactions: [...]}` (last N transactions, e.g. 20, for the
  admin-facing display — return `amount_usd` as a string, not a float, to
  avoid JSON float-precision surprises on decimal values).
- `POST /api/v1/uwuchat/code-credits/{account_id}/topup` → body
  `{amount_usd: str, note: str}`, calls `add_credits()`, returns new
  balance. Reject non-positive amounts with 400.

No purchase/Stripe flow — per the plan this task derives from, admin-only
manual top-up via this endpoint (called from an admin panel, or even just
`curl`/an internal script for now) is the whole top-up mechanism for this
phase. Do not build a Stripe product/checkout flow for this.

### 7. Cost display data (backend only — UI is a separate later item)

`get_balance()` and the transaction list from item 6's GET endpoint are
sufficient backing data for a future cost-display UI (`InlineCostBreakdown`
adaptation, Tier 1 build-order item 7) — do not build that UI in this task,
just make sure the API response shape above is something a future card
component could render directly without another round-trip.

## What NOT to do

- Do not build a real Stripe purchase/top-up flow — manual admin top-up via
  the API in item 6 is sufficient for this phase.
- Do not use `Float`/`float` for any money value anywhere in this feature —
  `Numeric`/`Decimal` only, to avoid drift across many small debits.
- Do not touch `TIER_CAPS`/`TIER_DAILY_CAPS`/`quota_service.py` — those are
  the separate flat-tier chat quota system and must stay untouched.
- Do not build the actual `headlesscode orchestrate`/session-launch
  invocation code — that's separate follow-on work (Tier 1 build-order item
  1/3). This task only builds the accounting layer that a future launcher
  will call into (`remaining_budget_usd()`, `has_credits()`) and read from
  (`reconcile_session_usage()` polling a workspace that some other process
  populates).
- Do not add this column/table to any tenant-schema model or migration path
  — `Account` and its new table are public-schema only.
- Do not silently swallow a malformed usage file as a fatal error — match
  headlesscode's own loose-validation idiom (skip bad lines/files, never
  crash the reconciler).

## Tests

- `projects/uwuchat/server/tests/` (match this directory's existing pytest
  conventions):
  - `code_credits_service.py`: balance starts at 0; `add_credits` increases
    balance and rejects non-positive amounts; `debit_session_usage` called
    twice with the same `session_id`/`cost_usd` only debits once
    (idempotency); `remaining_budget_usd` clamps at 0; `has_credits`
    reflects the clamp correctly at exactly-zero and just-below-zero.
  - `code_credits_reconciler.py`, using **fixture JSONL/live.json files
    checked into the test directory** (do not require a real headlesscode
    process to run — this is the whole point of the stable file-format
    contract): reconciling a `.live.json` mid-session debits only the delta
    across repeated polls; reconciling a finalized `.jsonl` record debits
    the remainder and doesn't double-debit already-reconciled cost;
    missing file returns balance unchanged; malformed JSON is skipped, not
    fatal; a session present in both files prefers the `.jsonl` value.
  - Route tests: 401/403 gating on both endpoints; top-up round-trips into
    a higher balance and a new transaction row; negative/zero top-up
    amount returns 400.
- Confirm the migration is idempotent: run it twice against a schema that
  already has the columns/table and confirm it doesn't error (per
  `CLAUDE.md`'s `_column_exists`-style probing convention — apply the same
  probing to the new table's existence check).

## Verification checklist

1. `docker compose exec server airunner-generate-migration "..."` used to
   generate the migration — never hand-written. Confirm it applies cleanly
   on a fresh dev DB (migrations run automatically on API startup per
   `CLAUDE.md` — restart the server container and check startup logs show
   no migration error, per `./scripts/docker.sh logs server`).
2. `docker compose exec server python scripts/run_tests.py` — new tests
   plus full suite green.
3. `git diff --stat` shows changes concentrated under
   `projects/uwuchat/server/` plus the one new migration file — no
   framework files touched.

## What to report back

- Files added/changed, including the exact migration filename generated.
- Whether you denormalized `Account.code_credits_usd` as a running total or
  compute it by summing `code_credit_transactions` on each read, and why.
- Confirmation the idempotency test (double-debiting the same session_id)
  actually passes, with real output.
- Test results (paste real output) including the fixture-file-based
  reconciler tests.
- Any deviation from this spec, and why.
