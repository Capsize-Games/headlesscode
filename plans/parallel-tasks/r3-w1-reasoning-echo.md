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
# Stop re-billing reasoning tokens: strip thinking text from assistant history where safe

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI running a headless coding-agent loop, ported from
the open-source Zoo Code VS Code extension (vendored under `src/vendor/zoo-code/`).
Read `.roo/rules/rules.md` in full before starting. `npx tsc --noEmit` and
`npm test` must stay green.

## The evidence (verified, not assumed)

The harness pins the DeepSeek family and requests reasoning text on every
main-loop call: `src/llm/openrouter.ts:788-802` sets `include_reasoning: true`
unconditionally for `deepseek/*` models (with `allow_fallbacks: false`). The
reasoning arrives on the response message (`src/engine/types.ts:42` documents
`reasoning?: string`).

The loop then **echoes the reasoning back onto the assistant history message**:
`src/engine/loop.ts:2454-2464` constructs `assistantMessage` with
`reasoning: assistant.reasoning`, so the full thinking text is re-sent on every
subsequent request.

Pricing makes the double-billing concrete (`src/budget/cost.ts:99-103` and
`src/budget/cost.ts:293-301`): reasoning is billed once as output at `$0.28/1M`,
then re-billed as input on every later turn — `$0.0028/1M` on a cache hit,
`$0.14/1M` on a cache miss. For a reasoning model the reasoning string is
typically **2-10x the length of the visible output**, so this is likely the
single largest source of recurring input tokens in a long session. It also
inflates the working context, forcing condensation earlier.

## What to do (in this order)

1. **Measure first.** Pull real numbers from one or two long sessions: the
   per-iteration `[usage] running total` log line already records
   `outputTokens` and `lastPromptTokens` separately (`src/engine/loop.ts:2386-2395`).
   Confirm that per-iteration output is dominated by reasoning (compare
   `outputTokens` against the actual `assistant.content`/tool-call text) and
   that `lastPromptTokens` grows in step with accumulated reasoning history.
   Record before/after numbers.
2. **Verify the DeepSeek constraint.** The comment at
   `src/engine/loop.ts:2454-2457` claims DeepSeek drops prior reasoning unless
   it is echoed on assistant messages *within tool-call turns*. Establish, with
   a real probe against the pinned endpoint (a small script under
   `.headlesscode/scratch/` that sends a 2-turn tool-call conversation), whether
   reasoning must be echoed on **every** assistant history message, or only on
   the **immediately-preceding** assistant message in the active tool-call
   chain. This decides how aggressively reasoning can be stripped.
3. **Strip reasoning where safe.** Based on the probe, strip `reasoning` from
   assistant history messages that are no longer part of the active tool-call
   chain. The safe minimal case: drop `reasoning` from any assistant message
   older than the most recent turn, and from any message superseded by a
   condensation summary. This is a pure reduction in re-sent input tokens.
4. **Default reasoning effort to `low` for routine work.** The `_reasoning_effort`
   config key already exists and is wired (`src/cli.ts:868-869`,
   `src/llm/openrouter.ts:808-813`), but defaults to unset (endpoint default).
   Evaluate defaulting the `code` mode's effort to `low` (or adding a per-mode
   default) so routine edit/explore turns generate less thinking text. Keep
   `high`/`xhigh` for review/QA/architect roles via the existing per-mode mapping.

## What NOT to do

- Do not remove `include_reasoning: true` wholesale without the probe — if
  DeepSeek genuinely requires reasoning echoed for tool-call turns, naive
  removal breaks sessions with HTTP 400s.
- Do not strip reasoning from the *immediately preceding* assistant message in
  an active tool-call chain until the probe confirms that is safe.
- Do not change the reasoning *pricing* — the numbers in
  `src/budget/cost.ts:99-103` are already verified against the official endpoint.

## Verification checklist

- `npx tsc --noEmit` clean and `npm test` green.
- A real (or mock) session shows `lastPromptTokens` no longer grows with
  accumulated reasoning history, and cache-hit rate (`lastCachedTokens /
  lastPromptTokens`) is unchanged or improved.
- No new HTTP 400 "messages with role tool" or DeepSeek reasoning-drop errors.

## What to report back

1. The before/after measurement numbers (this is the actual deliverable).
2. The exact `file:line` of each change.
3. Which suites you ran and their results (`tsc`, `npm test`, `e2e*`).
4. The probe result that determined how aggressively reasoning could be stripped.
5. The measured effect on cache-hit rate.
6. `git log --oneline -1` (your commit hash).
