# Phase 2 — Headless orchestration layer

Phase 2 replaces a GUI-based orchestration flow (`xdotool`-inject a task into
a VS Code window, `wmctrl`/xdotool "phone home" wake-ups) with **headless
harness subprocesses**: one background
`npx tsx src/cli.ts` process per worktree, a file/IPC completion signal, a
durable state file, and a headless reviewer — while **keeping the CLI
contract of the existing spawner script byte-for-byte compatible**.

The judgment-call logic that did NOT change: the worktree isolation pattern
(`.worktrees/`, unique Docker ports + `COMPOSE_PROJECT_NAME` per worktree),
the issue-splitting heuristics (from the `multi-agent-orchestrator` mode),
and the adversarial fresh-context reviewer checklist
(`shared/prompts/review-mode-prompt.md`).

---

## 1. The spawner contract (unchanged)

`scripts/spawn-parallel-worktrees.sh` is a drop-in replacement for the
script of the same name from the previous orchestration flow:

```bash
scripts/spawn-parallel-worktrees.sh <name1>:<offset1>:<task-file1> \
    [<name2>:<offset2>:<task-file2> ...]
```

Same behavior, still guaranteed:

| Contract point | Behavior |
| --- | --- |
| Zero args | usage to stderr, exit 1 |
| Missing task file (relative to the repo root) | exit 1 |
| Existing worktree path | skipped (idempotent re-runs) |
| Repo root | `git rev-parse --show-toplevel` (or `TARGET_REPO=<path>`) |
| Worktree location | `<root>/.worktrees/<name>` |
| Branch | `issues/<name>-<date>` off `origin/master` |
| Per-worktree `.env` | copy of the main repo's `.env` + `COMPOSE_PROJECT_NAME=headlesscode-<name>`, `POSTGRES_PORT=$((5433+offset))`, `AIRUNNER_HTTP_PORT=$((8090+offset*10))`, `VITE_PORT=$((5174+offset))` |
| Task file | copied verbatim to `<worktree>/ORCHESTRATOR_TASK.md` |
| Stdout | progress log |

The **only** replaced part is the GUI block (`code "$wt_path"` →
`sleep 20` → xdotool injection). Env overrides: `ORCHESTRATOR_MODE`
(default `code`), `HEADLESSCODE_CLI` (default `npx tsx src/cli.ts`),
`HEADLESSCODE_ROOT` (repo containing `src/cli.ts`), `TARGET_REPO`.

## 2. Worker lifecycle — `scripts/run-worker.sh`

Replaces "open a window, paste the task, press Enter". For one worktree it:

1. Runs `$HEADLESSCODE_CLI --task-file <task> --workspace <worktree> --mode <mode>`
   (or `--task <text>` for inline text) as a **detached background process**
   (`nohup setsid bash -c … &` — no X server, no display needed). `setsid`
   puts the wrapper in its OWN session/process group so a stop command can
   kill the whole tree with one negative-PID signal (issue #20: killing only
   the wrapper PID used to leave the real child running undetected,
   reparented to init).
2. Writes the worker PID to `<worktree>/.harness.pid` and — when setsid is
   available — the process-group id to `<worktree>/.harness.pgid` (written
   from inside the wrapper, so it is always the real group leader).
3. Redirects stdout+stderr to `<worktree>/harness.log`.
4. On harness exit, writes the exit code to `<worktree>/.harness.exit` and
   creates the completion marker directory `<worktree>/.harness.done/`
   (`mkdir` is atomic — the same lock-mutex convention the original
   `phone-home.sh` used, repurposed as a completion signal instead of an
   xdotool wake-up).

Stopping a worker: `scripts/stop-worker.sh <worktree-path>` kills the worker's
WHOLE process tree — SIGTERM to the recorded process group, SIGKILL after
`--grace-ms` (default 5s) if it survives, then verifies the group is gone.
`headlesscode orchestrate stop --repo <path> --group <name>` is the
orchestrated form: it stops the group's worker and marks the group
`needs-human` (terminal) so a stopped group is never left looking "running".

```bash
scripts/run-worker.sh <worktree-path> <task-file-or-text> \
    [--mode <slug>] [--model <id>] [--log-file <path>]
```

Prints the worker PID (only stdout output).

## 3. State file — `.worktrees/.orchestrator-state.json`

Durable orchestrator state, same schema as the live multi-agent file:

