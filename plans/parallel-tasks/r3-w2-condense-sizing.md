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
# Count `reasoning` in condensation sizing so it fires at the right time

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI running a headless coding-agent loop, ported from
the open-source Zoo Code VS Code extension. Read `.roo/rules/rules.md` in full
before starting. `npx tsc --noEmit` and `npm test` must stay green.

## The evidence (verified, not assumed)

`estimateMessageChars` counts only `content` and `tool_calls` — it never looks
at `reasoning` (`src/engine/condense.ts:312-320`). `buildCondenseUserPrompt`
also transcribes `content`/`tool_calls` but not `reasoning`
(`src/engine/condense.ts:170-198`). This matters because:

- `computeCondenseCount` uses `estimateMessageChars` to decide how many messages
  to fold (`src/engine/condense.ts:219-258`), so for reasoning models it
  **under-counts** the real size of the oldest chunk and condenses too little.
- `truncateHistory`'s fallback is message-COUNT based with
  `DEFAULT_WINDOW_SIZE = 300` (`src/engine/loop.ts:199`), so a session whose
  every turn carries a large `reasoning` string can carry far more real tokens
  than the window size intends before anything fires.

This is **independently correct** regardless of any other work that strips
reasoning from history: if reasoning is present in the history, the sizing must
account for it.

## What to do

1. Include `reasoning` length in `estimateMessageChars`
   (`src/engine/condense.ts:312-320`) so condensation/eviction sizing reflects
   true history size. Keep the estimate cheap and monotonic (add
   `m.reasoning?.length ?? 0`), consistent with the existing character-length
   heuristic.
2. Confirm `computeCondensePlan`'s `conservativeCharsPerToken = 8` default
   (`src/engine/condense.ts:270-280`) is still a reasonable over-estimate once
   reasoning is counted; adjust the constant with a comment if it should change.
3. Make `buildCondenseUserPrompt` **omit** `reasoning` from the transcript it
   feeds the condensation model (`src/engine/condense.ts:170-198`) — reasoning
   is disposable and including it only inflates the condensation call's own
   input cost. This is the correct direction even though step 1 adds reasoning
   to the *sizing* path: the sizing must know about it, the summarizer does not
   need to read it.

## What NOT to do

- Do not make `estimateMessageChars` do a real tokenization — keep it a cheap
  character-length estimate, consistent with the existing approach.
- Do not change the condensation threshold fractions or the stable-prefix
  semantics (`src/engine/condense.ts:75-94`, `src/engine/condense.ts:130-139`) —
  this item is only about accurately *sizing* what already exists.

## Verification checklist

- New/extended unit test in `src/engine/__tests__/condense.test.ts` asserting
  that a history containing `reasoning` strings yields a larger
  `computeCondenseCount`/`estimateMessageChars` than the same history without
  them, and that `buildCondenseUserPrompt` excludes reasoning from the
  transcript.
- `npm test` green; `tsc --noEmit` clean.

## What to report back

1. The exact `file:line` of each change.
2. Which suites you ran and their results.
3. Any change to `conservativeCharsPerToken` and the reasoning for it.
4. `git log --oneline -1` (your commit hash).
