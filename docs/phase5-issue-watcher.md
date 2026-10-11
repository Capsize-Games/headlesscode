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
│        d. ordinary issue: state entry → done/failed                      │
│           headlesscode-job: remain spawned/running until a later sweep   │
│                                                                          │
│  5. log the sweep: found / new / skipped / spawned / deferred / failed   │
└──────────────────────────────────────────────────────────────────────────┘
```

The watcher lives in [`src/watcher/`](../src/watcher/index.ts):

- [`src/watcher/github.ts`](../src/watcher/github.ts) — the GitHub REST client
  (native `fetch`): `ghApi()`, `listIssues()` (label filter, PR filtering,
  pagination, `maxTotal` cap), `getIssue()`, lifecycle label/comment/close
  operations, pull request lookup by head branch, `createGhClient()`.
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
3. For ordinary issues, record the spawn result. For `headlesscode-job`, a
   successful spawn remains `spawned`; a later poll records `done` or `failed`
   only after every worktree has both `.harness.done/` and a valid
   `.harness.exit` value.

Consequences:

- A crash between steps 2 and 3 leaves a `spawned` entry; the next restart
  treats it as processed — **a double-spawn is impossible**.
- A crash between steps 1 and 2 leaves a `spawned` entry with no worktrees
  (the process died before the spawn). This is the safe failure direction
  (never duplicate work); the orphaned entry is visible in the state file
  for manual inspection and can be re-run by deleting the entry.

### UwUChat job intake

An issue carrying both the configured watcher label and `headlesscode-job` uses
the body sections `Task`, `Executor`, and `Submitted-by`. `Executor` must be a
single line containing `muse` or `loop`; `loop` selects the built-in HeadlessCode
executor. Only the `Task` section is sent to the worker. The other sections are
metadata; `Submitted-by` is recorded as unverified text and does not identify
or authenticate the person or service that created the issue. Intake rejects
missing, duplicate, oversized, or unsupported sections. An executor that
conflicts with an executor label or watcher-wide default is rejected before
dispatch.

After detached dispatch, the watcher keeps a `headlesscode:running` label and
reserves the worktrees against its concurrency limit. Each dispatch receives a
random attempt ID. On Linux, a detached supervisor starts the worker wrapper
behind a pipe gate, records its process group and `/proc` start time in a
private receipt directory outside the worktrees, and then releases the worker.
The supervisor waits for the wrapper's actual child exit status and for the
process group to disappear before writing an attempt-bound completion receipt.
A later continuous poll requires matching receipts and a verified-absent
process group before it reports a terminal result. Worktree
`.harness.done` and `.harness.exit` files are diagnostics only. Missing,
malformed, stale, or unverifiable identity evidence leaves the job running.
On systems without the required process identity checks, jobs remain running
for operator investigation rather than being closed from marker files.

When all exit codes are zero, the watcher
posts one bounded result summary, links only pull requests found for the exact
generated branches in the same repository, applies `headlesscode:done`, and
closes the issue. If no matching pull request exists, the result comment says
so; when branch metadata is unavailable, the comment says lookup could not be
performed and includes no PR link. A nonzero worker exit applies
`headlesscode:failed`, posts a summary, and leaves the issue open. For
OpenShell jobs, a sandbox marker left after an unverified deletion keeps the
issue running without a terminal summary until the provider verifies sandbox
absence and removes the marker. Missing or malformed markers leave it running.
Result comments carry an idempotency marker so a restart can retry GitHub updates
without posting the same result again.

These receipts prevent ordinary worker-tree files from authorizing completion;
they are not an operating-system isolation boundary against arbitrary code
running as the same host user. Operators must treat the host account and its
processes as trusted, and investigate detached or unverifiable processes before
recovering a job.

`--run-once` only performs one poll. A successful launch therefore leaves a
job issue running; completion labels, result comments, and automatic closing
require a later poll. Keep the watcher running continuously for those updates.
In runner-pool mode, terminal issue reporting does not release the permanent
runner claim. That claim remains quarantined and reserves capacity until an
operator independently confirms worker and guest teardown through the existing
claim recovery procedure.

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
  --executor <builtin|muse> Default worker implementation (default: builtin)
  --muse-model <id>      Native Muse Meta model id (requires --executor muse)
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

The ordinary watcher needs Issues: read permission. A watcher processing
`headlesscode-job` issues also needs Issues: write permission for lifecycle
labels, comments, and closing successful jobs, plus Pull requests: read
permission to find pull requests for generated branches. Create the repository
labels `headlesscode:running`, `headlesscode:done`, and `headlesscode:failed`
before enabling this intake.

`--mode` and `--memory-dir` reach the spawner env (`ORCHESTRATOR_MODE`,
`HEADLESSCODE_MEMORY_DIR`), exactly as in `orchestrate`. Workers inherit the
Phase 6 per-session budget env vars (`HEADLESSCODE_MAX_COST_USD` /
`HEADLESSCODE_MAX_DURATION_MS`) through the spawner → `run-worker.sh`, which
forwards them as `--max-cost-usd` / `--max-duration-ms` (see
[`docs/phase6-cloud.md`](./phase6-cloud.md) §2). `--qa` / `--deploy`
are **pass-through**: the watcher's job is intake (detect → split → spawn);
completion watching / review / QA / deploy remains the orchestrator's job.

The built-in HeadlessCode worker is the default. `--executor builtin|muse`
selects a watcher-wide default, and an issue can select its own executor with
one `executor:builtin` or `executor:muse` label. A Muse model can be pinned
with `--muse-model <native-id>` when the watcher default is Muse, or with one
`muse-model:<native-id>` issue label alongside `executor:muse`. Conflicting,
duplicate, or unknown executor labels fail that issue's intake; the selection
is stored with its spawned groups and retained for failed-spawn retries.

For `headlesscode-job` issues, the `Executor` body section also selects the
executor (`loop` maps to `builtin`, `muse` maps to Muse). Body selection must
agree with any executor label and configured watcher default.

For Muse jobs, install the Muse CLI on the worker machine and finish `muse login`
for the Meta account there. The worker invokes native `muse exec` with
provider `meta`; model ids are not translated from OpenRouter ids. Muse jobs
require local execution and mode `code`. They cannot run through the contained
OpenShell profile. See [Phase 2 orchestration](./phase2-orchestration.md) for
login, safety, and model-selection details.
Each batch's state entry records the issue, groups, batch id and spawnedAt,
so the follow-up is a normal `orchestrate` round:

```bash
# after the watcher spawned issue #42 into .worktrees/w1:
npx tsx src/cli.ts orchestrate --repo <path> --issue 42 --qa --deploy
```

## Operational guide

### One-shot (cron / CI)

```bash
export GH_TOKEN=ghp_...                      # scoped to the issue operations this watcher uses
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
User=headlesscode
EnvironmentFile=/etc/headlesscode/runner.env
WorkingDirectory=/opt/headlesscode
ExecStart=/usr/bin/npx --prefix /opt/headlesscode tsx /opt/headlesscode/src/cli.ts watch --owner my-org --repo /opt/my-repo --label needs-agent --poll-interval-ms 60000
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Continuous mode logs every sweep and shuts down cleanly on SIGINT/SIGTERM
(state saved via `AbortSignal`).

