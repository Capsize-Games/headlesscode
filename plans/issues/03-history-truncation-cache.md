Title: Engine: 40-message history truncation destroys DeepSeek prompt-cache hits (50% instead of ~98%); make window size overridable and add stable-prefix truncation

## Context

`headlesscode` is a standalone Node/TypeScript CLI that runs a headless
coding-agent loop (ported from Zoo Code) against OpenRouter. The loop in
`src/engine/loop.ts` accumulates a conversation and sends the full history to
the LLM each iteration; DeepSeek (and OpenRouter generally) apply automatic
**prefix caching** — a request whose leading tokens match a prior request's
leading tokens pays the cached rate for that prefix, which is the difference
between ~98% cache hits on a long append-only conversation and ~50%.

A real orchestrated worker round (model `deepseek/deepseek-v4-flash`, ~1.05M
input tokens across 19 requests) showed a **50.1% cache hit rate**. Expected
for an append-only conversation: ~98%. Root cause, verified in code:

- `src/engine/loop.ts`'s `DEFAULT_WINDOW_SIZE = 40` and `truncateHistory()`
  keep the system message + first user message + the LAST `windowSize - 2`
  messages, dropping the oldest non-system, non-first-user messages once the
  history exceeds 40 messages (about 19 iterations at 2 messages per
  iteration).
- Once truncation starts, the request prefix is no longer stable across calls:
  each request drops a different head and re-sends a shifted tail, so the
  prefix cache misses on the bulk of the history. The loop's own header
  documents this as a Phase 1 placeholder ("Proper token-based condensation
  is Phase 3"), but the cost consequence is real today.
- There is NO CLI flag or env var to raise the window: `src/cli.ts`'s
  argument parser exposes `--max-iterations`, `--max-cost-usd`,
  `--max-duration-ms`, etc., but nothing for the message window — so no
  worker (orchestrated or direct) can currently opt out of the 40-message
  cap, and `scripts/run-worker.sh` forwards nothing for it either.

Match this project's established style:

- No test framework — plain `tsx`-run test files, hand-rolled assertions, an
  `All N tests passed` trailer line (see `src/engine/__tests__/loop.test.ts`
  for the pattern; it already tests `truncateHistory`). Add new test files to
  `package.json`'s `test` script the same way existing entries are chained
  with `&&`.
- No new runtime dependencies. Plain `node:fs`, no frameworks.
- `npx tsc --noEmit` and `npm test` must stay green. This touches
  `src/engine/loop.ts` and `src/cli.ts`, so also re-run the e2e suites under
  `scripts/e2e*/run.sh` (they exercise the real loop against the local mock
  LLM).

## What to build

### Part 1 — make the window size overridable end to end

- `src/cli.ts`: add `--window-size <n>` (and honor `HEADLESSCODE_WINDOW_SIZE`
  env fallback, matching how `--max-iterations`/budget flags behave),
  threaded into the loop's `windowSize` config.
- `scripts/run-worker.sh`: forward `HEADLESSCODE_WINDOW_SIZE` as
  `--window-size <n>` using the same `BUDGET_ARG` pattern used for
  `HEADLESSCODE_MAX_COST_USD` / `HEADLESSCODE_MAX_DURATION_MS`, so an
  orchestrated worker can be launched with a larger window.
- Keep `DEFAULT_WINDOW_SIZE = 40` as the fallback (changing the default is a
  separate decision), but make the override real.

### Part 2 — stable-prefix truncation (don't break the cache when trimming)

The current `truncateHistory` keeps `[system, firstUser, ...tail]` — dropping
the head is exactly what breaks prefix caching. When trimming becomes
necessary (history exceeds the window), preserve a **stable prefix** so the
cache keeps hitting:

- Keep `[system, firstUser]` (as today) but trim by removing the OLDEST
  tool/assistant pairs from the MIDDLE rather than sliding the whole tail —
  i.e. once the window is exceeded, keep the earliest messages intact and drop
  the oldest interior turns, not the head. (This mirrors how Zoo Code's
  vendored history compaction keeps the beginning stable.)
- The existing `truncateHistory` signature/tests must keep passing or be
  updated deliberately — it is exported and unit-tested in
  `src/engine/__tests__/loop.test.ts`; changing its behavior is the point,
  so update its tests to assert the new stable-prefix property (e.g. with a
  window of 6, the request starts with `[system, firstUser]` and the dropped
  messages are the oldest interior ones, not a shifted head).
- If a full token-count-based condensation (summarize + merge, the "Phase 3"
  the header mentions) is clearly the better fix and small to do, prefer it —
  but a stable-prefix trim is the minimal correct fix; don't gold-plate.

### Part 3 — verify the cache-hit improvement is real

- Add an assertion-visible signal if cheap: after the change, a long scripted
  session (fake `LlmClient`) should send requests whose `messages[0..k]`
  prefix is byte-identical between consecutive iterations once the window is
  reached (assert the shared prefix in the test), proving the cache can hit.
- Manually confirm with the real provider if possible: run a real session with
  `--window-size 200` (or the new default behavior) against
  `deepseek/deepseek-v4-flash` and check OpenRouter's reported cache hit rate
  (visible on the key's usage page or `/api/v1/auth/key` style usage
  endpoints). Report the before/after hit rates — the observed before value
  was ~50%.

## What NOT to do

- Do NOT change `DEFAULT_WINDOW_SIZE`'s value in this issue — only make it
  overridable and fix the truncation strategy. (If you believe the default
  should also change, say so in the report as a recommendation, don't just do
  it.)
- Do NOT add a summarization/condensation subsystem unless the minimal
  stable-prefix trim is genuinely insufficient — keep the change scoped.
- Do NOT touch the OpenRouter client, the event feed, the dashboard, or the
  orchestrator's split/review logic.

## Tests

- Extend `src/engine/__tests__/loop.test.ts` for the new `truncateHistory`
  behavior (stable prefix, interior drop) and any new config plumbing.
- `src/cli.ts` flag parsing: `--window-size` / `HEADLESSCODE_WINDOW_SIZE`
  reach the loop config (mirror how `--max-iterations` is tested, if it is;
  otherwise add the smallest sensible assertion).
- `npm test` in full + `npx tsc --noEmit` + the e2e suites under
  `scripts/e2e*/run.sh`.

## What to report back

- Files changed/added.
- Actual tsc/test/e2e results (pass/fail counts, real output).
- The stable-prefix property demonstrated in a test (or why it couldn't be).
- Real cache-hit rate before vs after if you could measure it against the
  provider — the observed before value was ~50.1% on a 19-request / 1.05M
  token session.
- Any deviation from this spec, and why.
- Anything you noticed that looks like a related bug or gap, even if unfixed
  — flag it rather than ignoring it.
