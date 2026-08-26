# Phase 6 — Cloud scaling: guardrails first, then ephemeral compute

Phase 6 in the project plan has three threads (spec 6.1/6.2/6.3):

1. **6.3 — guardrails (implemented, this phase's core):** a hard
   concurrent-session cap + a per-session cost/time/iteration budget. The spec
   is explicit that these MUST land *before* any cloud scaling — an
   issue-triggered pipeline with no caps can run away on cost the first time
   something loops or a burst of issues lands at once.
2. **6.1 — ephemeral compute abstraction (interface + local impl):** the
   "container/VM per issue → run harness → tear down" pattern ports the Phase 2
   worktree+Docker pattern; it slots in behind one small interface with a local
   reference implementation. No live cloud resources are launched.
3. **6.2 — cloud runner-fleet evaluation (documented, not built):** this doc
   evaluates reusing existing self-hosted GitHub Actions runners vs. dedicated
   containers/cloud VMs and makes a recommendation. No live setup.

Implementable scope for this phase = **the guardrails + the provider
abstraction + the evaluation**. Everything below is committed-ready, tested
against local mocks only.

---

## 1. Guardrails first — why caps/budgets precede cloud

The pipeline is now fully automated end-to-end: Phase 5 watcher picks up a
labeled issue, splits it, and spawns harness sessions that run until they
finish (or fail bounded). That is exactly the shape of system that needs cost
guardrails *before* it gets more parallel capacity:

- **A looping session** (model keeps calling tools, never completes) burns
  tokens until `maxIterations` (default 50) stops it — with no cost cap that
  is 50 × N tokens of spend per runaway session, per cloud instance.
- **A label storm** (10 issues land in an hour) spawns 10+ sessions; without a
  concurrent-session cap there is no upper bound on simultaneous spend.
- **Ephemeral compute makes runaway worse**: every spawned cloud instance has
  a *creation* cost too (VM/container time), so a storm doesn't just burn
  tokens, it burns compute-hours for instances that may never finish useful
  work.

The two guardrails implemented here close both holes *before* the fleet
grows:

- **`BudgetTracker` (per-session):** every LLM call's token usage flows into a
  running USD estimate; elapsed wall-clock and iteration count are checked
  before every call. Any limit that trips aborts the session (`status:
  "error"`, `reason: "budget"`) instead of spending further.
- **`ConcurrencyLimiter` + `activeSessionCount` (global):** a hard cap on how
  many sessions run at once, enforced *before anything is spawned*, in both
  spawners (orchestrate aborts; watcher defers to durable `pending`).

---

## 2. Per-session budget (6.3) — `src/budget/`

### 2.1 Pricing — `src/budget/cost.ts`

`estimateCost({ model, inputTokens, outputTokens })` converts a provider's
usage tokens to USD:

```
cost = inputTokens × price.input / 1e6 + outputTokens × price.output / 1e6
```

- Default pricing table (USD per 1M tokens): `deepseek/deepseek-chat`
  ($0.27 / $1.10), `deepseek/deepseek-reasoner` ($0.55 / $2.19), plus a
  general model reference (`anthropic/claude-3.5-sonnet` $3 / $15).
- Override in code (constructor/`estimateCost` `pricing` arg) or via
  `HEADLESSCODE_PRICING_JSON` (path to a JSON file deep-merged over the
  defaults).
- **Unknown models fall back to a conservative rate (never $0)** — a cost cap
  must not be bypassable by running an unlisted model id. A broken pricing
  file throws (fail loud, never weaken a cap).

### 2.2 Tracker — `src/budget/budget.ts`

`SessionBudget { maxCostUsd?, maxDurationMs?, maxIterations? }` — all limits
optional. `BudgetTracker` is pure (injectable clock + pricing):

- `tick()` — before each LLM call: increments the iteration counter and
  re-checks elapsed time, iteration count and accumulated cost (so a previous
  call's spend can never slip past the cap before the next call).
- `record({ model, inputTokens, outputTokens })` — after each LLM call:
  accumulates estimated cost and checks the cost cap.
- `check()` — non-throwing `{ ok, reason?, costUsd, elapsedMs, iterations }`.
- Any trip throws `BudgetExceededError { reason: "cost"|"duration"|"iterations" }`.

### 2.3 Session enforcement — `src/engine/loop.ts`

`HeadlessSession` gains an optional `budget?: SessionBudget | null` config
(default `null` → **zero behavior change**; all 107 pre-existing tests pass
unchanged). When set:

1. a `BudgetTracker` is created at session start;
2. `tick()` runs before each LLM call (elapsed + iterations + accumulated
   cost);
3. the LLM response's `usage` (already surfaced by `OpenRouterClient`) is fed
   to `record()` (cost accumulation);
4. on a trip the loop returns `{ status: "error", reason: "budget", error:
   "Budget exceeded: …" }` instead of making another call;
5. `SessionResult.budgetUsage` (`{ costUsd, elapsedMs, iterations, model }`)
   is attached to every result when a budget is configured.

### 2.4 CLI + workers

- Base CLI: `--max-cost-usd <n>` / `--max-duration-ms <n>` (flags win over
  `HEADLESSCODE_MAX_COST_USD` / `HEADLESSCODE_MAX_DURATION_MS`).
- On a budget abort the CLI prints the `[budget] cost $…` line + "task aborted
  by budget" and exits 1.
- `scripts/run-worker.sh` / `scripts/run-qa.sh` forward
  `HEADLESSCODE_MAX_COST_USD` / `HEADLESSCODE_MAX_DURATION_MS` to the worker
  CLI as `--max-cost-usd` / `--max-duration-ms` (so a budgeted worker aborts
  with reason `budget` instead of running away). `HEADLESSCODE_PRICING_JSON`
  flows through inherited env. Workers get their budget from the orchestrate /
  watch process environment, so one fleet-wide setting caps every worker.
- Note: the in-process reviewer/QA sessions (runReview/runQa inside
  `orchestrate`) do not currently consume a budget; wiring
  `sessionBudgetFromEnv()` into them is the natural follow-up if a reviewer or
  QA round needs the same guardrail.

---

## 3. Global concurrency cap (6.3) — `src/budget/concurrency.ts`

Two layers:

| Layer | Mechanism | Covers |
| --- | --- | --- |
| In-process | `ConcurrencyLimiter { maxSessions, acquire(), release(), current() }` — counting semaphore, **fail-fast** (returns `{ ok: false, reason }`, never queues) | the spawn loop *inside* one process |
| Cross-process | `activeSessionCount(orchState, watcherState)` — counts orchestrator groups with status `spawned`/`running` + watcher entries with status `spawned` (write-ahead, spawn in flight) | several processes (orchestrate, watcher, cron) against the same repo |

**Fail-fast over queueing — documented decision:** a headless spawner has no
place to hold "waiting" work unless it is the watcher (which already has a
durable `pending` mechanism). Queuing inside the limiter would either silently
drop work on crash or hide a full fleet from the operator. So:
`ConcurrencyLimiter` fails fast; the **orchestrate** CLI aborts with a clear
message + exit 1 when the cap is reached; the **watcher** treats the durable
`pending` state as its queue and defers cap-exceeding issues to a later sweep.

Default cap: `HEADLESSCODE_MAX_CONCURRENT_SESSIONS` (default **3**), CLI flag
`--max-concurrent-sessions` on both `orchestrate` and `watch`.

### Enforcement points

- **`orchestrate`** (`src/orchestrator/cli.ts`): before spawning, compute
  `activeSessionCountForRepo(repo)` (loads both durable state files). At/over
  the cap → abort with a clear message, exit 1, nothing spawned.
- **`watch`** (`src/watcher/watch.ts`): per sweep,
  `available = cap − active(from orchestrator state + watcher state)`, then
  `toSpawn = min(maxPerSweep, available)`. Cap-exceeding issues are marked
  `pending` (same durable deferral as `maxPerSweep` overflow) and picked up on
  a later sweep. A mid-sweep in-process `acquire()` failure (fleet picture
  changed) also defers to `pending` — never over-spawns.

### Interplay: `maxPerSweep` vs the global cap

```
effective spawns this sweep = min(maxPerSweep, maxConcurrentSessions − active)
```

- `maxPerSweep` bounds the **burst** of one sweep (a label storm never spawns
  more than N worktrees in one tick).
- The global cap bounds the **fleet total** across processes and sweeps (a
  label storm can never push the total running/spawned sessions past the cap,
  even when several watchers/orchestrates share a repo).
- Both are fail-safe: exceeding issues stay `pending`, never silently spawned
  or dropped.

---

## 4. Ephemeral compute abstraction (6.1) — `src/cloud/provider.ts`

### The contract

```ts
interface CloudProvider {
  name: string
  spawnWorktreeSession({ repo, issue, worktreeSpec, env }): Promise<SessionHandle>
  waitReady(handle): Promise<void>
  runHarness(handle, cmd): Promise<{ exitCode, output }>
  collectResults(handle): Promise<Record<string, unknown>>
  teardown(handle): Promise<void>
}
```

`SessionHandle { id, provider, address? }` — opaque; cloud details (image,
volume, network) are implementation concerns. The orchestration layer calls
the same five methods regardless of backend.

### How the Phase 2 worktree+Docker pattern ports to ephemeral compute

Phase 2's isolation pattern (per `docs/phase2-orchestration.md`): one git
worktree per worker under `<repo>/.worktrees/<name>`, a per-worktree `.env`
with unique Docker ports (`POSTGRES_PORT=5433+offset`, `AIRUNNER_HTTP_PORT`,
`VITE_PORT`) and a unique `COMPOSE_PROJECT_NAME=headlesscode-<name>` so each
worktree's Docker stack is fully isolated (independent networks/containers)
even on one host.

The ephemeral-cloud port keeps the *semantics* and swaps the *execution*:

| Phase 2 local | Phase 6 ephemeral cloud |
| --- | --- |
| `git worktree add` under `.worktrees/<name>` | `spawnWorktreeSession` creates a fresh container/VM per issue (worktree clone inside) |
| unique ports + `COMPOSE_PROJECT_NAME` per worktree (multi-stack on one host) | per-instance network/volume namespace (Docker `--network` per container / VM NIC) — no port math needed because instances don't share a host port space |
| `run-worker.sh` launches the harness subprocess in the worktree | `runHarness` runs the same harness command inside the container/VM |
| `.harness.done` marker + `harness.log` polled by `watchGroups` | `collectResults` returns the same shape (exit code, done flag, log summary) |
| worktrees persist for inspection | `teardown` deletes the container/VM after results are collected (ephemeral by design) |

The interface is deliberately small so 6.1's "container/VM per issue" slots in
behind it without touching the orchestration layer.

### `LocalProcessProvider` — the current behavior, behind the interface

`LocalProcessProvider` IS today's local flow: task files via the shared
builder, `scripts/spawn-parallel-worktrees.sh` for the worktree, readiness via
`.harness.pid`, `scripts/run-worker.sh` for the harness, results from
`.harness.exit` / `.harness.done` / `harness.log`, stopping via
`scripts/stop-worker.sh` (issue #20 — kills the worker's whole process group
via the `.harness.pgid` recorded at launch), teardown via
`git worktree remove --force`. Injectable `run` / `waitForReady` seams + a
`dryRun` mode keep it unit-testable with no real worktrees or processes (see
`src/cloud/__tests__/provider.test.ts` — documented as the lighter contract
test; the real scripts are covered by the Phase 2/5 e2e suites).

A `HetznerDockerProvider` is a documented **sketch** (`hetznerDockerProviderSketch`
in `provider.ts`) — explicitly NOT implemented against any live provider.

---

## 5. Self-hosted runner-fleet evaluation (6.2)

### What a runner fleet provides

A self-hosted runner fleet (e.g. GH Actions runners on bare metal / dedicated
VMs registered with a cloud provider) already provides:

- a persistent Linux host,
- Docker (the standard GH Actions self-hosted toolchain),
- a GitHub registration token + runner agent (auto-starts work from the
  Actions queue),
- a network identity/SSH setup the team already manages.

### Option A — reuse the runner fleet as the harness pool (evaluate first)

A harness job can run as a **runner job**: the watcher (or a thin bridge) opens
an issue on a queue repo with a `needs-harness` label / workflow dispatch; a
self-hosted runner picks it up and runs the harness inside the job (`docker
run` the harness image with the repo mount, or run `npx tsx src/cli.ts`
directly on the runner). What you get for free:

- **Provisioning is already solved** — no new hosts, no new credentials, no
  new cost line item (the fleet already runs 24/7 for CI).
- **Docker is already there** — `docker run` per issue gives the same
  container-per-issue isolation as the Phase 2 pattern, without the port math
  (each `docker run` gets its own network namespace; the worktree stays inside
  the container).
- **Queueing for free** — the GH Actions job queue is the durable
  `pending`-equivalent for the global concurrency cap: cap the runners'
  `concurrency` group in the workflow, and over-cap issues queue instead of
  spawning.

Tradeoffs vs. dedicated containers:

- Runner slots are shared with CI — a big Actions load can starve harness
  jobs (mitigate: a `concurrency` group + a separate label/runners for
  harness-only work).
- The job queue adds GH-API latency vs. a direct spawn.
- Runners are long-lived hosts; "container per issue, tear down" is still
  ephemeral *per job*, but the host itself persists (fine — the harness has no
  host-level state to isolate beyond the container).
- Cost accounting: runner hosts are fixed-cost (already paid); containers add
  marginal CPU/RAM usage, not new instances. Cheapest path to scale.

### Option B — dedicated ephemeral containers/VMs (cloud provider API)

A cloud provider API (e.g. `hcloud` on Hetzner): create a fresh VM (or a container on
an existing Docker host) per issue, run the harness, snapshot results, delete.
This matches 6.1's "ephemeral per issue" most literally, but:

- new credentials + lifecycle handling (create → wait → run → collect →
  delete, with a **teardown-on-crash guarantee** — this is exactly why the
  guardrails must exist first: an orphaned cloud instance is a billable
  runaway);
- per-instance billing makes the concurrent-session cap a *hard money
  control*, not just a fairness control;
- more moving parts than a system that already exists and is already paid for.

### Recommendation

**Reuse existing self-hosted runners as the harness pool (Option A)** as the
first cloud deployment: one extra workflow + a Docker image, no new
infrastructure, the job queue gives the concurrency cap a natural enforcement
point, and the harness's `CloudProvider` contract means the runner job and a
future dedicated-container implementation are the same five methods. Keep
Option B in reserve for when the fleet saturates and per-instance isolation or
burst capacity is actually required — at which point
`HetznerDockerProvider` (behind the same interface) is the migration path.
**No live setup was performed as part of this phase** (evaluation only).

---

## 6. Cost model example for one session

Baseline: one harness session, `deepseek/deepseek-v4-flash-0731`
($0.14/1M input, $0.28/1M output).

| Call | Input | Output | Cost |
| --- | --- | --- | --- |
| system+task read | 2 000 | 0 | $0.00028 |
| tool-call round 1 | 1 500 | 300 | $0.00029 |
| tool-call round 2 | 1 800 | 350 | $0.00035 |
| attempt_completion | 900 | 120 | $0.00016 |
| **Total** | **6 200** | **770** | **≈ $0.0011** |

At the default `maxIterations = 50`, the absolute worst case is ~50 tool-call
rounds ≈ $0.03–$0.08 depending on context growth — hence the default
recommendation of a per-session cap like `--max-cost-usd 0.05` for
`deepseek/deepseek-v4-flash-0731` work. A fleet of 3 concurrent sessions (default cap) with that
per-session budget bounds a full pipeline round at roughly **$0.15 worst
case**, before the review/QA rounds (which reuse the same budget mechanism via
the same env vars). Raise the cap only when a session legitimately needs more
turns; the guardrail is meant to catch runaways, not to be a tight fit for
normal work.

## 7. Where everything lives

| Piece | File(s) |
| --- | --- |
| Pricing + estimation | `src/budget/cost.ts` |
| Budget tracker + error + env helper | `src/budget/budget.ts` |
| Concurrency limiter + cross-process count | `src/budget/concurrency.ts` |
| Session enforcement | `src/engine/loop.ts`, `src/engine/types.ts` |
| CLI flags (base) | `src/cli.ts` |
| Cap enforcement (orchestrate) | `src/orchestrator/cli.ts` |
| Cap enforcement (watcher) | `src/watcher/watch.ts`, `src/watcher/cli.ts` |
| Worker/QA budget forwarding | `scripts/run-worker.sh`, `scripts/run-qa.sh` |
| Cloud abstraction + local impl | `src/cloud/provider.ts` |
| Unit tests | `src/budget/__tests__/`, `src/cloud/__tests__/` |
| E2E | `scripts/e2e-phase6/run.sh` |

## 8. Env reference (Phase 6)

| Env | Default | Meaning |
| --- | --- | --- |
| `HEADLESSCODE_MAX_CONCURRENT_SESSIONS` | 3 | Global cap; orchestrate aborts, watcher defers to `pending` |
| `HEADLESSCODE_MAX_COST_USD` | unset (off) | Per-session USD cost cap (worker/QA CLI flag fallback) |
| `HEADLESSCODE_MAX_DURATION_MS` | unset (off) | Per-session wall-clock cap, ms |
| `HEADLESSCODE_PRICING_JSON` | unset | Path to a pricing override JSON (deep-merged over defaults) |