### Claim-based runner pool (two or more machines)

Run one continuous watcher on each machine, using the same GitHub owner,
repository, and label, but a different stable `--runner-id` for each machine.
The `--max-concurrent-sessions` setting is the capacity limit for that
machine. `--runner-assignee` is the GitHub login displayed on issues while a
claim is active; it must be configured with `--runner-id`.

Claims are authoritative records on permanent Git refs named
`headlesscode-claims/issue-N`. Initial claims use GitHub's atomic ref creation;
renewals and releases are commits advanced with non-forced fast-forward
updates. A runner checks the current claim before dispatch and records its
unique nonce and epoch in local watcher state. Issue assignees are a visible
indicator only. Do not delete claim refs: a released ref remains in place so
the next acquisition increments the epoch and cannot reuse an old claim.

Runner-pool mode requires continuous operation; `--run-once` is rejected
because it cannot renew leases. The default lease is 120 seconds and the
default poll interval is 60 seconds. The watcher rejects a poll interval above
half the configured lease so a renewal is scheduled with time remaining.
When GitHub cannot confirm a renewal, the watcher stops local worker process
groups where possible and keeps the claim active. Claims for dispatched
workers are never released from PID, PGID, completion, or sandbox markers:
those markers live in worker-writable worktrees and cannot prove that a
detached process or guest is absent. Completed or failed dispatched claims
remain quarantined and count against capacity until the lease expires and an
operator independently confirms teardown through `recoverExpired()`.
Expiration does not stop a detached process or permit automatic takeover. Do
not recover an expired claim or remove its ref while the old worker or guest
may still run.

