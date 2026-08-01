# Real context condensation (replace the sliding-window placeholder) — instructions for implementation

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI running a headless coding-agent loop. This is
the single biggest remaining structural cost/quality item in the harness —
read this whole document before writing any code, it changes core loop
semantics in `src/engine/loop.ts`.

Match this project's established style: no test framework (plain `tsx`-run
test files, hand-rolled `assert`, `All N tests passed` trailer); `npx tsc
--noEmit` and `npm test` must stay green; re-run every e2e suite under
`scripts/e2e*/run.sh`.

## The problem

`truncateHistory` in `src/engine/loop.ts` (search "Phase 1 sliding-window
truncation" in the file's own header comment — it explicitly says "Proper
token-based condensation is Phase 3," this task IS that Phase 3) evicts the
oldest messages in fixed batches once history exceeds `windowSize` (now 300
messages, raised today from 40 for exactly this reason). Evicted messages
are **gone** — not summarized, not compressed, just dropped. This was an
acceptable stopgap when the window was so small that eviction almost never
mattered for realistic tasks, but it's a real information-loss problem on a
genuinely long session: once something is evicted, the model has no way to
recall it and may re-derive it (re-reading a file, re-running a command) —
the exact class of waste `plans/read-file-cache.md` fixed for the identical-
repeat case, but that fix does nothing once the earlier read is evicted from
history entirely (the cache is keyed on args, not on "was this in the
window recently").

## What to build

**A token-budget-aware condensation pass, not just a bigger sliding
window.** When history approaches a real token budget (not just a message
count), summarize/merge the oldest chunk of the conversation into a compact
synthetic message instead of dropping it outright, then continue with the
summary + the recent, uncompressed tail.

### Design constraints (read carefully — these bound scope)

1. **Trigger on real token counts, not message counts.** The current
   `windowSize` is a message-count proxy because the loop doesn't count
   tokens for messages it hasn't sent yet. You have real token counts from
   each `LlmResponse.usage` (`promptTokens`, already tracked in
   `this.totalInputTokens` etc. in `HeadlessSession`) — use the LAST
   request's actual prompt token count as the basis for deciding "are we
   getting close to the model's real context window" rather than counting
   messages. The model's real context length varies (deepseek/deepseek-v4-
   flash's official endpoint is 1,048,576 tokens per the pin in
   `src/llm/openrouter.ts` — verify live via OpenRouter's
   `/api/v1/models/<id>/endpoints` the same way earlier work in this project
   did, don't hardcode a stale number). Trigger condensation at some
   configurable fraction of that (e.g. 70-80% — pick a default and justify
   it) rather than a fixed constant.
2. **Condensation itself costs an LLM call — account for it.** Summarizing
   the oldest chunk of conversation requires calling the model (or a
   cheaper one — see below) to produce the summary. This must be tracked in
   the SAME budget/cost accounting as everything else (`BudgetTracker`,
   `this.totalInputTokens` etc.) — a condensation pass that isn't counted
   would silently under-report real spend, repeating exactly the kind of
   cost-accounting bug this project spent real effort fixing today.
3. **The synthetic summary message must preserve tool-call-group integrity.**
   `plans/execute-command-background-semantics.md`'s sibling fix,
   `truncateHistory`'s recent tool-call-group-safe eviction fix (search
   "2026-08-01 fix" in `loop.ts`'s `truncateHistory` doc comment for the
   full incident writeup — an assistant `tool_calls` message split from its
   `tool` response caused a real HTTP 400 against DeepSeek's official
   endpoint), applies here too: whatever you condense, the boundary between
   "condensed into the summary" and "kept verbatim" must land on a clean
   turn boundary, never mid `tool_calls`/`tool`-response group. Reuse or
   generalize the existing boundary-finding logic in `truncateHistory`
   rather than reimplementing it independently — check if it can be
   factored into a shared helper both the fallback message-count path and
   this new token-aware path can call.
4. **Keep the sliding-window fallback for cheap/short sessions.** Not every
   session needs a real summarization LLM call — a short session that never
   approaches the token threshold should behave exactly as today (no
   condensation call, no added cost/latency). This is an enhancement layered
   on top of `truncateHistory`, not a wholesale replacement forced onto
   every session regardless of size.
5. **Prompt caching interaction — do not regress today's fix.** The batch-
   eviction rework earlier today exists specifically so the sent prefix
   stays stable between calls (provider-side cache hit rate). A condensation
   pass that rewrites history on every single call would defeat that just
   as badly as the original bug. Condensation should happen INFREQUENTLY
   (once the threshold is crossed, produce one summary, then that summary +
   recent tail stays stable across many subsequent calls until the tail
   itself grows enough to need condensing again) — same "batch, don't
   reslice every call" principle as the existing fix, applied to a token
   threshold instead of a message-count threshold.

### What model does the summarizing?

Your call, but consider: using the SAME model as the session (simplest,
consistent quality, but costs full-price tokens for a task that's mostly
mechanical compression) vs. a cheaper model via `resolveModelForMode`
(`src/config/mode-models.ts`, already built — could add a
`_condensation`-style key, or reuse `_default`) vs. eventually the local-
Ollama path from `plans/local-output-summarization.md` (if that lands and
proves reliable — but do not make a hard dependency on it, this task should
work standalone with a cloud model as the baseline). Document your choice
and reasoning.

## What NOT to do

- Do not remove `truncateHistory`'s existing message-count-based path —
  keep it as the cheap/default behavior for sessions that never cross the
  token threshold, per constraint 4 above.
- Do not defeat today's prompt-caching fix — constraint 5 is not optional.
- Do not silently under-count condensation's own LLM-call cost.
- Do not build this as a from-scratch summarizer — check
  `src/memory/summarizer.ts` (`buildRollingSummary`/`extractSessionSummary`,
  already used for Phase 3 memory's session-summary recall) first; it may
  already have logic worth reusing or adapting rather than duplicating,
  even though its current use case (end-of-session summary for cross-
  session memory) is different from this task's (mid-session condensation
  of stale turns) — read it before deciding whether to reuse or diverge.

## Tests

- New tests proving: below the token threshold, behavior is byte-identical
  to today (no condensation call happens — assert on a call counter, not
  just output).
- Above the threshold: a condensation call happens, produces a summary
  message, and the resulting history sent to the model afterward is
  shorter in token terms than before while still including the summary +
  recent tail.
- Tool-call-group boundary safety: build a fixture with irregular tool-call
  group sizes (mirror the approach in
  `testTruncateHistoryNeverSplitsToolCallGroup` in
  `src/engine/__tests__/loop.test.ts` — reuse that exact test's fixture-
  building pattern) and assert condensation never splits a group either.
- Condensation's own LLM usage is fed into the same budget tracker as the
  main session (assert on `totalInputTokens`/cost reflecting BOTH the main
  session calls AND the condensation call(s)).
- Prompt-cache stability: reuse/extend `testTruncateHistoryStablePrefixBetweenBatches`'s
  approach to prove the post-condensation prefix stays stable across
  multiple subsequent calls, not reshuffled every time.

## Verification checklist

1. `npx tsc --noEmit` clean.
2. `npm test` — all suites green including new ones.
3. Every e2e suite under `scripts/e2e*/run.sh` still passes.
4. If you have real API access: construct (or find/adapt) a long enough
   real or scripted-mock session to actually trigger condensation, and show
   in your report a before/after of the sent prompt's real token count,
   plus confirmation the model still produced coherent output using the
   condensed context (i.e. condensation didn't destroy information it
   actually needed).

## What to report back

- Your chosen token-threshold fraction and model-for-summarization choice,
  with reasoning.
- Confirmation of tsc/test/e2e results.
- Whether `src/memory/summarizer.ts` was reused, adapted, or intentionally
  not reused, and why.
- Real before/after token numbers from a triggered condensation, if you
  could run one.
- Any deviation from this spec, and why — this is the most architecturally
  significant task in this batch; if something in this design doesn't hold
  up against the real code, say so clearly rather than forcing a bad fit.
