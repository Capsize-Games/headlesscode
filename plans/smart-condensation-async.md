# Smart condensation: real-size instrumentation + async/background condensing

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository —
a standalone Node/TypeScript CLI running a headless coding-agent loop. Match
the project's established conventions: no test framework beyond hand-rolled
`assert` + `tsx`-run test files, minimal new dependencies, `npx tsc --noEmit`
and `npm test` must stay green, re-run `scripts/e2e*/run.sh` afterward.
**Commit your work incrementally per logical change before calling
`attempt_completion`** (see `plans/harness-tooling-efficiency-round2.md`
item 4 — this is now enforced by a structural check in the loop, not just a
prompt request, but commit properly anyway rather than relying on the
backstop to catch you).

**Do not start this until the current in-flight round
(`plans/harness-tooling-efficiency-round2.md`) finishes and is merged.**

This doc has two parts, done in order — part 2 depends on part 1's real
data, so don't skip straight to guessing an async-fire threshold.

## Background: why this doc exists

After fixing the context-window resolution bug (`src/engine/loop.ts`'s
`resolvedContextWindowTokens`, see `plans/speed-and-context-efficiency.md`),
a real 177-iteration session against this repo never condensed once (zero
`crossing token threshold` events) — the original bug's problem is fixed.
But watching that same session's cost curve revealed a NEW, real tradeoff:
prompt-cache hit rate degraded steadily as the uncondensed conversation grew
(99.3% around iteration 130, down to 94.3% by iteration 177), and cost
accelerated correspondingly ($0.10 → $0.34 over that same stretch) because
the growing *uncached tail* costs roughly 10x more per token than the
cached prefix. Condensation is still the right tool for long sessions — it
was just firing on a broken 128k threshold before. The fix isn't "never
condense," it's "condense at the right point, cheaply."

Separately: the ORIGINAL root-cause analysis that started this whole effort
measured real condensation calls at **55-80 seconds each**, fully blocking
the main loop while they run. That's real, already-measured latency
sitting on the table to hide.

## Part 1: instrument the real per-iteration conversation size

### The problem with the data we have

