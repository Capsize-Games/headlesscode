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
# Measure the fixed system-prompt + tool-catalog token cost and recommend whether to trim

## Who you are working on this for

You (deepseek) are working against the `headlesscode` repository — a standalone
Node/TypeScript CLI running a headless coding-agent loop, ported from the
open-source Zoo Code VS Code extension (vendored under `src/vendor/zoo-code/`).
Read `.roo/rules/rules.md` in full before starting.

## The evidence (verified, not assumed)

Every main-loop LLM call sends the full system prompt **and** the full tool
catalog: `src/engine/loop.ts:2222-2230` passes `messages` (which begins with the
system prompt) plus `tools: this.state.tools`. The system prompt is the vendored
Zoo Code `SYSTEM_PROMPT` (built at `src/engine/prompt.ts:291-305`), which is a
GUI-oriented prompt including mode/role/tool-group descriptions, then the
headless conventions (`src/engine/prompt.ts:323-324`,
`src/engine/prompt.ts:335-344`) and stack rules
(`src/engine/prompt.ts:310-313`). The tool catalog is ~18-20 schemas: the
vendored native tools plus code-intel (`src/engine/prompt.ts:438-447`), browser
action (`src/engine/prompt.ts:405-410`), describe-image
(`src/engine/prompt.ts:422-427`), and run-tests (`src/engine/prompt.ts:472-477`).

This fixed prefix is cached after the first call, so the steady-state cost is the
cache-read rate — but the **first call of every session** (and every post-switch
call) pays full input price for all of it, and the prefix is re-sent
byte-for-byte every turn.

## What to do

1. **Measure the fixed prefix size.** Write a small script under
   `.headlesscode/scratch/` that builds the `code`-mode system prompt
   (`buildSystemPrompt` from `src/engine/prompt.ts`) and the tool list
   (`selectToolsForMode` plus the `append*` helpers), and prints their character
   counts (and an approximate token count at ~4 chars/token). The dry-run path
   in `src/cli.ts:761-773` already resolves model/effort without an LLM call —
   reuse that shape, not a live LLM call.
2. **Produce a recommendation** based on the measured number: if the fixed
   prefix is a material share of `lastPromptTokens` on early iterations (e.g.
   >20k tokens), recommend a trimmed "headless minimal" system prompt and/or a
   tool-catalog trim (note that TS-gated code-intel tools are already omitted on
   non-TS workspaces at `src/tools/executor.ts:1777-1799`).
3. **Do NOT perform the prompt surgery yourself.** This task is measurement +
   recommendation only — the tradeoff (losing vendored prompt fidelity vs.
   first-call cost) is a judgment call the orchestrator/human makes from your
   numbers.

## What NOT to do

- Do not edit the vendored `SYSTEM_PROMPT` in place (vendoring convention,
  `.roo/rules/rules.md`). Any trimming must happen in `src/engine/prompt.ts` by
  wrapping/substituting, not mutating vendored files.
- Do not make code changes beyond what's needed to measure (a scratch script).

## Verification checklist

- The measurement script runs and prints the prompt + tool-catalog character
  counts. No production code change means `tsc`/`npm test` should be unaffected,
  but run `npx tsc --noEmit` once to confirm the scratch script didn't break
  anything if it imports from `src/`.

## What to report back

1. The measured character/token counts of the system prompt and tool catalog,
   broken down by section/tool if practical.
2. Your written recommendation (trim or don't, and what specifically to trim).
3. `git log --oneline -1` (commit the scratch measurement script, if any).
