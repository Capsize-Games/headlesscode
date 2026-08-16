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
# Add default max_tokens caps to the main and condensation LLM calls

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI running a headless coding-agent loop. Read
`.roo/rules/rules.md` in full before starting. `npx tsc --noEmit` and
`npm test` must stay green.

## The evidence (verified, not assumed)

The main call sends `maxTokens: this.config.maxTokens`, which is `undefined`
unless a caller/flag sets it (`src/engine/loop.ts:2227`), and `buildRequestBody`
only emits `max_tokens` when it is present (`src/llm/openrouter.ts:763-765`).
The condensation call has the same shape: `maxTokens: options.maxTokens`
(`src/engine/condense.ts:350`), defaulting to `config.condenseMaxTokens ??
config.maxTokens` (`src/engine/loop.ts:1666`), both commonly `undefined`. The
summary is hard-capped at `MAX_CONDENSED_MESSAGE_CHARS = 16_000` *after*
generation (`src/engine/condense.ts:118`, `src/engine/condense.ts:362-366`), so
an unbounded generation can be produced and then rejected.

For a reasoning model an unbounded generation is a long-tail cost/latency risk
with no steady-state benefit. A small default cap bounds the worst case. This is
**independently correct** regardless of any reasoning-stripping work elsewhere.

## What to do

1. Add a default `condenseMaxTokens` (candidate: 4096) so the condensation call
   always sends `max_tokens`, independent of the session's own `maxTokens`.
   Wire it where the resolved config defaults are set (`src/engine/loop.ts:977-978`)
   and pass it through the call sites that currently use
   `config.condenseMaxTokens ?? config.maxTokens` (`src/engine/loop.ts:1666`,
   `src/engine/loop.ts:1897`, `src/engine/loop.ts:2139`, `src/engine/loop.ts:2151`).
2. Add a sane default `maxTokens` for the main call, overridable via the existing
   flag/env plumbing. Choose a value well above typical output (validate against
   a real session) so it never truncates a legitimate multi-file write turn.

## What NOT to do

- Do not set the main-call cap so low that legitimate multi-file write turns
  truncate mid-tool-call — reasoning models generate long tool-call turns by
  design (the timeout comment at `src/engine/loop.ts:200-207` documents this).
- Do not change the reasoning-effort plumbing or condensation threshold logic.

## Verification checklist

- `tsc --noEmit` clean, `npm test` green.
- New/extended tests asserting `buildRequestBody` includes `max_tokens` for the
  condensation path even when the session has no `maxTokens`, and that an
  explicit override still wins.

## What to report back

1. The exact `file:line` of each change and the chosen default values.
2. Which suites you ran and their results.
3. `git log --oneline -1` (your commit hash).
