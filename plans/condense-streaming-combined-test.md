# Test gap: context-condensation + streaming used together in one session — instructions for implementation

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI running a headless coding-agent loop. This is
a test-only task — no new feature, no behavior change — closing a gap an
independent review (`plans/review-todays-batch.md`) found after
`context-condensation` and `streaming-and-reasoning` were merged
sequentially, both making real changes to `src/engine/loop.ts`'s core
request-handling path.

Match this project's established style: no test framework (plain `tsx`-run
test files, hand-rolled `assert`, `All N tests passed` trailer); `npx tsc
--noEmit` and `npm test` must stay green; re-run every e2e suite under
`scripts/e2e*/run.sh`.

## The gap

Both features are individually well-tested (`All 17 condense tests
passed`, `All 13 openrouter request-building tests passed`, `All 9 events
tests passed`, confirmed by the independent review) — but **no test
exercises them together in one session**: a history long enough to trigger
condensation (`maybeCondenseHistory` in `src/engine/loop.ts`, using the
shared tool-call-group-safe helpers in `src/engine/condense.ts` —
`computeCondenseCount`/`computeEvictCount`/`skipOrphanedToolMessages`) AND a
streamed response (`stream: true`, incremental `llm_stream_chunk` events)
happening in the same run. This is exactly the combination the round's own
sequencing created risk around: two features independently modifying the
same core loop state (message history, event emission) is precisely the
class of bug that passes both features' own isolated test suites while
still hiding an interaction bug — the reviewer specifically named this as
the one real coverage gap out of an otherwise clean 8/9-pass round.

## What to build

New test(s) in `src/engine/__tests__/` (check whether this fits better as
an extension of the existing condense or loop test file, or a new
`condense-streaming.test.ts` — your call, but don't duplicate fixture-
building helpers that already exist in `loop.test.ts` for tool-call-group
construction, e.g. the pattern
`testTruncateHistoryNeverSplitsToolCallGroup` already uses to build a
history with varying tool-call-group sizes — reuse or adapt it rather than
reinventing).

Construct a scenario where, in one `HeadlessSession` run:
1. History grows past the condensation threshold (mock/fake the token-usage
   signal `maybeCondenseHistory` uses to decide when to trigger, matching
   how existing condense tests already drive it — check `condense.ts`'s
   test suite for the exact mechanism rather than guessing).
2. History includes irregular tool-call-group sizes (1-3 calls per turn,
   matching the real incident this project chased down earlier — see
   `truncateHistory`'s own doc comment in `loop.ts` for the original 2026-
   08-01 HTTP-400 incident this pattern guards against) spanning BOTH the
   portion that gets condensed and the portion that stays in the live tail.
3. At least one of the LLM responses in this run is a STREAMED response
   (`stream: true` on the fake/mock client, emitting `llm_stream_chunk`
   events incrementally) — ideally one that happens on the SAME turn as, or
   immediately after, a condensation pass, since that's the moment the two
   features' state changes are most likely to interact badly.

Assert, all in the SAME test run:
- Condensation still never splits a tool-call group (reuse the existing
  group-boundary assertion pattern from `loop.test.ts`'s truncation tests).
- The condensed summary message is well-formed and the resulting history
  sent to the model is shorter in token-estimate terms, exactly as
  `context-condensation`'s own tests already prove in isolation — just
  proving it STILL holds with streaming active too.
- Streamed events (`llm_stream_chunk` sequence, final assembled message) are
  correct and match what a non-streamed equivalent response would have
  produced — same assertion `streaming-and-reasoning`'s own tests already
  make in isolation, proving it holds with condensation active too.
- The event feed's ordering is sane across both — no interleaving bug where
  a condensation-triggered LLM call's stream chunks get mixed up with the
  main session's stream chunks, or where `checkpoint_saved`/`iteration_start`
  events land in a confusing order relative to condensation's own (if any)
  events.
- Budget/cost accounting still correctly reflects BOTH the condensation
  call's usage AND the main streamed call's usage combined (mirroring
  `context-condensation`'s existing test proving condensation's own LLM
  call is tracked — just confirming it's not double-counted or dropped once
  streaming is also active).

## What NOT to do

- Do not modify `src/engine/condense.ts` or the streaming implementation in
  `src/llm/openrouter.ts`/`src/engine/loop.ts` unless this task's testing
  actually uncovers a real bug — if you find one, fix it and clearly flag
  in your report that this task went beyond "test-only" and why, with the
  specific bug described precisely. If everything passes cleanly, this
  should be a pure test-addition task with zero production code changes.
- Do not weaken or duplicate the existing isolated test suites for either
  feature — this is additive coverage for the untested combination, not a
  replacement for what already exists.

## Verification checklist

1. `npx tsc --noEmit` clean.
2. `npm test` — all suites green including the new combined test(s).
3. Every e2e suite under `scripts/e2e*/run.sh` still passes.

## What to report back

- Whether the combined scenario passed cleanly (closing the gap as pure
  test coverage) or actually uncovered a real interaction bug — if the
  latter, full details: what specifically breaks, exact repro, and what
  you changed to fix it (this would be the one case where production code
  changes are in scope for this task).
- Confirmation of tsc/test/e2e results.
- Any deviation from this spec, and why.
