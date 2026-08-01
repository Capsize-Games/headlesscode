# Streaming responses + reasoning-content capture — instructions for implementation

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI running a headless coding-agent loop. This is
a browser-parity item: the VS Code Zoo Code extension streams the model's
response token-by-token and shows its live reasoning/"thinking" text; the
headless harness currently does neither.

Match this project's established style: no test framework (plain `tsx`-run
test files, `All N tests passed` trailer); `npx tsc --noEmit` and `npm test`
must stay green; re-run every e2e suite under `scripts/e2e*/run.sh`.

## The problem, confirmed by reading the actual code

`src/llm/openrouter.ts`'s `createChatCompletion` makes one single blocking
`fetch` POST and waits for the complete response — no `stream: true`, no SSE
parsing (confirmed: zero references to "stream" in the file as of this
writing). Separately, `deepseek/deepseek-v4-flash` supports
`reasoning`/`include_reasoning` per its OpenRouter endpoint listing
(`supported_parameters`, verified live earlier today) — but this harness
never requests it, and `src/engine/events.ts`'s `EventRecord` (which already
has an open `[field: string]: unknown` shape, easy to extend) never captures
any reasoning content. So a real worker's actual "thinking" is fully
invisible today, both in `harness.log` and in the dashboard's live event
feed — the model's response only appears once it's completely finished.

These two are grouped in one task because they're related at the wire level
(reasoning content, when requested, typically arrives as part of the same
streamed response) but they are separable in implementation — you may ship
reasoning-capture on the NON-streaming path first if that's lower-risk, then
layer streaming on top. Say explicitly in your report which order you took
and why.

## What to build

### 1. Request + capture reasoning content (can ship without streaming)

In `buildRequestBody` (`src/llm/openrouter.ts`): add `include_reasoning:
true` (or whatever the exact verified parameter is — confirm against a real
live call, don't assume the param name from memory) for models that support
it (check `supported_parameters` isn't something you can introspect per-
request without an extra API call — likely simplest to just always request
it for `deepseek/*` models, since that's the only family this harness pins
today, and note that other models may ignore or reject the param; verify
what actually happens if you request it from a model that doesn't support
it — clean ignore vs. an error — before deciding whether to gate it by
model prefix or send it unconditionally).

In `mapUsage`/the response handling: capture `message.reasoning_content` (or
whatever the verified real field name is) into `LlmResponse` (extend the
type in `src/engine/types.ts` — add an optional `reasoning?: string` on
`ChatMessage` or a sibling field on `LlmResponse`, your call, but keep it
optional so nothing that doesn't request/receive it breaks).

In `src/engine/loop.ts`: when a response includes reasoning content, emit it
on the event feed (extend `EventFeed`'s `llmResponse` event — check its
current fields in `src/engine/events.ts` — with a `reasoning` field,
respecting `EVENT_TRUNCATE_CHARS` the same way other large fields already
do via `truncateField`). Also decide whether reasoning content should be
included when re-sending history back to the model on the NEXT call (Zoo
Code's own real behavior here is worth checking in
`zoo-code/src/api/providers/` if it round-trips reasoning content in
history — verify rather than guess, and note whichever real behavior you
found and matched or deliberately diverged from).

**Cost implication — verify and document:** reasoning tokens are typically
billed as output tokens. Confirm this against a real request (check
`usage.completion_tokens` before/after enabling `include_reasoning` on an
identical prompt) and make sure `src/budget/cost.ts`'s existing output-
token pricing already covers it correctly (it likely does, since it prices
whatever `completionTokens` reports — but verify this isn't double-counted
or missed, don't assume).

### 2. Streaming (SSE) — larger, build on top of #1

Add `stream: true` support as an opt-in path (new config/env, default OFF —
do not change the default blocking-request behavior, which many parts of
this project's test suite and e2e fixtures assume). When enabled:
- Parse OpenRouter's SSE stream (`data: {...}` lines, `[DONE]` terminator —
  verify the exact real format live, this is a well-known but
  provider-specific wire format, don't assume without checking).
- Incrementally emit event-feed entries as tokens/reasoning chunks arrive
  (a new event type, e.g. `llm_stream_chunk`, distinct from the existing
  `llm_response` summary event which still fires once at the end with
  final totals) so the dashboard can show live-typing text, matching what
  `realtime-monitoring.md`'s own header comment explicitly deferred
  ("true token-level streaming is deliberately NOT in scope" — this task IS
  that deferred follow-up, re-read that plan's final merged state first).
- `AbortController`/timeout handling (`src/engine/loop.ts`'s existing
  `llmTimeoutMs` logic) must still work correctly against a streamed
  response — a stream that stalls mid-way must still time out, not hang
  forever waiting for more chunks.
- Tool-call parsing: OpenAI-compatible streaming APIs deliver tool_calls
  incrementally too (partial JSON arguments across multiple chunks) — this
  is real complexity, verify the actual behavior live rather than assuming
  it "just works" the same as the non-streaming path. If reassembling
  streamed tool calls turns out to be substantially riskier than the value
  it adds, it is acceptable to say so plainly and ship streaming for
  TEXT/reasoning content only in this pass, falling back to the existing
  non-streaming path specifically for tool-call-bearing turns — document
  this tradeoff explicitly if you take it, don't silently under-deliver.

## What NOT to do

- Do not change default behavior for anyone not opting into streaming.
- Do not break `AbortController`-based timeout handling.
- Do not silently miscount reasoning tokens in cost accounting.
- Do not build a general-purpose SSE client library beyond what this needs.

## Tests

- Reasoning capture: a fake `LlmClient`/mock server test proving
  `reasoning_content` flows from the raw response through to the event feed
  correctly, truncated per `EVENT_TRUNCATE_CHARS` like other large fields.
- Streaming: a fake SSE server (mirror `scripts/e2e/mock-openrouter.mjs`'s
  existing mock pattern, extend it to support a streaming mode rather than
  building a separate mock from scratch) proving chunks are emitted
  incrementally and the final assembled message matches what a non-streamed
  equivalent response would have produced.
- Streaming + timeout: a mock server that stalls mid-stream, proving the
  existing timeout logic still aborts correctly.
- Cost accounting: reasoning/streamed token counts still feed the budget
  tracker correctly (no double-count, no miss).

## Verification checklist

1. `npx tsc --noEmit` clean.
2. `npm test` — all suites green including new ones.
3. Every e2e suite under `scripts/e2e*/run.sh` still passes (with streaming
   OFF by default — confirm nothing changed for existing suites).
4. If you have real API access: one real call with `include_reasoning`
   enabled, quoting the actual raw response field you captured. If
   streaming was implemented, one real streamed call, confirming chunks
   arrive incrementally (not just verifying the parser against a
   canned/mock fixture).

## What to report back

- Real, verified field names/wire format for reasoning content and SSE
  streaming (quote what you found, don't restate this document's guesses
  as if they were confirmed).
- Whether you shipped reasoning-capture only, streaming only, or both, and
  why.
- How streamed tool-call reassembly was handled, or why it was
  deliberately deferred if you judged it too risky for this pass.
- Confirmation of tsc/test/e2e results.
- Cost-accounting verification (reasoning/stream tokens correctly priced).
- Any deviation from this spec, and why.