The existing `[usage] running total` log line (`src/engine/loop.ts`) is a
**cumulative sum across every API call in the session** — it does NOT
represent the actual current conversation size. It's dominated by
repeatedly-billed cache reads of the same growing prefix, once per turn. Do
not use it to pick a condensation threshold — it's the wrong unit. The
right number is what the condensation trigger already computes internally
(`maybeCondenseHistory`'s `lastPromptTokens`, from the LAST single
request's real prompt-token count) — but this is currently only logged
when a condensation event actually fires (`[condense] crossing token
threshold`). A session that never crosses the (correct, now-fixed)
threshold never logs it, so there's no visibility into how the real
conversation size grows over a session's lifetime, or where cache
degradation actually starts relative to that real size.

### What to build

Add a log line on EVERY iteration (not just condensation events) reporting
the real last-request prompt-token count alongside the existing cumulative
usage line — e.g. extend the existing `[usage] running total` line with a
`lastPromptTokens` field (the same value `maybeCondenseHistory` already has
in hand each call), or add a sibling `[condense] conversation size` debug
line. Keep it cheap: this is a field already computed, not a new
computation — don't add per-iteration overhead beyond logging a number
that's already sitting in memory.

### How to use it

Re-run a comparable real session (the next round dispatched from this repo
is a fine natural source — don't manufacture a synthetic one just for this)
and correlate, per iteration: real conversation size (the new field) vs.
prompt-cache hit rate (`cachedTokens / inputTokens` from the existing
per-call usage, NOT the cumulative line) vs. cost delta. Find the real
conversation-size point where cache degradation starts becoming
significant (the 2026-08-04 session's degradation started around 97-98%
and kept sliding — pick your own threshold for "significant" once you have
real per-iteration numbers, don't import that specific percentage as a
magic constant without re-deriving it from fresh data). THAT real-size
number, not any cumulative figure, is the one to feed into part 2's
early-fire threshold and (if warranted) a revised default
`condenseThresholdFraction`.

## Part 2: async/background condensation

### Design

Fire the condensation LLM call BEFORE the hard threshold is reached, in the
background, while the main loop keeps making forward progress on new
iterations. When it resolves, splice the summary in. When it doesn't
resolve in time, fall back to today's synchronous behavior — this is
latency-hiding, not a replacement for the existing safety net.

1. **Snapshot, don't share state.** When the early-fire threshold is
   crossed (a lower fraction than the hard threshold — e.g. if part 1
   finds the hard threshold should be fraction F of the real window, fire
   the background job at some fraction below F, tunable, not hardcoded),
   take an immutable snapshot of the messages array up to the current
   point and kick off the condensation call against ONLY that snapshot,
   without awaiting it inline in the main loop. The main loop continues
   appending new messages normally — it must not block on this call.
2. **Re-resolve the splice point on completion, against LIVE state, not
   the stale snapshot.** By the time the background call resolves, the
   real message history has grown further. Do not naively splice at the
   snapshot's original boundary — find where that same prefix range
   currently sits in the (now-longer) live history (it's still a stable
   prefix, since nothing before the snapshot point should have changed —
   verify this assumption holds; if something upstream of the snapshot
   ever gets mutated, e.g. a message-role rewrite, that assumption breaks
   and needs handling explicitly, not silently). Apply the EXACT same
   tool-call-group boundary safety the synchronous path already uses
   (`computeCondenseCount`/`skipOrphanedToolMessages` in
   `src/engine/condense.ts`) against the CURRENT state — reuse those
   functions directly, don't reimplement equivalent logic.
3. **Hard synchronous fallback stays in place, unchanged.** If the
   background job hasn't resolved by the time the EXISTING hard threshold
   is hit, fall back to exactly today's synchronous `maybeCondenseHistory`
   behavior — block and condense inline as it does now. A slow or failed
   background condensation must never be able to let the session exceed
   the real context window. This is the load-bearing safety property of
   the whole design — get this right before anything else.
4. **Session-end / early-completion handling.** If `attempt_completion`
   fires (or the session otherwise ends) before the background job
   resolves, discard the in-flight result rather than trying to apply a
   condensation to a session that's already done. Log it as a
   wasted-but-harmless call for cost visibility (the usage still needs to
   land in the same `BudgetTracker` per the existing "condensation spend
   is never invisible" rule — see `docs/context-condensation.md`) — don't
   silently drop its cost from accounting just because it didn't get
   applied.
5. **Cost, not just latency.** Firing early doesn't cost extra beyond
   what a normal condensation costs — the main loop's own requests are
   unaffected by the background call running in parallel. The only new
   cost is the (bounded, rare) wasted case in point 4. Don't over-engineer
   cancellation of in-flight background calls for that case — letting a
   rare wasted call complete and get logged is simpler and cheap enough.

### What NOT to build

- Don't build a general-purpose background-task framework. This is one
  specific async operation (the condensation LLM call) with one specific
  completion action (splice on resolve, discard on session-end) — a
  Promise kicked off without awaiting, tracked in one field on the
  session, is enough. Node's event loop already handles the I/O-bound
  network call fine without needing worker threads.
- Don't try to run MULTIPLE background condensations in flight at once
  (e.g. firing a second one before the first resolves because the
  conversation kept growing). One in-flight background condensation at a
  time; if it resolves before the hard threshold, great — if the
  conversation is STILL growing fast enough to need another one soon
  after, that's a signal the early-fire threshold in part 1 needs tuning,
  not a case to handle by overlapping calls.

### Testing

- Unit test (mirror `src/engine/__tests__/condense.test.ts`'s
  `FakeLlmClient` pattern) with a condensation response that resolves
  AFTER several more main-loop iterations have appended new messages —
  assert the eventual splice lands at the correct (re-resolved) boundary
  in the now-longer history, not the stale snapshot boundary.
- Test the hard-fallback path: a background call that never resolves (or
  resolves too slowly) before the hard threshold — assert the synchronous
  path still fires exactly as it does today, and the session never exceeds
  the real context window.
- Test session-end-before-resolution: assert the in-flight result is
  discarded (not applied to a message array that's already been consumed
  by `attempt_completion`) but its usage still lands in `BudgetTracker`.
- A real-session check (not just unit tests): dispatch one comparable long
  session with this enabled and confirm condensation calls no longer show
  up as a visible pause in `harness.log`'s iteration cadence the way the
  original 55-80s blocking calls did.

## Also check: is there other queued work to fold into this round?

Before dispatching, check `plans/decision-proxy-agent.md` and
`plans/precise-plan-doc-citations.md` — both were written earlier tonight
and queued but not yet dispatched. They're independent of this doc's scope
(condensation timing/cost) and of each other, so dispatch them as their own
separate worktrees/rounds in parallel with this one rather than folding
their content in here — don't let this doc's scope creep to cover
unrelated work just because it's convenient to bundle.
