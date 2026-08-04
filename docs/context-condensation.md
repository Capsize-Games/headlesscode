# Context condensation (Phase 3)

## What this is

`truncateHistory` in [`src/engine/loop.ts`](../src/engine/loop.ts) originally
evicted the oldest messages in fixed batches once history exceeded a message
count (`windowSize`). Evicted messages were **gone** — not summarized, not
compressed, just dropped. That was an acceptable stopgap for short sessions,
but on a genuinely long session it is real information loss: the model loses
earlier file reads, command outputs and decisions, and may re-derive them at
full cost (`plans/read-file-cache.md` fixed the identical-repeat case but not
the evicted-from-history case).

Phase 3 context condensation replaces the *information loss* of that
sliding window with a *token-budget-aware condensation pass*: when the last
request's real prompt-token count crosses a configurable fraction of the
model's real context window, the oldest complete turns are summarized by an
LLM into **one compact synthetic `user` message**, and the recent,
uncompressed tail is kept verbatim after it.

It is layered ON TOP of `truncateHistory`, not a replacement for it: a short
session that never crosses the token threshold behaves byte-identically to
before (no condensation call, no added cost/latency), and the sliding-window
fallback still bounds every request.

## How it works

### Trigger — real token counts, not message counts

The loop already receives the provider's real `promptTokens` in every
`LlmResponse.usage` and feeds it into `BudgetTracker` / `totalInputTokens`
(workstream 3). The condensation trigger uses the **last request's actual
prompt-token count** vs. a fraction of the model's real context window:

- **Context window**: resolved once per session from OpenRouter's
  `/api/v1/models/<id>/endpoints` (the same source the pricing table was
  verified against — see [`src/llm/openrouter.ts`](../src/llm/openrouter.ts)'s
  `fetchModelContextWindow`), with an explicit `--context-window` override and
  a conservative `DEFAULT_CONTEXT_WINDOW_TOKENS` (128000) fallback. The real
  value is never hardcoded.
- **Threshold fraction**: `DEFAULT_CONDENSE_THRESHOLD_FRACTION = 0.75`
  (configurable via `--condense-threshold`). See
  [`src/engine/condense.ts`](../src/engine/condense.ts)'s header for the
  trade-off reasoning (0.75 leaves a full quarter of the window as headroom
  for the next iteration's growth after condensation).

### The condensation call

The oldest chunk (bounded by `computeCondenseCount` — see below) is sent to
the model as a **2-message request** (`system` = `CONDENSE_SYSTEM_PROMPT`,
`user` = the delimited transcript) with **no tools**. The returned summary is
capped at `MAX_CONDENSED_MESSAGE_CHARS` (16000 chars); an empty or oversized
summary is rejected (non-fatal fallback). The synthetic message is a
`role: "user"` message — the only role that is always legal after a `tool`
message and before an assistant turn (DeepSeek's official endpoint 400s on
orphaned `tool` messages; see `truncateHistory`'s 2026-08-01 fix).

### Which model summarizes

Default: **the same model as the session** (simplest, consistent quality).
A cheaper model can be assigned two ways:

1. `--condense-model <id>` flag.
2. The `_condensation` key in
   `<workspaceRoot>/.headlesscode/mode-models.json` (consulted BEFORE the
   mode entry — its whole purpose is to override the session model for
   condensation, so a file setting both `"code"` and `"_condensation"`
   uses the cheap model; falls through to `mode` → `_default` — see
   [`src/config/mode-models.ts`](../src/config/mode-models.ts)'s `extraKeys`).

The local-Ollama path from `plans/local-output-summarization.md` is NOT a
dependency — this works standalone with a cloud model. It could be wired in
later via the same `condenseModel` indirection.

### Tool-call-group boundary safety

The condensation boundary never splits an assistant `tool_calls` message from
its `tool` response messages. The shared helpers
`computeEvictCount` / `skipOrphanedToolMessages` / `computeCondenseCount` in
[`src/engine/condense.ts`](../src/engine/condense.ts) enforce the same
invariant for both the message-count fallback (`truncateHistory`) and the
token-aware condensation path — one implementation, not two.

### Prefix stability / prompt caching (constraint 5)

Condensation happens INFREQUENTLY and the session's working message state is
replaced with the condensed array. A `condensedUpTo` marker + the
`MIN_CONDENSE_TAIL_GROWTH` guard mean the sent prefix
(`[system, firstUser, summary, ...recent tail]`) stays **byte-identical
across many subsequent calls** — the condensation equivalent of
`truncateHistory`'s fixed-batch eviction — so provider-side prompt caching
can accrue. The tail must re-grow past `MIN_CONDENSE_TAIL_GROWTH` (20)
messages AND re-cross the token threshold before another condensation runs.

### Cost accounting (constraint 2)

A successful condensation call's usage is fed into the **same**
`BudgetTracker` + `totalInputTokens` / `totalOutputTokens` /
`totalCachedTokens` as the main session (`recordCondensationUsage` in
[`src/engine/loop.ts`](../src/engine/loop.ts)). A `BudgetExceededError` from
that accounting aborts the session exactly like a main call's `record()` trip
— condensation spend is never invisible.

### Failure contract (non-fatal)

The condensation LLM call is an auxiliary subsystem. Any failure (timeout,
provider error, empty/oversized summary) resolves to `null` and the session
falls back to `truncateHistory` for that call — it never fails or blocks the
session. The single exception is a budget trip from the usage accounting,
which is not non-fatal (see above).

## Config

| Flag | Default | Meaning |
| --- | --- | --- |
| `--context-window <n>` | live OpenRouter lookup, else 128000 | the model's real context window in tokens |
| `--condense-threshold <f>` | 0.75 | fraction of the context window at which condensation triggers (0 < f < 1) |
| `--condense-model <id>` | the session model / `_condensation` key | model used for the condensation call |

## Tests

[`src/engine/__tests__/condense.test.ts`](../src/engine/__tests__/condense.test.ts)
covers:

- below the threshold → byte-identical behavior, **zero condensation calls**
  (asserted on a call counter);
- above the threshold → a condensation call happens, produces a summary, and
  the history sent afterward is shorter while including the summary + tail;
- tool-call-group boundary safety (irregular group sizes, mirroring
  `testTruncateHistoryNeverSplitsToolCallGroup`);
- condensation usage lands in the same BudgetTracker (cost reflects both main
  and condensation calls);
- post-condensation prefix stability across subsequent calls;
- budget trip from a condensation call aborts like a main call;
- non-fatal failure (fallback to `truncateHistory`).

`scripts/e2e/condense-demo.mjs` is a standalone live demo (not part of
`npm test`) that drives the real CLI against a mock OpenRouter reporting real
token counts, and prints a before/after request log.