Each machine needs its own continuously running watcher, a local clone of the
same repository, Node.js 22.19 or newer, Git, and the repository dependencies
installed with `npm ci`. Install Node.js using the machine's approved
unprivileged version manager. `gh` is needed by worker workflows that invoke
the GitHub CLI; the watcher itself uses the GitHub REST API. Configure a
separate fine-grained GitHub token on each machine with repository Contents
read/write and Issues read/write access, then make it available as `GH_TOKEN`
or `GITHUB_TOKEN`. For a systemd service, put the variable in an environment
file owned by the service account with mode `0600`; do not
put the token directly in the unit file, command line, or logs. Do not copy a
machine's model-provider credential to another machine; provision credentials
for each runner through the deployment's approved secret mechanism.

In runner-pool mode, the watcher removes GitHub token and GitHub App signing
environment variables from the spawned worker environment. This is credential
environment filtering, not an operating-system isolation boundary: a local
worker runs as the same user and may still read files, `gh` CLI authentication,
or other credentials available to that account. Keep supervisor credentials
out of worker-readable locations, or run workers under an account or contained
profile that does not have access to them.

For example, after cloning and installing dependencies on a node, configure
the service to use a distinct id and assignee:

```ini
ExecStart=/usr/bin/npx --prefix /opt/headlesscode tsx /opt/headlesscode/src/cli.ts watch --owner my-org --repo /opt/my-repo --label needs-agent --runner-id home-node --runner-assignee runner-bot --max-concurrent-sessions 1
```

Set `HEADLESSCODE_RUNNER_ID` and `HEADLESSCODE_RUNNER_ASSIGNEE` instead of the
two flags if those values belong in the protected environment file. Give the
workstation a different runner id. Keep one runner-pool watcher per machine;
the per-machine cap cannot be coordinated by two local watcher processes with
different runner ids. The watcher takes an exclusive lock under
`$XDG_STATE_HOME/headlesscode` (or
`~/.local/state/headlesscode`) and refuses to remove a stale lock
automatically. If a claim expires, first verify the old process groups are
absent on the original machine. If the machine cannot be inspected, leave the
claim quarantined; do not infer teardown from lease expiry alone. After
out-of-band confirmation that the old host's worker groups and guest resources
are gone, an authorized operator can call
`GitHubIssueClaimStore.recoverExpired()` from `src/watcher/claims.ts` with the
current ref tip, runner id, nonce, and epoch. The method rejects an unexpired
lease or a changed tip and records the operator login and supplied evidence in
the released claim commit. That API records the operator's declaration; it
cannot independently inspect or prove remote teardown. Never use it when the
old host or guest state is uncertain.

### Dry-run (CI / no-token validation)

After making `GH_TOKEN` available through the shell's protected environment,
run:

```bash
npx tsx src/cli.ts watch --owner my-org --repo ~/Projects/my-repo \
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
  [`src/watcher/__tests__/headlesscode-job.test.ts`](../src/watcher/__tests__/headlesscode-job.test.ts)
  (intake parsing, executor conflicts, running/terminal lifecycle, bounded
  comments, and same-repository PR lookup),
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
