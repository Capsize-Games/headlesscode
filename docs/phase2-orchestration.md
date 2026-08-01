# Phase 2 — Headless orchestration layer

Phase 2 replaces the GUI-based orchestration of the airunner repo
(`xdotool`-inject a task into a VS Code window, `wmctrl`/xdotool "phone home"
wake-ups) with **headless harness subprocesses**: one background
`npx tsx src/cli.ts` process per worktree, a file/IPC completion signal, a
durable state file, and a headless reviewer — while **keeping the CLI
contract of the existing spawner script byte-for-byte compatible**.

The judgment-call logic that did NOT change: the worktree isolation pattern
(`.worktrees/`, unique Docker ports + `COMPOSE_PROJECT_NAME` per worktree),
the issue-splitting heuristics (from the airunner `multi-agent-orchestrator`
mode), and the adversarial fresh-context reviewer checklist
(`plans/zoo-code-review-mode-prompt.md`).

---

## 1. The spawner contract (unchanged)

`scripts/spawn-parallel-worktrees.sh` is a drop-in replacement for
airunner's script of the same name:

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
| Per-worktree `.env` | copy of the main repo's `.env` + `COMPOSE_PROJECT_NAME=airunner-<name>`, `POSTGRES_PORT=$((5433+offset))`, `AIRUNNER_HTTP_PORT=$((8090+offset*10))`, `VITE_PORT=$((5174+offset))` |
| Task file | copied verbatim to `<worktree>/ORCHESTRATOR_TASK.md` |
| Stdout | progress log |

The **only** replaced part is the GUI block (airunner's `code "$wt_path"` →
`sleep 20` → xdotool injection). Env overrides: `ORCHESTRATOR_MODE`
(default `code`), `HEADLESSCODE_CLI` (default `npx tsx src/cli.ts`),
`HEADLESSCODE_ROOT` (repo containing `src/cli.ts`), `TARGET_REPO`.

## 2. Worker lifecycle — `scripts/run-worker.sh`

Replaces "open a window, paste the task, press Enter". For one worktree it:

1. Runs `$HEADLESSCODE_CLI --task-file <task> --workspace <worktree> --mode <mode>`
   (or `--task <text>` for inline text) as a **detached background process**
   (`nohup bash -c … &` — no X server, no display needed).
2. Writes the worker PID to `<worktree>/.harness.pid`.
3. Redirects stdout+stderr to `<worktree>/harness.log`.
4. On harness exit, writes the exit code to `<worktree>/.harness.exit` and
   creates the completion marker directory `<worktree>/.harness.done/`
   (`mkdir` is atomic — the same lock-mutex convention airunner's
   `phone-home.sh` uses, repurposed as a completion signal instead of an
   xdotool wake-up).

```bash
scripts/run-worker.sh <worktree-path> <task-file-or-text> \
    [--mode <slug>] [--model <id>] [--log-file <path>]
```

Prints the worker PID (only stdout output).

## 3. State file — `.worktrees/.orchestrator-state.json`

Durable orchestrator state, same schema as the live airunner file:

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

A deterministic TS port of the airunner `multi-agent-orchestrator` mode's
Step-2 heuristics (reused unchanged in spirit):

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

Output follows the airunner task-file convention: `w1-issue27.md`,
`w2-issue29-36.md` (name + `issue` + dash-joined numbers).

## 5. The reviewer — `src/orchestrator/reviewer.ts`

`runReview({ workspaceRoot, mode?, model?, reviewPromptPath?, llmClient? })`
runs a **second harness session** against a worker's worktree/branch:

- System prompt = `plans/zoo-code-review-mode-prompt.md` (the airunner
  reviewer checklist, copied verbatim into this repo) via
  `systemPromptOverride`.
- **Read-only executor** — `createReadOnlyHeadlessExecutor` registers no
  `write_to_file` at all, so the reviewer can inspect, re-run commands
  (tests, `gh`, `git diff`) and report, but can never fix anything
  (reviewer non-edit discipline enforced at the executor level).
- Returns `{ findings, verdict: "clean"|"finding", summary }` parsed from the
  `attempt_completion` result (`parseReviewResult`, exported for unit tests).
  A failed review session (LLM error / max iterations) is reported as
  `verdict: "finding"` so an inconclusive review is never mistaken for clean.

The `deepseek-reviewer` mode definition and all `.roo/rules-*/` rules stay in
the target repo (airunner) as the source of truth — the harness reads them
from the workspace root at runtime, exactly as before.

## 6. Completion monitoring — `src/orchestrator/watch.ts`

`watchGroups({ repoRoot, statePath?, pollIntervalMs?, stallTimeoutMs?,
onGroupUpdate?, signal? })` replaces `wmctrl`/xdotool wake-up:

- Polls `<worktree>/.harness.done` markers + `.harness.exit` codes (short
  configurable interval, **default 5s** — no fixed 20s sleep).
- Updates the state file (`done`/`failed`, exit code, harness.log tail
  summary, `last_activity`).
- Stall guard: groups whose `spawned` timestamp exceeds
  `HEADLESSCODE_STALL_TIMEOUT` (default **2h**, matching airunner's 2h stall
  detection) get flagged `stalled`.
- `onGroupUpdate` is invoked on each transition — the orchestrate CLI uses it
  to trigger `runReview` on groups that finish cleanly.

## 7. CLI — `headlesscode orchestrate`

```bash
npx tsx src/cli.ts orchestrate --repo <path> --issue 27 --issue 29 --issue 38 \
    [--mode code] [--model <id>] [--batch <name>] [--issues-json <file>] \
    [--no-review] [--dry-run]
```

- Reads issues from airunner-style `gh issue view --json number,title,body`
  when `gh` is available, else from `--issues-json <file>`.
- Calls `splitIssues`, writes task files to
  `<repo>/plans/parallel-tasks/<name>-issue<numbers>.md`, then **delegates the
  actual spawning to the bash script** (`scripts/spawn-parallel-worktrees.sh`)
  — the CLI stays thin.
- Starts `watchGroups`; on each group completion it runs the reviewer and
  records `review_verdict` / `pending_review_findings` in the state file.
- `--dry-run` prints the split plan + exact spawn command without spawning
  (no API key needed).

## 8. Before/after — how this replaces the airunner GUI flow

| Airunner (GUI) | headlesscode (Phase 2) |
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
export OPENROUTER_API_KEY=sk-or-...
export OPENROUTER_MODEL=deepseek/deepseek-chat

# 2. Preview the split + spawn command (no API key needed)
npx tsx src/cli.ts orchestrate --repo ~/Projects/airunner \
  --issue 27 --issue 29 --issue 36 --issue 38 --dry-run

# 3. Run the round (spawns workers, watches, reviews)
npx tsx src/cli.ts orchestrate --repo ~/Projects/airunner \
  --issue 27 --issue 29 --issue 36 --issue 38

# 4. Inspect state while it runs
cat ~/Projects/airunner/.worktrees/.orchestrator-state.json
tail -f ~/Projects/airunner/.worktrees/w1/harness.log
```

Notes:

- The target repo needs a reachable `origin/master` (the spawner branches off
  it) and `.worktrees/` gitignored (as in airunner).
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
