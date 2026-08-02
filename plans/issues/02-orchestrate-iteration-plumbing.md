Title: Orchestrate: forward --max-iterations/budget to workers and auto-continue a group on iteration-exhaustion instead of hard-failing

## Context

This is `headlesscode`, a standalone Node/TypeScript CLI that runs a headless
coding-agent loop (ported from Zoo Code) plus a parallel-worktree orchestrator
(`headlesscode orchestrate`, implemented in `src/orchestrator/`, spawning
workers via `scripts/spawn-parallel-worktrees.sh` → `scripts/run-worker.sh`).

A real orchestrated round exposed a systemic problem: the worker harness loop
caps a session at `DEFAULT_MAX_ITERATIONS` (50, see `src/engine/loop.ts`'s
`config.maxIterations`; when exhausted it fails with the error
`Max iterations (N) reached without task completion` at the end of the loop in
`src/engine/loop.ts`). That cap is a *bounded-failure guard* (stop a
non-converging loop), but it is a terrible unit for "how big is this task":
a multi-phase task (e.g. three dependent phases, each needing full
tsc/test/e2e verification) routinely exceeds 50 iterations per session. The
observed failure mode:

- `headlesscode orchestrate --issue <n>` spawns the worker **without any
  way to raise the cap**: `spawnCommandFor` in `src/orchestrator/cli.ts`
  only forwards `--mode` (and model), and `scripts/run-worker.sh` only
  accepts `--mode`/`--model`/`--log-file`. So every orchestrated worker runs
  with the 50-iteration default no matter what.
- When the worker hits the cap it exits 1, writes `.harness.exit` + the
  `.harness.done` marker, and the watcher (`src/orchestrator/watch.ts`, the
  `exitCode === 0 ? "done" : "failed"` branch) marks the group `failed` —
  a terminal state with no automatic continuation, even though the worktree
  state is perfectly resumable (the partial edits are still on disk). The
  rework loop (`handleReviewVerdict` in `src/orchestrator/cli.ts`) already
  demonstrates the "re-spawn a worker on the SAME worktree" pattern for
  review findings — iteration-exhaustion needs the same treatment.
- A related accounting gap surfaced in the same round: the model actually
  used was `deepseek/deepseek-v4-flash`, which is **missing from
  `DEFAULT_PRICING_TABLE`** in `src/budget/cost.ts` (only
  `deepseek/deepseek-chat`, `deepseek/deepseek-reasoner`,
  `anthropic/claude-3.5-sonnet` are listed). Missing models fall back to
  `FALLBACK_MODEL_PRICE` ($2.0/M input, $8.0/M output), which over-estimated
  a ~$0.59 real spend as ~$4.36 (~7x). Budget/cost accounting must not
  mislead by that margin for a model this project actually runs workers on.

Match this project's established style:

- No test framework — plain `tsx`-run test files, hand-rolled assertions, an
  `All N tests passed` trailer line (see `src/orchestrator/__tests__/cli.test.ts`
  or `src/budget/__tests__/cost.test.ts` for the pattern). Add new test files
  to `package.json`'s `test` script the same way existing entries are chained
  with `&&`.
- No new runtime dependencies. Plain `node:fs`/`node:child_process`, no
  frameworks.
- `npx tsc --noEmit` and `npm test` must stay green. This touches the
  orchestrator + spawn/worker scripts, so also re-run the relevant suites
  under `scripts/e2e*/run.sh` (at minimum `e2e`, `e2e-phase2`, and the
  fixture-based spawn tests) — they exercise real spawn/watch flows against
  the local mock LLM server.

## What to build

### Part 1 — forward the iteration cap and budget to orchestrated workers

- `src/orchestrator/cli.ts`: add an `--max-iterations <n>` option to
  `parseOrchestrateArgs` (default: `$HEADLESSCODE_MAX_ITERATIONS` or the
  harness's existing default, 50 — don't change the harness default itself,
  just make it overridable at the round level). Thread it through
  `spawnCommandFor`/the spawn env so it reaches the worker.
- `scripts/spawn-parallel-worktrees.sh` + `scripts/run-worker.sh`: forward the
  value as `--max-iterations <n>` to the worker CLI, mirroring how the
  existing `HEADLESSCODE_MAX_COST_USD`/`HEADLESSCODE_MAX_DURATION_MS` env vars
  are already forwarded as CLI flags in `run-worker.sh` (the `BUDGET_ARG`
  pattern). Support both an explicit flag on `run-worker.sh` and the
  `HEADLESSCODE_MAX_ITERATIONS` env var, so orchestrate can pass it through
  the environment (inherited, like `OPENROUTER_*`).

