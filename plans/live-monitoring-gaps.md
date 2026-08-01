# Live monitoring gaps — instructions for implementation

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI that runs a headless coding-agent loop (ported
from a VS Code extension called Zoo Code, vendored under `src/vendor/zoo-code/`).
It is used to run unattended coding-agent sessions ("workers") against a target
repository, individually or fanned out in parallel via an orchestrator
(`src/orchestrator/`) that splits GitHub issues across git worktrees, spawns a
worker per group, watches them to completion, and runs an automated review.

The project has an established style you must match:

- No test framework (no jest/mocha/vitest). Tests are plain TypeScript files
  run directly via `tsx`, with hand-rolled `assert`-style checks and a trailer
  line like `All N tests passed`. Look at `src/dashboard/__tests__/aggregate.test.ts`
  or `src/tools/__tests__/decision.test.ts` for the exact pattern before writing
  new tests, and add any new test file to the `test` script in `package.json`
  the same way the existing entries are chained with `&&`.
- No new runtime dependencies unless there is no reasonable way to avoid it.
  Prefer plain `node:fs`, `node:http`, `node:path` — this project deliberately
  avoids frameworks and schema libraries for its state/JSON handling
  (`src/orchestrator/state.ts`'s own comments describe this ethos explicitly).
- Every failure mode that touches monitoring/logging must be **non-fatal** —
  a monitoring write failing must never abort or corrupt an actual coding
  session. Grep the codebase for `non-fatal` to see the established
  try/catch + `logger.warn` idiom used for memory recording, checkpoint
  saving, and usage recording — follow the same pattern exactly.
- `npx tsc --noEmit` must stay clean and `npm test` must stay fully green
  (currently 22 suites) after your changes. Also re-run the e2e suites under
  `scripts/e2e*/run.sh` (five of them: `e2e`, `e2e-phase2`, `e2e-phase4`,
  `e2e-phase5`, `e2e-phase6`) — they must all still pass; they exercise the
  orchestrator/watcher paths this work touches.

## The problem

A cost/token monitoring dashboard already exists (`headlesscode dashboard
--repo <path>`, implemented in `src/dashboard/server.ts` + `page.ts` +
`aggregate.ts`). It reads per-session usage records written by
`src/engine/usage.ts`'s `recordSessionUsage`, which is called exactly once —
from `src/engine/loop.ts`'s `recordUsage`, **after a session has fully
finished** (success, error, or budget-exceeded).

This means a worker that is still running is **invisible to the dashboard**.
Its cost/tokens/iteration-count only appear once it completes. For someone
watching a live orchestrated round (multiple workers running in parallel
worktrees for potentially a long time), the dashboard currently only shows
"nothing happening" until each worker finishes, even though the worker is
actively burning tokens and the harness already logs a running total per
iteration to its own log file (`this.logger.info("[usage] running total", ...)`
in `loop.ts`, going to `<worktree>/harness.log` per `run-worker.sh`).

Separately: when an orchestrated group's status changes (most importantly,
when it becomes `"blocked"` — waiting on a human/orchestrator to answer an
`ask_followup_question` — see `src/orchestrator/watch.ts`'s `inspectGroup`),
nothing is printed to `headlesscode orchestrate`'s own stdout/stderr. The
only way to notice is to actively poll `.orchestrator-state.json`. There is
no proactive signal at all — not even a log line — when a worker needs a
human's attention.

## What to build

### 1. Live (in-progress) usage visibility

Goal: `headlesscode dashboard` shows a currently-running session's
accumulating cost/tokens/iteration count, updated roughly as often as the
harness itself logs progress — not just after it finishes.

Approach (you may deviate if you find a cleaner one that fits the existing
patterns, but explain why in your final report):

- In `src/engine/loop.ts`, alongside (or instead of extending) the existing
  per-iteration `"[usage] running total"` log line, write/overwrite a small
  JSON snapshot file after each iteration — e.g.
  `<workspaceRoot>/.headlesscode/usage/<sessionId>.live.json` — containing the
  same shape of data the final record has (session id, mode, model,
  iterations so far, input/output tokens so far, cost so far, `startedAt`,
  `status: "running"`), overwritten in place each iteration (not appended —
  this is a live snapshot, not a log).
- On session completion, delete the `.live.json` file (the final record in
  `<sessionId>.jsonl` — written by the existing `recordSessionUsage` call —
  becomes the authoritative source once the session is done; don't leave a
  stale `.live.json` around after completion, including on error/budget-abort
  paths, not just the success path).
- This write must be non-fatal, same as everything else here (a failure to
  write the live snapshot must never affect the actual session).
- In `src/dashboard/aggregate.ts`, extend `buildSummary` to also scan for
  `*.live.json` files in the same directories it already scans for
  `*.jsonl` (repo root's own usage dir, and every `.worktrees/<name>/` usage
  dir), and merge them into the `sessions` list — a running session should
  appear with `status: "running"` and its current running totals. If both a
  `.live.json` and a completed `.jsonl` record exist for the same session id
  (a narrow race at the exact moment of completion), the completed record
  wins — don't double-count or show duplicates.
- Update `src/dashboard/page.ts`'s rendering so a running session is visually
  distinguishable from a completed one (e.g. a "running" badge/style) — keep
  it simple, consistent with the existing inline CSS, no new dependencies.

### 2. Proactive status-change signal from `orchestrate`

Goal: someone tailing the log of a detached `headlesscode orchestrate` run
(e.g. `nohup ... > round.log 2>&1 &` then `tail -f round.log`) sees a clear
line the moment something needs their attention, instead of having to poll
`.orchestrator-state.json` themselves.

- In `src/orchestrator/watch.ts` (or wherever the watch loop that calls
  `inspectGroup` lives — check `watchGroups`), when a group's status
  transitions to `"blocked"`, print a clear, distinct line to stderr (not
  just a structured log — something a human visually scanning a terminal
  will notice), including the group name and the question text. Example
  shape (adjust to match this file's existing logging style):
  ```
  [orchestrate] BLOCKED: group "w1" needs a decision — "<question text>"
  [orchestrate]   answer with: scripts/headlesscode-answer.sh .worktrees/w1 "<answer>"
  ```
- Also print a line on every other status transition worth knowing about
  without polling: a group reaching `"done"` or `"failed"`, and (if not
  already printed elsewhere) the final review verdict per group. Keep these
  concise, one line each.
- Only print on a genuine transition (don't spam the same line every poll
  interval while a group stays blocked/running) — track previously-seen
  status per group within the watch loop's own state and only print on
  change.

### 3. Tests

- Extend `src/dashboard/__tests__/aggregate.test.ts` (or add a sibling file)
  covering: a `.live.json` file with no corresponding `.jsonl` shows up as a
  running session; when both exist, the completed `.jsonl` record wins and
  there's no duplicate; a `.live.json` for a session that also completed and
  had its live file cleaned up correctly shows only the completed record.
- Add a focused test (new file or extend an existing one in
  `src/engine/__tests__/`) proving a live snapshot file is written during a
  session's iterations and removed on completion (cover success, error, and
  budget-exceeded end states — all three must clean up the live file).
- Add a test for the new transition-only stdout/stderr behavior in
  `src/orchestrator/__tests__/watch.test.ts` (or wherever its tests live):
  confirm a line is printed once on the transition into `"blocked"`, not
  repeated on subsequent polls while still blocked, and printed again on the
  transition to `"done"`/`"failed"`.

## What NOT to do

- Do not change the final `<sessionId>.jsonl` usage record format — the
  dashboard's existing "completed sessions" behavior must be unaffected,
  this is additive.
- Do not add authentication, remote access, or change the dashboard's
  localhost-only binding — it stays a local, read-only, no-auth tool.
- Do not build an automatic rework/retry loop for review findings — that is
  a separate, deliberately out-of-scope concern, not part of this task.
- Do not touch `~/Projects/airunner` — this work is entirely inside the
  `headlesscode` repository.

## Verification checklist (do this yourself before reporting back)

1. `npx tsc --noEmit` — must be clean.
2. `npm test` — all suites green, including your new ones.
3. Run all five e2e suites under `scripts/e2e*/run.sh` and confirm they
   still pass (they exercise real spawn/watch/review flows that this
   touches).
4. A real manual smoke test: start a session against a scratch workspace
   (the existing `scripts/e2e/mock-openrouter.mjs` pattern — a small local
   HTTP server standing in for OpenRouter — is the fastest way to get a
   multi-iteration session without a real API key; look at
   `scripts/e2e/run.sh` for how it's invoked). While that session is still
   running, in a second shell run `headlesscode dashboard --repo <that
   workspace>` and confirm `curl localhost:<port>/api/summary` shows the
   session with `status: "running"` and a nonzero cost/iteration count
   *before* the session finishes, then shows it as completed afterward with
   no leftover `.live.json` file on disk.
5. A real manual smoke test of the blocked-transition log line: craft a
   scenario where a worker calls `ask_followup_question` (there should
   already be a fixture/pattern for this from the decision-escalation work —
   check `src/tools/__tests__/decision.test.ts` for how a fake LLM client
   triggers it) running under `headlesscode orchestrate`, and confirm the
   `BLOCKED:` line appears on stderr/log exactly once when it happens, not
   repeated on every poll.

## What to report back

When you are done, write a short summary covering:

- Exactly which files you changed or added.
- Confirmation that `tsc`, `npm test`, and all five e2e suites pass (paste
  the final pass/fail line counts, don't just say "they pass").
- The manual smoke test results from steps 4 and 5 above, including what you
  actually observed (e.g. the real `curl` output showing a running session).
- Any deviation from this spec, and why you made that choice.
- Anything you found while doing this that seems like a related bug or gap,
  even if you didn't fix it — flag it rather than silently ignoring it.