```json
{
  "batch": "round-2026-07-31",
  "updated": "2026-07-31T22:31:00Z",
  "groups": [
    {
      "name": "w1",
      "worktree": ".worktrees/w1",
      "branch": "issues/w1-2026-07-31",
      "issues": [27],
      "task_file": "plans/parallel-tasks/w1-issue27.md",
      "status": "spawned | running | done | failed",
      "spawned": "2026-07-31T13:46:00Z",
      "last_activity": { "last_commit": "...", "note": "..." },
      "commits": [],
      "actions_taken": [],
      "pending_review_findings": [],
      "exit_code": 0,
      "summary": "<harness.log tail>"
    }
  ]
}
```

- The **spawner** writes `spawned` → `running` entries per spawned worktree.
- The **watcher** (`src/orchestrator/watch.ts`) flips `running` → `done` /
  `failed` using the `.harness.done` marker + `.harness.exit` code, records
  `exit_code`, `summary` (harness.log tail) and `last_activity.last_commit`.
- The **reviewer step** appends `review_verdict`, `reviewed_at`,
  `pending_review_findings`.

`src/orchestrator/state.ts` provides `loadState` / `saveState` /
`updateGroup` (upsert-by-name, immutable) with deliberately loose validation
(the file may have been written by the bash spawner or an older orchestrator
instance). Plain `fs` + `JSON` — no schema library.

## 4. Issue splitting — `src/orchestrator/split.ts`

A deterministic TS port of the `multi-agent-orchestrator` mode's Step-2
heuristics (reused unchanged in spirit):

1. **Hot paths alone** — issues whose title/body match
   `request|handler|migration|database|session|auth|encryption|crypto|password|token`
   are each isolated in their own worktree; no hot-path issue is ever bundled
   with other work, and two independent hot-path issues never share a
   worktree.
2. **Same-shape batches** — mechanical work detected from title patterns
   (`split|decompose`, `coverage`, `test`, `docs`, `refactor`) is grouped so
   one worker/PR/review cycle covers a whole shape.
3. **~1 day cap** — generic (non-same-shape) groups hold at most 2 issues;
   same-shape groups at most 3.
4. **2–4 groups** — if the plan exceeds 4 groups, the smallest groups are
   merged (same-shape pairs first) until it fits; never 5+.

Output follows the task-file convention: `w1-issue27.md`,
`w2-issue29-36.md` (name + `issue` + dash-joined numbers).

## 5. The reviewer — `src/orchestrator/reviewer.ts`

`runReview({ workspaceRoot, mode?, model?, reviewPromptPath?, llmClient? })`
runs a **second harness session** against a worker's worktree/branch:

- System prompt = `shared/prompts/review-mode-prompt.md` (the reviewer
  checklist, copied verbatim into this repo) via
  `systemPromptOverride`.
- **Read-only executor** — `createReadOnlyHeadlessExecutor` registers no
  `write_to_file` at all, so the reviewer can inspect, re-run commands
  (tests, `gh`, `git diff`) and report, but can never fix anything
  (reviewer non-edit discipline enforced at the executor level).
- **Workspace-contained scratch (issue #123)** — the checklist and the
  session's task text both point any scratch the reviewer needs (probe
  scripts, temp output captures) at `<workspace>/.headlesscode/scratch/`
  and explicitly forbid `/tmp`: reviewers were the worst `/tmp` offenders
  in round-2026-08-17 (`cat > /tmp/review62.md`, …), and a `/tmp` write is
  an outside-workspace write — un-approvable in the GUI, rejected by the
  file tools, and a documented repo-rule violation.
- Returns `{ findings, verdict: "clean"|"finding", summary }` parsed from the
  `attempt_completion` result (`parseReviewResult`, exported for unit tests).
  A failed review session (LLM error / max iterations) is reported as
  `verdict: "finding"` so an inconclusive review is never mistaken for clean.

The `deepseek-reviewer` mode definition and all `.roo/rules-*/` rules stay in
the target repo as the source of truth — the harness reads them
from the workspace root at runtime, exactly as before.

## 6. Completion monitoring — `src/orchestrator/watch.ts`

`watchGroups({ repoRoot, statePath?, pollIntervalMs?, stallTimeoutMs?,
onGroupUpdate?, signal? })` replaces `wmctrl`/xdotool wake-up:

- Polls `<worktree>/.harness.done` markers + `.harness.exit` codes (short
  configurable interval, **default 5s** — no fixed 20s sleep).
- Updates the state file (`done`/`failed`, exit code, harness.log tail
  summary, `last_activity`).
