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
# Skip prompt/tool rebuild on switch_mode when the tool set is unchanged

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI running a headless coding-agent loop. Read
`.roo/rules/rules.md` in full before starting. `npx tsc --noEmit` and
`npm test` must stay green.

## The evidence (verified, not assumed)

`handleSwitchMode` recomputes `buildSystemPrompt(...)` and reassembles the full
tool list on every approved switch (`src/engine/loop.ts:3153-3171`), then
replaces `messages[0].content` with the new prompt
(`src/engine/loop.ts:3179-3181`). `buildSystemPrompt` builds the full vendored
`SYSTEM_PROMPT` plus headless conventions plus stack rules
(`src/engine/prompt.ts:273-327`), and the tool list includes the code-intel,
browser, describe-image, and run-tests schemas (`src/engine/loop.ts:1165-1174`).

Two costs:

1. **Cache invalidation.** Replacing `messages[0]` changes the entire cached
   prefix, so the request after every switch is a full-prompt cache miss (full
   input price for the whole fixed prefix, not the `0.0028/1M` cache rate).
2. **Wasted work** when the target mode's effective tool set is identical to the
   current one (e.g. two custom modes that differ only in role text but share
   the same `groups`).

## What to do

1. Compute the target mode's tool list first and compare it to the current
   `this.state.tools` (compare the sorted set of tool names — cheap and
   sufficient). When identical, skip `buildSystemPrompt` and the `messages[0]`
   replacement entirely, and emit a shorter "mode label changed, tool set
   unchanged" result that does not invalidate the cached prefix.
2. When the tool set *does* change, keep the current behavior.

## What NOT to do

- Do not skip the approval gate or the mode-switch cap — this task only changes
  the *prompt rebuild*, not the security boundary
  (`src/engine/loop.ts:3090-3144`).
- Do not remove the visible "[mode switched: …]" transcript marker logic
  (`src/engine/loop.ts:3170-3182`).

## Verification checklist

- `tsc --noEmit` clean, `npm test` green.
- New/extended test in `src/engine/__tests__/switch-mode.test.ts` asserting the
  prompt is NOT rebuilt (and `messages[0]` not replaced) when the target mode's
  tool set equals the current one, and IS rebuilt when it differs.

## What to report back

1. The exact `file:line` of each change.
2. Which suites you ran and their results.
3. `git log --oneline -1` (your commit hash).
