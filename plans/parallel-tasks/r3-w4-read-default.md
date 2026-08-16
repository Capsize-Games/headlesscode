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
# Lower the read_file default line limit and nudge targeted reads

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI running a headless coding-agent loop. Read
`.roo/rules/rules.md` in full before starting. `npx tsc --noEmit` and
`npm test` must stay green.

## The evidence (verified, not assumed)

The vendored `read_file` default is `DEFAULT_LINE_LIMIT = 2000`
(`src/vendor/zoo-code/src/core/prompts/tools/native-tools/read_file.ts:6`), and
the harness's `readFileHandler` defaults `limit` to 2000
(`src/tools/executor.ts:579`). Tool results are then capped at
`MAX_RESULT_CHARS = 30_000` (`src/tools/executor.ts:119`), so a single default
`read_file` can append ~30,000 characters (~7-8k tokens) to history. The
read-cache (`src/tools/executor.ts:472-615`) only helps on *re-reads*, not on
the first read of each distinct file. The harness already logs "default broad
read" as a distinct signal (`src/engine/loop.ts:3381-3383`), which implies this
pattern is common enough to be worth surfacing.

## What to do (in this order)

1. **Measure first.** From real session logs, count how often `read_file` is
   called with no `offset`/`limit` (the `summarizeToolArg` log at
   `src/engine/loop.ts:3361-3400` already distinguishes "default broad read"
   from targeted reads) and how many tokens those results contribute to
   `lastPromptTokens`.
2. **Lower the harness default.** Add a configurable default line limit
   (env/flag, e.g. `HEADLESSCODE_READ_LIMIT`) that overrides the vendored 2000
   with a smaller value (candidate: 500-800) in `readFileHandler`
   (`src/tools/executor.ts:579`). Keep 2000 as an explicit opt-in when the model
   passes a larger `limit`.
3. **Strengthen the indentation-mode nudge.** The vendored tool description
   already says "PREFER indentation mode"
   (`src/vendor/zoo-code/src/core/prompts/tools/native-tools/read_file.ts:67-71`),
   but the harness's rules files are where model behavior actually changes (per
   `.roo/rules/rules.md`'s "a new tool is not done until something tells a model
   to reach for it"). Add a short scannable line to the relevant
   `.roo/rules-code/rules.md` pointing models at indentation mode for targeted
   reads, mirroring the existing `codebase_search` guidance style.

## What NOT to do

- Do not truncate `read_file` results below what a model needs to edit a file —
  a summarized file body would be a correctness hazard (the harness documents
  this for write/diff content at `src/tools/executor.ts:412-415`).
- Do not change `MAX_RESULT_CHARS` in a way that lets a single result exceed the
  context budget it exists to bound.

## Verification checklist

- `tsc --noEmit` clean, `npm test` green.
- `src/tools/__tests__/read-cache.test.ts` (and any read_file tests) extended to
  assert the new default limit is honored and an explicit `limit` still works.

## What to report back

1. The before/after measurement (share of reads that were default broad reads).
2. The exact `file:line` of each change and the chosen default limit value.
3. Which suites you ran and their results.
4. `git log --oneline -1` (your commit hash).