- Stall guard: groups whose `spawned` timestamp exceeds
  `HEADLESSCODE_STALL_TIMEOUT` (default **2h**, matching the original 2h stall
  detection) get flagged `stalled`.
- `onGroupUpdate` is invoked on each transition — the orchestrate CLI uses it
  to trigger `runReview` on groups that finish cleanly.

## 7. CLI — `headlesscode orchestrate`

```bash
npx tsx src/cli.ts orchestrate --repo <path> --issue 27 --issue 29 --issue 38 \
    [--mode code] [--model <id>] [--batch <name>] [--issues-json <file>] \
    [--no-review] [--dry-run]
```

- Reads issues from `gh issue view --json number,title,body`
  when `gh` is available, else from `--issues-json <file>`.
- Calls `splitIssues`, writes task files to
  `<repo>/plans/parallel-tasks/<name>-issue<numbers>.md`, then **delegates the
  actual spawning to the bash script** (`scripts/spawn-parallel-worktrees.sh`)
  — the CLI stays thin.
- Starts `watchGroups`; on each group completion it runs the reviewer and
  records `review_verdict` / `pending_review_findings` in the state file.
- `--dry-run` prints the split plan + exact spawn command without spawning
  (no API key needed).
- `--plan-first` (issue #49, OPT-IN experiment): each worktree gets a SHORT
  architect-mode planning session run by the spawner BEFORE its code worker.
  The planner reads `ORCHESTRATOR_TASK.md` + the assigned issues, explores,
  and writes `PLAN.md` at the worktree root; the spawner then appends the plan
  into `ORCHESTRATOR_TASK.md` under an `## Implementation plan (from the
  plan-first phase)` section, so the code worker executes against it instead
  of re-discovering context from iteration 1. Never the default. Tune with
  `--plan-first-mode <slug>` (default `architect`) and
  `--plan-first-max-iterations <n>` (default 15 —
  `$HEADLESSCODE_PLAN_FIRST_MODE` / `$HEADLESSCODE_PLAN_FIRST_MAX_ITERATIONS`
  env fallbacks). The plan session runs SYNCHRONOUSLY inside the spawner, so N
  plan-first worktrees extend the spawn call by ~N × plan-session time. The
  group's outcome is recorded as `plan_first {mode,status,report?}` in the
  orchestrator state (`ok` = plan produced + appended; `failed` = plan session
  errored and the code worker ran without a plan — a warning + fallback, never
  a spawn abort). Intended use: compare cost / iterations / wall-clock on the
  SAME oversized multi-part issues against a plain `--mode code` round before
  considering it for the default path. The plan session's usage is recorded
  into the group's normal per-session usage files, so a round's
  cost-history/cost estimate naturally includes the planning phase.
- **Pre-flight issue-size check** (issue #53): before ANY task file is written
 or worker spawned, each issue body is scanned with a free deterministic
 heuristic (`topLevelSectionCount` in `split.ts`) that counts top-level
 numbered/bulleted sections. An issue reading like 3+ independent pieces of
 work gets a loud `WARNING` on stderr naming the issue + section count and
 suggesting splitting it into N sub-issues first — the exact shape that burned
 iteration caps and budget on real rounds. Warning-only by design: a crude
 heuristic can false-positive, so it
 never aborts the round; `--no-issue-size-check` silences it for operators who
 know what they're doing.

### `orchestrate status` — read-side status / wait for external callers

```bash
npx tsx src/cli.ts orchestrate status --repo <path> [--json]                       # one-shot
npx tsx src/cli.ts orchestrate status --repo <path> --wait [--timeout-ms <n>] [--json]  # block until terminal
```

The interactive orchestrator agent (or any external caller) uses this instead
of hand-rolling poll loops over the state file / `harness.log`:

- **One-shot** reads `.worktrees/.orchestrator-state.json` (via `loadStateSync`
  from `state.ts` — never writes, never re-implements parsing) and prints a
  compact per-group table: name, status, last activity, review verdict +
  finding count, QA verdict, per-group cost, STALLED flag, blocked question,
  plus round-level totals. `--json` prints the raw `OrchestratorState` for
  programmatic consumption.
- **`--wait`** blocks inside this ONE process — the caller makes one tool call
  and gets one result — until every group reaches a terminal status
  (`done` | `failed` | `needs-human`; `blocked` is deliberately NOT terminal:
  it is a decision-escalation wait state that keeps the wait going) or
  `--timeout-ms` elapses. It then prints the same summary plus a one-line
  verdict (`3/3 groups done, 0 failed` / `timed out after 2 of 3 groups
  done`), and with `--json` adds top-level `allDone`/`timedOut`/`verdict`
  fields.
- **Exit codes** are the whole point for scripts: `0` = every group done
  (clean), `1` = any group failed/needs-human OR the wait timed out, `2` =
  usage error. A caller that just wants yes/no can branch on exit code alone.
- **Implementation notes** (`src/orchestrator/status.ts`): `--wait` polls the
  state file at `--poll-interval-ms` (default 5s), not `fs.watch` — the
  watcher itself writes the file at that cadence, `fs.watch` on a regular
  file is unreliable when the writer replaces it via rename, and the file may
  not exist at wait-start. Default `--timeout-ms` is 2h, matching the
  watcher's stall guard (`HEADLESSCODE_STALL_TIMEOUT`): a round left
  non-terminal longer than that is flagged stalled anyway. Transient JSON
  parse errors during the wait (writer mid-save) are retried, not fatal. An
  empty state file returns immediately — nothing to wait for.

### `orchestrate review` / `orchestrate rework` / `orchestrate resume` — standalone recovery (issue #14)

The review and rework steps normally only fire as steps inside a full
`orchestrate` spawn+watch round. These subcommands expose the same steps as
independent entry points that pick up EXISTING state (see
`src/orchestrator/resume.ts`), reusing `runReview` / `handleReviewVerdict` /
`handleIterationExhaustion` / `runQaWithRetries` rather than duplicating them:

```bash
# Run the review step against an already-finished group (exit 0 = clean):
npx tsx src/cli.ts orchestrate review --repo <path> --issue 14
npx tsx src/cli.ts orchestrate review --repo <path> --pr 42            # by PR
npx tsx src/cli.ts orchestrate review --repo <path> --group w1         # by group name
# Re-spawn a worker on the SAME worktree to fix recorded findings:
npx tsx src/cli.ts orchestrate rework --repo <path> --issue 14
# Full recovery pipeline for a stuck/interrupted round (no target = all groups):
npx tsx src/cli.ts orchestrate resume --repo <path> --issue 14 [--qa] [--dry-run]
```

All three resolve the target group from `.orchestrator-state.json` (by issue
number, PR — state `pr` field then branch match — or group name) and, if the
original worktree was cleaned up, re-checkout the recorded branch into a fresh
worktree (`git worktree add -B`, preferring `origin/<branch>`).

The **rebuild step** is the first thing `resume` (and `review`) does: a
stuck/interrupted round always means the state file and disk reality have
diverged, so the group's status is re-derived from the REAL on-disk markers
(`.harness.done` / `.harness.exit` / their absence) via
`inspectGroup(repo, {...group, status: "running"}, Date.now(), stallTimeout)`
— `rebuildPatchFromMarkers` in `resume.ts`, a first-class, tested code path
(never rebuilt ad hoc). A missing worktree has no markers to rebuild from, so
the branch re-checkout is the ground truth and the group is marked `done`.

`resume` then chains the full pipeline per group: rebuild → review (skipped
when already reviewed, unless `--force-review`) → rework-if-needed (a finding
verdict left over from an interrupted round is reworked from its recorded
findings without burning a fresh review session; iteration-exhaustion failures
get a continuation) → QA (`--qa`) → cost recording. After spawning a
rework/continuation worker the group is left in-flight and `resume` reports;
re-run it once the worker finishes. `--dry-run` prints the whole plan and
changes nothing.

Worktree branches spawn off `origin/master` (with a local-`master` fallback in
`spawn-parallel-worktrees.sh`), but GitHub PR merges only ever move
`origin/master` — nothing used to push local `master`, so it silently drifted
ahead by dozens of commits and every PR-merge cycle paid for it with re-merge
conflict cascades. Two natural checkpoints now reconcile the two (see
`src/orchestrator/git-sync.ts`):

- `headlesscode orchestrate` (a real round, not `--dry-run`): before spawning,
  fetches `origin`, pushes any local-only commits, and fast-forwards local
  master onto `origin/master`, so this round's branches start from what's
  actually on GitHub.
- `headlesscode orchestrate cleanup --apply`: after the round settles, the
  same reconciliation (a local merge of a round's branch gets pushed too).

Both are best-effort auxiliary steps: a failure (auth, divergence, offline)
prints a loud warning and never aborts the round or fails cleanup. Residual
drift after a sync attempt (e.g. a true divergence — local ahead AND behind
`origin/master`) is surfaced as an actionable `WARNING` naming the manual
`git fetch` / `merge --ff-only` / `push` commands. Setting
`HEADLESSCODE_ORCHESTRATE_NO_SYNC=1` disables the mutation entirely and only
warns when local master is ahead of origin by more than `TRIVIAL_DRIFT_AHEAD`
(5) commits.

## 8. Before/after — how this replaces the GUI flow

| Previous GUI flow | headlesscode (Phase 2) |
| --- | --- |
| `code "$wt_path"` + `sleep 20` | `scripts/run-worker.sh` — detached harness process, ready instantly |
| `inject-task-into-window.sh` (xdotool paste + Enter) | `npx tsx src/cli.ts --task-file ORCHESTRATOR_TASK.md ...` |
| `phone-home.sh` (xdotool message into the orchestrator window) | `<worktree>/.harness.exit` + `<worktree>/.harness.done/` (mkdir lock mutex) |
| Orchestrator reacts to injected phone-home message | `watchGroups` polls markers (5s interval, 2h stall guard) |
| Reviewer = separate VS Code window with the review-mode prompt | `runReview()` — second harness session, read-only executor |
| Splitting judgment = the orchestrator mode's transcript | `splitIssues()` — deterministic, unit-tested, printable via `--dry-run` |
| `.orchestrator-state.json` written by hand via LLM | Written by the spawner + watcher + reviewer automatically |

## 9. Running a live parallel round (real API key)

```bash
# 1. Configure
export HEADLESSCODE_OPENROUTER_API_KEY=sk-or-...
export OPENROUTER_MODEL=deepseek/deepseek-v4-flash-0731

# 2. Preview the split + spawn command (no API key needed)
npx tsx src/cli.ts orchestrate --repo ~/Projects/my-target-repo \
  --issue 27 --issue 29 --issue 36 --issue 38 --dry-run

# 3. Run the round (spawns workers, watches, reviews)
npx tsx src/cli.ts orchestrate --repo ~/Projects/my-target-repo \
  --issue 27 --issue 29 --issue 36 --issue 38

# 4. Inspect state while it runs (one-shot), or block until the round finishes
npx tsx src/cli.ts orchestrate status --repo ~/Projects/my-target-repo
# Or wait for the whole round from one call (exit 0 = all done):
npx tsx src/cli.ts orchestrate status --repo ~/Projects/my-target-repo --wait --timeout-ms 7200000
tail -f ~/Projects/my-target-repo/.worktrees/w1/harness.log   # per-worker detail, if needed
```

Notes:

- The target repo needs a reachable `origin/master` (the spawner branches off
  it) and `.worktrees/` gitignored.
- Workers inherit `OPENROUTER_*` from the environment; the review pass runs
  against each worktree's branch with the same key/model.
- `--no-review` skips the reviewer; `HEADLESSCODE_STALL_TIMEOUT` (ms) tunes
  the stall guard.

### Phase 6 guardrails (caps/budgets — see [`phase6-cloud.md`](./phase6-cloud.md))

- **Concurrency cap:** `--max-concurrent-sessions` (default
  `$HEADLESSCODE_MAX_CONCURRENT_SESSIONS` or 3). Before spawning, `orchestrate`
  counts active sessions from the durable orchestrator + watcher state files
  (spawned/running groups + in-flight watcher spawns); at/over the cap it
  ABORTS with a clear message and exit 1 (never queues silently — the watcher
  is the queue, via durable `pending`).
- **Per-session budget:** set `HEADLESSCODE_MAX_COST_USD` /
  `HEADLESSCODE_MAX_DURATION_MS` in the environment and workers inherit them —
  `run-worker.sh` / `run-qa.sh` forward them as `--max-cost-usd` /
  `--max-duration-ms`, so every worker aborts with reason `budget` instead of
  running away on cost/time.

## 10. Tests

```bash
npm test                     # unit: engine loop + split heuristics + state + reviewer parse
bash scripts/e2e-phase2/run.sh   # Phase 2 integration (mock OpenRouter, no network/key)
bash scripts/e2e/run.sh          # Phase 1 integration (still green — mock kept backward-compatible)
```

`scripts/e2e-phase2/run.sh` verifies, end-to-end and without any GUI or API
key: the `--dry-run` split plan + spawn command, a real 2-spec spawn against a
temp repo (worktrees, `.env` isolation math, `ORCHESTRATOR_TASK.md` copies,
background workers that actually fix the fixture bug), completion markers +
exit codes, the watcher converging the state file to `done`, and a read-only
review invocation producing a verdict (the mock asserts `write_to_file` never
appears in the review session's tool list).
