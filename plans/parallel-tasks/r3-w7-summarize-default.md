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
# Evaluate flipping local output summarization to default-ON for execute_command

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI running a headless coding-agent loop. Read
`.roo/rules/rules.md` in full before starting. `npx tsc --noEmit` and
`npm test` must stay green.

## The evidence (verified, not assumed)

`summarizeCommandOutput` falls back to blunt 30k-char truncation unless local
summarization is enabled (`src/tools/executor.ts:417-430`), and the feature is
gated OFF by default (`src/tools/output-summarizer.ts:101-103`). Yet the
harness's own live-round comment documents that `execute_command` is the
dominant exploration tool, and large noisy command output (verbose test runs,
big greps, install logs) is the canonical case the summarizer exists for
(`src/tools/output-summarizer.ts:5-14`). Blunt truncation discards everything
past 30k chars — including, sometimes, the one relevant line.

## What to do (in this order)

1. **Measure the token cost** of the current default: from real session logs,
   sum the `execute_command` result sizes that hit the 30k cap and estimate how
   many input tokens those re-sent outputs add across a session.
2. **Run an A/B with `HEADLESSCODE_LOCAL_SUMMARIZATION=1`** on a comparable
   session, and compare `lastPromptTokens` growth + wall-clock (the local
   summarizer adds a 1-2s warm call per oversized result per
   `src/tools/output-summarizer.ts:42-45`).
3. **If the token savings are material and the latency acceptable**, flip the
   default to ON for `execute_command` output only (the summarizer is already
   correctly scoped to command output, never file/diff content —
   `src/tools/executor.ts:412-415`). Keep the env var as an opt-out.

## What NOT to do

- Do not extend summarization to `read_file`/diff/write content — a summarized
  file body or diff would be a correctness hazard (already documented at
  `src/tools/executor.ts:412-415`).

## Verification checklist

- `tsc --noEmit` clean, `npm test` green.
- `src/tools/__tests__/local-summarization-gate.test.ts` and
  `src/tools/__tests__/output-summarizer.test.ts` extended for the new default.

## What to report back

1. The measured token cost of the current default and the A/B comparison.
2. The exact `file:line` of the default flip (if you made it).
3. Which suites you ran and their results.
4. `git log --oneline -1` (your commit hash).
