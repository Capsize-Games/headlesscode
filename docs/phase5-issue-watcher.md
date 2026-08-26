# Phase 5 — GitHub issue watcher (fully automated intake)

The dream pipeline entry point: file an issue with a specific label, a watcher
picks it up, kicks off a headless session automatically — zero human action
between "issue filed" and "work starts".

This phase implements the **poll-based** watcher (project-plan Phase 5, spec
sections 5.1–5.3). The webhook upgrade (5.4) is designed but deliberately not
built as a server — see [Webhook upgrade path](#webhook-upgrade-path-spec-54).

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│  headlesscode watch --owner <o> --repo <local-clone> --label <label>     │
│                                                                          │
│  sweep loop (every pollIntervalMs, or one shot with --run-once):         │
│                                                                          │
│  1. gh.listIssues({ owner, repo, label, state: open })                   │
│        GET /repos/{o}/{r}/issues?labels=<label>&state=open&per_page=100  │
│        (PRs filtered out; paginated; capped at 1000)                     │
│                                                                          │
│  2. partition:  new (no state entry / status pending / failed+retry)     │
│                 vs already processed (skipped)                           │
│                                                                          │
│  3. cap: min(maxPerSweep, maxConcurrentSessions − active) new issues      │
│     spawned this sweep; the rest are written to state as status "pending"│
│     and picked up next sweep (label storms never spawn more than N       │
│     worktrees/sweep, and never push the total fleet past the Phase 6     │
│     global cap — active = orchestrator spawned/running groups + watcher  │
│     in-flight 'spawned' entries across processes)                        │
│                                                                          │
│  4. per issue (write-ahead ordering):                                    │
│        a. state entry {status: "spawned", groups: splitIssues([issue])}  │
│           saved  ← durable BEFORE the spawn command                      │
│        b. writeTaskFiles(...) → plans/parallel-tasks/<taskFile>          │
│        c. spawn: bash scripts/spawn-parallel-worktrees.sh <triples>      │
│           (the existing bash spawner — no worktree creation in TS)       │
│        d. state entry → {status: "done"} or {status: "failed", error}    │
│                                                                          │
│  5. log the sweep: found / new / skipped / spawned / deferred / failed   │
└──────────────────────────────────────────────────────────────────────────┘
```

The watcher lives in [`src/watcher/`](../src/watcher/index.ts):

- [`src/watcher/github.ts`](../src/watcher/github.ts) — the GitHub REST client
  (native `fetch`): `ghApi()`, `listIssues()` (label filter, PR filtering,
  pagination, `maxTotal` cap), `getIssue()`, `addLabel()`, `createGhClient()`.
  Auth via `GH_TOKEN` / `GITHUB_TOKEN`; base URL override via
  `GITHUB_API_BASE_URL` (tests/mocks). The token is **never logged** and never
  written to state.
- [`src/watcher/state.ts`](../src/watcher/state.ts) — the durable idempotency
  state file (`.worktrees/.watcher-state.json` by default):
  `loadWatcherState` / `saveWatcherState` / `markProcessed` / `isProcessed`.
- [`src/watcher/watch.ts`](../src/watcher/watch.ts) — `watchIssues()`: the
  poll loop, the per-sweep cap, write-ahead spawn, the injected `gh` /
  `spawn` seams used by the unit tests, and `defaultSpawn()` which invokes
  the **existing** `scripts/spawn-parallel-worktrees.sh` via `bash -c`
  (identical pattern to `orchestrate`).
- [`src/watcher/cli.ts`](../src/watcher/cli.ts) — the `watch` subcommand
  (thin dispatch from [`src/cli.ts`](../src/cli.ts)).

### Fan-out semantics (spec 5.2)

Each newly-seen issue becomes **one batch**: `splitIssues([issue])` produces
the worktree group(s) (the orchestration heuristics — a single issue can in
principle fan out into multiple parallel worktrees if it's large), the batch's groups
are recorded in the state entry, and the batch is spawned as one
`spawn-parallel-worktrees.sh` invocation with `name:offset:task-file` triples
under `plans/parallel-tasks/` (the same task-file builder `orchestrate`
uses — the watcher reuses it via `writeTaskFiles`, it does not duplicate it).

Bursts are bounded by `--max-per-sweep` (default 5): a label storm landing N
issues at once spawns at most N worktrees per sweep; the remainder are
recorded as `pending` and picked up on subsequent sweeps.

**Phase 6 global cap** (`--max-concurrent-sessions`, default
`$HEADLESSCODE_MAX_CONCURRENT_SESSIONS` or 3) bounds the TOTAL fleet, not just
one sweep: before spawning, the watcher counts orchestrator groups in
`spawned`/`running` + watcher entries in `spawned` across the durable state
files and caps the sweep at `maxConcurrentSessions − active`. Issues beyond the
cap stay `pending` (same durable deferral as maxPerSweep overflow) and are
spawned on a later sweep once slots free up. Effective new spawns per sweep =
`min(maxPerSweep, maxConcurrentSessions − active)` — see
[`docs/phase6-cloud.md`](./phase6-cloud.md) §3.

## Idempotency guarantees (spec 5.3)

### Write-ahead ordering

The critical crash window is *between the spawn command and the state write*.
The watcher closes it by persisting **before** spawning:

1. `markProcessed(state, { …, status: "spawned", groups, spawnedAt })` +
   `saveWatcherState()` — durable **before** the spawn command runs;
2. spawn;
3. `markProcessed(state, { …, status: "done" | "failed", error? })` + save.

Consequences:

- A crash between steps 2 and 3 leaves a `spawned` entry; the next restart
  treats it as processed — **a double-spawn is impossible**.
- A crash between steps 1 and 2 leaves a `spawned` entry with no worktrees
  (the process died before the spawn). This is the safe failure direction
  (never duplicate work); the orphaned entry is visible in the state file
  for manual inspection and can be re-run by deleting the entry.

### Restart safety

`watchIssues()` loads the state file at startup and continues from disk —
`runOnce` in cron, a full process restart, or a kill -9 mid-sweep all resume
without re-spawning already-processed issues. The unit + e2e suites simulate
restarts by re-running against the same state file.

### Label-removed behavior

The target label that triggered an issue is recorded on its state entry. If
the label is later removed from the issue, the entry persists and the watcher
still treats the issue as processed — **it will not respawn**.

### Failed spawns

A failed spawn is marked `failed` (with the error message) and logged loudly.
By default it is **not** auto-retried (prevents loops); pass `--retry-failed`
to force a retry on the next sweep. `failed` issues count toward the sweep's
`failures` and make `--run-once` exit 1.

## CLI reference

```
npx tsx src/cli.ts watch --owner <o> --repo <path> --label <target-label> [options]

  --owner <o>            GitHub owner (required)
  --repo <path>          Local clone of the target repo (required; worktrees are
                         spawned under <path>/.worktrees/). The GitHub repo name
                         defaults to the directory basename (override: --gh-repo)
  --label <name>         The label that triggers processing (e.g. needs-agent)
  --poll-interval-ms <n> Sweep interval in continuous mode (default 60000)
  --run-once             One sweep then exit 0 (or 1 if any spawn failed)
  --max-per-sweep <n>    Max NEW issues spawned per sweep (default 5)
  --max-concurrent-sessions <n>  Phase 6 GLOBAL cap on concurrent sessions
                         across processes (default $HEADLESSCODE_MAX_
                         CONCURRENT_SESSIONS or 3); issues beyond it stay
                         'pending' until slots free up
  --state-file <path>    Durable idempotency state (default:
                         <repo>/.worktrees/.watcher-state.json)
  --mode <slug>          Harness mode for workers (default: code)
  --qa / --deploy        Pass-through: recorded on each batch's state entry for
                         the follow-up orchestrate completion run (see below)
  --memory-dir <path>    Memory dir for workers (forwarded to the spawner)
  --dry-run              Sweep + print the spawn plan, spawn nothing, write no
                         state (still needs a GitHub token for listIssues)
  --retry-failed         Retry previously-failed spawns next sweep

Environment:
  GH_TOKEN / GITHUB_TOKEN     GitHub token (required; never logged)
  GITHUB_API_BASE_URL         API base URL override (tests/mocks)
  HEADLESSCODE_SPAWN_SCRIPT   Override the spawner script (e2e stubbing)
```

`--mode` and `--memory-dir` reach the spawner env (`ORCHESTRATOR_MODE`,
`HEADLESSCODE_MEMORY_DIR`), exactly as in `orchestrate`. Workers inherit the
Phase 6 per-session budget env vars (`HEADLESSCODE_MAX_COST_USD` /
`HEADLESSCODE_MAX_DURATION_MS`) through the spawner → `run-worker.sh`, which
forwards them as `--max-cost-usd` / `--max-duration-ms` (see
[`docs/phase6-cloud.md`](./phase6-cloud.md) §2). `--qa` / `--deploy`
are **pass-through**: the watcher's job is intake (detect → split → spawn);
completion watching / review / QA / deploy remains the orchestrator's job.
Each batch's state entry records the issue, groups, batch id and spawnedAt,
so the follow-up is a normal `orchestrate` round:

```bash
# after the watcher spawned issue #42 into .worktrees/w1:
npx tsx src/cli.ts orchestrate --repo <path> --issue 42 --qa --deploy
```

## Operational guide

### One-shot (cron / CI)

```bash
export GH_TOKEN=ghp_...                      # scoped, read-only-ish (issues:read)
npx tsx src/cli.ts watch \
  --owner my-org --repo ~/Projects/my-repo \
  --label needs-agent --run-once --max-per-sweep 3
```

Exit codes: `0` = sweep clean (processed or skipped); `1` = one or more spawns
or the sweep itself failed; `2` = usage/config error (e.g. missing token).
A typical cron line runs this every few minutes; the durable state file makes
repeated runs idempotent.

### Continuous (systemd)

```ini
# /etc/systemd/system/headlesscode-watch.service
[Unit]
Description=headlesscode GitHub issue watcher
After=network-online.target

[Service]
Type=simple
Environment=GH_TOKEN=ghp_your_token_here
WorkingDirectory=/opt/headlesscode
ExecStart=/usr/bin/npx --prefix /opt/headlesscode tsx /opt/headlesscode/src/cli.ts watch --owner my-org --repo /opt/my-repo --label needs-agent --poll-interval-ms 60000
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Continuous mode logs every sweep and shuts down cleanly on SIGINT/SIGTERM
(state saved via `AbortSignal`).

### Dry-run (CI / no-token validation)

```bash
GH_TOKEN=ghp_... npx tsx src/cli.ts watch --owner my-org --repo ~/Projects/my-repo \
  --label needs-agent --dry-run --run-once
```

Prints the split plan per new issue (group names + task files), spawns
nothing, and writes no state. It still requires a token for `listIssues` — a
missing token is a clear error, not a silent skip.

### Sizing

- `--max-per-sweep` bounds burst spawning; leave it low (1–5) if the workers
  share the machine.
- `--poll-interval-ms` trades latency for API calls; 60s default is fine for
  an internal label.
- The client caps at 1000 issues per `listIssues` call (pagination bound).

## Webhook upgrade path (spec 5.4)

The poll loop is the simple, dependency-free starting point. The natural
upgrade is a GitHub webhook reacting to `issues.labeled` in real time — but
this phase deliberately **does not build a server**; the design is:

- **Endpoint**: `POST /hooks/github` receiving GitHub's `issues.labeled` event
  (`X-GitHub-Event: issues`), verified by `X-Hub-Signature-256` HMAC against a
  shared secret.
- **Payload → work**: `payload.issue` (only when `payload.action ==
  "labeled"` and the label name matches the target label) is converted into
  the same `GitHubIssue` shape the poll path uses and handed to the **same
  processing function** — `splitIssues([issue])` → write-ahead state entry →
  `defaultSpawn(...)`. The webhook handler would be a thin adapter; all of the
  idempotency/fan-out/cap logic is unchanged.
- **Why the state file still matters**: webhooks are at-least-once. The same
  write-ahead + `isProcessed` check that makes the poll loop idempotent makes
  a webhook receiver idempotent too — a duplicated delivery of the same
  `labeled` event is just another sweep that skips the issue.
- **Ordering**: poll and webhook can coexist (webhook = fast path, poll =
  reconciliation). Both funnel through `watchIssues`'s per-issue processing,
  so the state file remains the single source of truth.
- **Not built here**: no HTTP listener, no signature verification, no
  deployment of the receiver. See Phase 6 for where a persistent receiver
  would run.

## Tests

- Unit: [`src/watcher/__tests__/github.test.ts`](../src/watcher/__tests__/github.test.ts)
  (URL/auth/PR-filter/pagination/errors with an injected fetch),
  [`src/watcher/__tests__/state.test.ts`](../src/watcher/__tests__/state.test.ts)
  (round-trip, isProcessed semantics, write-ahead ordering, label-removed,
  restart), [`src/watcher/__tests__/watch.test.ts`](../src/watcher/__tests__/watch.test.ts)
  (scenarios A–F: spawn once, idempotent skip, cap/pending, failure/retry,
  dry-run, abort).
- E2E: [`scripts/e2e-phase5/run.sh`](../scripts/e2e-phase5/run.sh) + a fake
  GitHub server ([`scripts/e2e-phase5/mock-github.mjs`](../scripts/e2e-phase5/mock-github.mjs)).
  The e2e **stubs the spawner** via `HEADLESSCODE_SPAWN_SCRIPT` (a script that
  creates `.worktrees/<name>/` + a `.spawn-invoked` marker) so it can assert
  state transitions + spawn invocation without creating real git worktrees or
  launching LLM workers — the real spawner is covered by the Phase 2 e2e.
