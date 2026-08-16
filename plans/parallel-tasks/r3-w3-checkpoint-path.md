# Round-level instructions (from the orchestrator) — read FIRST

You are working autonomously in an isolated git worktree on your own branch.
The full task spec for your assignment follows below this preamble; it is
binding. In addition, these round-level instructions apply:

## Mandatory: commit your own work before you finish (non-negotiable)

Before you call `attempt_completion`:

1. `git add` all your changes (including new files) and
   `git commit -m "<concise message>"` on your branch.
2. Verify a REAL commit landed by running `git log --oneline -1` — you must
   see your commit's hash on your branch. `git status` alone is NOT proof of
   a commit; the orchestrator will independently check `git log` on your
   branch and will treat the task as incomplete without it.

Do NOT merge to master, do NOT push, do NOT open a PR — the orchestrator
handles review and merging after you finish.

## Model and iteration budget

- Model: harness default for `code` mode (deepseek/deepseek-v4-flash line,
  resolved via mode-models.json / DEFAULT_MODEL), plain code mode.
- HEADLESSCODE_MAX_ITERATIONS=150 — you have up to 150 loop iterations.
- If you reach the iteration cap having made steady progress with zero real
  errors: RESUME (continue from where you are), do not restart from scratch.
  Wrap up cleanly, commit, and report exactly what remains.
- On any REAL error (persistent tool failure, auth failure, verification
  failure you cannot resolve): stop, commit whatever is in a working state,
  and report the error explicitly rather than papering over it.

## Verification bar (repo-wide requirement)

- `npx tsc --noEmit` must be clean.
- `npm test` must pass in full (plain tsx-run test files, no framework; new
  test files must be added to the `test` script in package.json).
- If you touch `src/orchestrator/`, `src/watcher/`, or `scripts/*.sh`, also
  re-run the relevant suites under `scripts/e2e*/run.sh`.

## Never write to /tmp

Scratch/temporary files go under `<workspace>/.headlesscode/scratch/`, never
`/tmp` (outside-workspace writes are rejected in this environment).

## Reporting

Follow the "What to report back" section of your task spec below. Include the
output of `git log --oneline -1` (your commit hash) in your final report so
the orchestrator can confirm it landed.

========================================================================
# TASK SPEC
========================================================================
# Stop committing checkpoints on the LLM critical path (and skip read-only turns)

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI running a headless coding-agent loop. Read
`.roo/rules/rules.md` in full before starting. `npx tsc --noEmit` and
`npm test` must stay green; this change touches the loop, so also re-run
`scripts/e2e-phase2/run.sh`.

## The evidence (verified, not assumed)

After every tool-call turn the loop **awaits** a checkpoint save:
`src/engine/loop.ts:2771-2774` calls `await this.saveIterationCheckpoint(iteration)`.
`saveIterationCheckpoint` (`src/engine/loop.ts:2850-2866`) calls
`checkpointService.save(...)`, which performs a real shadow-git `git add -A` +
commit (`src/checkpoints/service.ts:180-182` → vendored `saveCheckpoint`, with
`stageAll` patched to `git add -A --ignore-errors` at
`src/checkpoints/service.ts:140-150`).

Two separate costs:

1. **Wall-clock on the critical path.** The `await` means the next iteration's
   LLM call waits for the git commit to finish. A long session (up to
   `DEFAULT_MAX_ITERATIONS = 250`, `src/engine/loop.ts:140`) can do up to 250
   synchronous git commits, each touching the shadow repo.
2. **Snapshots after read-only turns.** The comment at
   `src/engine/loop.ts:2771-2774` snapshots whenever `calls.length > 0` — which
   includes turns that only called `read_file`/`list_files`/`search_files`
   (nothing changed on disk). Those commits are empty (`allowEmpty: true`) and
   pure waste. Exploration dominates the tool-call mix (the harness's own
   comment at `src/engine/loop.ts:272-287` documents `execute_command` as the
   dominant exploration tool).

## What to do

1. **Skip checkpointing on read-only turns.** Only snapshot when at least one
   edit tool ran (`write_to_file`/`apply_diff`/`search_replace`/`edit_file`, and
   ideally `execute_command` that is NOT read-only-equivalent — reuse
   `isReadOnlyEquivalentShellCommand` at `src/engine/loop.ts:288-336`).
2. **Decouple the commit from the LLM critical path.** Checkpoints are already
   non-fatal by contract (`src/engine/loop.ts:2843-2866` wraps save in
   try/catch). Change the save to fire-and-forget (kick off the promise without
   awaiting it, tracking a single in-flight save so writes stay ordered), OR
   throttle to every N edit turns. Keep the baseline snapshot at session start
   synchronous (`src/engine/loop.ts:1227-1230`) since nothing else runs then.
3. Preserve the restore/diff/list API unchanged — only the *save cadence*
   changes, not the checkpoint format or shadow-repo layout.

## What NOT to do

- Do not disable checkpoints entirely or change the shadow-repo storage
  location — the restore safety property (`src/checkpoints/service.ts:26-34`) is
  load-bearing.
- Do not drop the baseline checkpoint (`src/engine/loop.ts:1227-1230`) — test
  selection (`getSessionChangedFiles`) depends on it
  (`src/engine/loop.ts:1064-1076`).

## Verification checklist

- `tsc --noEmit` clean, `npm test` green.
- Re-run `scripts/e2e-phase2/run.sh` (spawn/watch flows) since the loop's
  checkpoint behavior is exercised there.
- A session whose turns are all reads produces **no** iteration checkpoints
  beyond the baseline; a session with edits still produces restorable
  checkpoints after each edit turn.

## What to report back

1. The exact `file:line` of each change.
2. Which suites you ran and their results (`tsc`, `npm test`, `e2e-phase2`).
3. The measured wall-clock effect (e.g. per-iteration git commit time before/after).
4. `git log --oneline -1` (your commit hash).