### Part 2 — auto-continue a group on iteration-exhaustion instead of hard-failing

The goal: when a worker fails specifically because it hit the iteration cap,
treat that as "the task is bigger than one session" and re-spawn a continuation
worker on the SAME worktree (the partial state is on disk; the next session
picks up where the last left off), rather than marking the group `failed`.

- Detect the condition. The worker exit code alone (1) can't distinguish
  "iteration cap" from "real error" — the harness records the specific reason
  in its log (`Max iterations (N) reached without task completion`, the
  `result.error` from `src/engine/loop.ts`). The watcher already tails
  `harness.log` for the group summary (`src/orchestrator/watch.ts`); use a
  stable, testable signal — e.g. the exit-code plus a match on that exact
  error string in the summary — to decide "continuable exhaustion" vs "real
  failure". Add an exported helper (pure, unit-testable) that makes this
  decision so the watcher's logic stays thin.
- Reuse the rework-loop machinery's spirit (NOT its exact files): on a
  continuable exhaustion, reset the group to `running` on the same worktree
  with a fresh `spawned` timestamp, increment a continuation counter
  (e.g. `continuationCount`, mirroring `reworkCount`), clear the previous
  attempt's completion artifacts, write a continuation task file (a short
  "continue the task in this worktree; the previous session hit the iteration
  cap; here is what remains" prompt referencing the same issue numbers), and
  re-spawn the worker with `run-worker.sh` on the same worktree. Cap it with
  a new `--max-continuations <n>` option (default 3) and mark the group
  `needs-human` once exhausted — same terminal-outcome shape as the rework
  loop's cap.
- Budget interplay: the per-session budget (`--max-cost-usd` /
  `--max-duration-ms`) already aborts a worker with reason "budget" — that
  must NOT trigger a continuation (a budget stop is a deliberate guardrail,
  not "task too big"); only the iteration-cap reason should auto-continue.

### Part 3 — add the missing pricing entry (cost accounting correctness)

- `src/budget/cost.ts`'s `DEFAULT_PRICING_TABLE`: add
  `deepseek/deepseek-v4-flash` with its real OpenRouter rates (look up the
  current list price; it is far below the $2.0/$8.0 fallback). If
  `deepseek/deepseek-v4-pro` is also a model this repo runs, add it too —
  otherwise leave it to the fallback.

## What NOT to do

- Do NOT remove the iteration cap or change `DEFAULT_MAX_ITERATIONS`'s value
  as the harness default — it stays a bounded-failure guard; this issue only
  makes it overridable at the round level and adds automatic continuation.
- Do NOT add auto-continuation for any failure reason other than the
  iteration-cap reason (budget stops, tool-error storms, and genuine crashes
  stay terminal/`failed`).
- Do NOT touch the reviewer/QA model wiring or the deploy gate.
- Do NOT invent a new state-machine — reuse the existing group statuses
  (`running`/`failed`/`needs-human`) and the rework loop's same-worktree
  re-spawn pattern.

## Tests

- `src/orchestrator/__tests__/cli.test.ts` (extend): `--max-iterations`
  parses and lands in the spawn command/env; `--max-continuations` parses.
- New/extended watcher or decision-helper tests (look at
  `src/orchestrator/__tests__/watch.test.ts` + how `handleReviewVerdict` is
  tested in `src/orchestrator/__tests__/cli.test.ts`): given a "done" group
  whose summary contains `Max iterations (` → continuation decision
  (shouldSpawn true, counter increments); given the same but a budget/other
  failure reason → no continuation (stays failed); at the continuation cap →
  `needs-human`.
- `src/budget/__tests__/cost.test.ts` (extend): `estimateCost` for
  `deepseek/deepseek-v4-flash` uses the real table price, not the fallback.
- Re-run the e2e suites under `scripts/e2e*/run.sh` — with a tiny injected
  `--max-iterations` (e.g. 3) and the mock LLM, prove a worker that would hit
  the cap gets re-spawned on the SAME worktree and the group reaches a
  terminal state.

## What to report back

- Files changed/added.
- Actual tsc/test/e2e results (pass/fail counts, real output).
- How the continuation behaved in any real/e2e run: worktree re-used, counter
  incremented, final group state.
- The real OpenRouter price you used for `deepseek/deepseek-v4-flash` and
  where you verified it.
- Anything you noticed that looks like a related bug or gap, even if unfixed
  — flag it rather than ignoring it.
