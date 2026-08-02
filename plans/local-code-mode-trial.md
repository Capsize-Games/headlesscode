# Local qwen model driving `code` mode end-to-end — one bounded, closely-watched trial

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI running a headless coding-agent loop. **The
project owner explicitly requested this after being told the risks and
choosing to proceed anyway — this is not a recommendation being executed
reluctantly, it's a deliberate, informed experiment.** Match that framing:
build it for real, run it for real, report the real result — including if
the real result is "this doesn't work well yet."

Every prior local-model feature in this project (`local-output-summarization`,
`local-explore-phase-experiment`) was scoped narrowly — read-only, or pure
text compression — specifically because writing/executing code directly is
categorically higher-stakes: a bad decision there isn't cheap to discard the
way a bad exploration guess is. **This task is the first time a local model
gets real write/execute authority.** Treat every safety requirement below as
load-bearing, not boilerplate.

Match this project's established style: no test framework (plain `tsx`-run
test files, hand-rolled `assert`, `All N tests passed` trailer); `npx tsc
--noEmit` and `npm test` must stay green; re-run every e2e suite under
`scripts/e2e*/run.sh`.

## What already exists — read this before writing anything new

`src/engine/local-explore.ts`'s `OllamaLocalChatClient` already solved the
real wire-format problems for talking to Ollama's `/api/chat` (verified live
2026-08-01/02, read its header comment in full):
- Ollama wants `function.arguments` as a parsed OBJECT in both directions,
  not the JSON-string form OpenAI/OpenRouter use — translate at the
  boundary, same as that client already does.
- `think: false` was used there specifically because a PLAIN-TEXT reply with
  thinking enabled leaves `message.content` empty (reasoning goes to a
  separate `thinking` field instead). **This task needs `think: true`** (per
  the project owner's explicit requirement) — verify live, but the working
  theory going in: a TOOL-CALLING reply already normally has empty
  `content` alongside populated `tool_calls` (true in the OpenAI-compatible
  format generally, not a local-model quirk) — so thinking mode should be
  fine for most turns. The one real edge case to handle explicitly: a
  plain-text-only reply (no tool call) with thinking on, where `content` is
  empty. Do not let that silently crash or silently produce an empty
  "success" result — verify what Ollama actually returns in that shape live
  and handle it deliberately (likely: treat it the same way
  `src/engine/loop.ts`'s existing "empty reply counted as mistake" path
  already handles a genuinely empty non-tool-calling reply from ANY model —
  reuse that behavior, don't invent new handling for a case the loop
  already knows how to deal with).

## What to build

### 1. A general-purpose Ollama `LlmClient`

New `src/llm/ollama.ts`: a client implementing the real `LlmClient` interface
(`src/engine/types.ts` — `createChatCompletion(request: LlmRequest):
Promise<LlmResponse>`), not the narrower `LocalChatClient` interface
`local-explore.ts` used (that one only ever needed 2 read-only tools; this
one needs to work with the FULL tool set — `write_to_file`, `apply_diff`,
`search_replace`, `edit_file`, `execute_command`, everything `code` mode
normally has). Reuse `OllamaLocalChatClient`'s verified wire-format handling
(the object-vs-string tool-arguments translation) rather than
re-deriving it — factor it into a shared helper both clients can use if
that's cleaner than duplicating it.

- `think: true` on every request (per the explicit requirement). Capture the
  response's `thinking` field into `LlmResponse`/`ChatMessage.reasoning`,
  reusing the SAME reasoning-capture shape `streaming-and-reasoning.md`
  already built for the cloud path (`src/engine/events.ts`'s `reasoning`
  field on `llm_response` events) — so local reasoning shows up in the
  dashboard the same way cloud reasoning does, not as a separate,
  inconsistent mechanism.
- Cost is always $0 for a local call — `LlmResponse.usage` should still
  report real token counts (for observability/context-budget tracking) but
  the budget tracker must price it at $0, not fall through to a
  cost-per-token table that was never meant for a local model. Verify this
  is actually true end to end (a real session, real usage.jsonl output,
  `costUsd` genuinely $0 for the local portion) — don't just assert it from
  reading the code.

### 2. Client selection for `code` mode, opt-in and scoped

New env vars (e.g. `HEADLESSCODE_CODE_MODE_BACKEND=ollama`,
`HEADLESSCODE_CODE_MODE_MODEL=qwen3.5:9b`, default backend stays
`openrouter` — do not change default behavior for anyone not opting in).
Wire into `src/cli.ts`'s client construction: when the resolved mode is
`code` AND this backend is selected, construct the new Ollama client instead
of `OpenRouterClient`. **This must be scoped to `code` mode specifically, not
applied globally** — `deepseek-reviewer`, `qa-agent`,
`multi-agent-orchestrator-headless`, and everything else keep using
`OpenRouterClient`/cloud DeepSeek regardless of this setting, per the
project owner's explicit framing ("everything EXCEPT code mode" stays
cloud). Check how mode resolution already happens in `src/cli.ts` (it
already threads `--mode` through) rather than inventing a parallel path.

### 3. Context-budget correction — this is not optional

`src/engine/condense.ts`'s `maybeCondenseHistory` does a LIVE lookup of the
model's real context window (against OpenRouter's models endpoint) with a
`DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000` fallback — that lookup mechanism
doesn't know about local Ollama models and would either fail or return a
meaningless answer for `qwen3.5:9b`. **A full `code`-mode session run
locally will grow far larger and more varied than the bounded 15-iteration
exploration phase ever did** — real coding work needs many more turns, and
without a correct context ceiling, a long local session will try to exceed
what the hardware can actually hold (real live-measured ceiling: ~131,072
tokens solo at ~12GB, per `plans/local-explore-phase-experiment.md`'s
measurements — re-verify live, these can shift). When the Ollama backend is
selected for `code` mode, condensation must use the REAL local ceiling, not
attempt the OpenRouter models-endpoint lookup and not silently fall back to
a number that doesn't reflect this hardware's actual limit. Wire this
explicitly — don't let it silently inherit the cloud-oriented default.

### 4. codebase_search + the embedding-model VRAM question, revisited

`local-explore-phase-experiment.md` deliberately excluded `codebase_search`
from its tool set specifically to avoid `qwen3.5:9b` and
`qwen3-embedding:8b` needing to coexist in VRAM. A full `code`-mode session
legitimately wants `codebase_search` throughout, not just at the start —
the temporal-separation trick that worked for a one-time bounded pre-pass
doesn't apply to a long, unbounded-shape session that might call it at any
point. Investigate and report on the real tradeoff live (reuse the exact
measurement methodology from `local-explore-phase-experiment.md`'s own VRAM
section): does keeping `code` mode's context budget low enough for
coexistence (~28K, per that document's measurements) work acceptably, or
does `codebase_search` need to fall back to the OpenRouter embedding
backend specifically when the Ollama code-mode backend is active (accepting
a small real cost for embeddings in exchange for full local context for
generation)? Make a real, live-verified call here and document it — don't
guess.

## Safety requirements for the trial itself — all mandatory

- **Run only in an isolated worktree**, never directly against a repo with
  real uncommitted work.
- **Checkpoints must be on** (the executor's existing default for
  edit-capable sessions — confirm this isn't accidentally bypassed for the
  new client path).
- **A conservative iteration cap for the first real trial** (your call on
  the exact number, but bounded, not the usual 200 — this is explicitly a
  "see if it works" run, not a production task).
- **This round is significant by definition — apply the Step 3.5 review
  gate** (`.roomodes`) regardless of task count: a local model writing code
  and running commands for the first time is exactly the class of change
  that must not self-merge on self-verification alone. An independent
  `deepseek-reviewer` pass is mandatory before anything from this trial is
  trusted, on top of this task's own honest-evaluation requirement below.

## The honest evaluation — the actual point of this trial

Pick ONE real, moderately-substantial coding task (not trivial, not huge —
something with a real correctness bar, e.g. implementing a small
well-specified function with tests). Run it twice, identical task text:
once with `code` mode on cloud DeepSeek (today's normal path), once with
`code` mode on local `qwen3.5:9b` via this new client. Compare, with real
numbers:
- Cost (should be near-zero for the local run's generation, real numbers).
- Wall-clock (expect local to be meaningfully slower — quantify it).
- **Correctness**: does the local run's code actually compile, pass its own
  tests, and correctly do what was asked? This is the number that actually
  matters most here — a cost win with broken or incorrect code is not a
  win. Be specific and honest: if it produces working code, say so with
  evidence (real tsc/test output); if it produces broken or subtly wrong
  code, say so with the same rigor, quoting exactly what's wrong.
- Any tool-calling reliability issues specific to the full tool set (not
  just the 2 read-only tools `local-explore` already validated) — malformed
  calls, wrong arguments, anything the strict-mode/schema work from earlier
  today would have caught for the cloud path.

## What NOT to do

- Do not apply this to any mode other than `code`.
- Do not change the default backend — opt-in only.
- Do not skip the Step 3.5 review gate for this round regardless of how it
  looks from self-verification alone.
- Do not silently let condensation use a context ceiling that doesn't
  reflect the local model's real VRAM limit.
- Do not present a rough or partially-broken result as a success — the
  entire value of this task is an honest answer, positive or negative.

## Tests

- `src/llm/__tests__/ollama.test.ts`: full `LlmClient` interface conformance
  against a fake local HTTP server (tool-calling round trip with the full
  tool set, `think: true` with both a tool-calling reply and a plain-text
  reply, cost always $0, thinking content captured correctly).
- A test proving `code`-mode client selection only activates the Ollama
  backend when explicitly configured, and only for `code` mode — construct
  a session for a different mode with the same env vars set and confirm it
  still uses `OpenRouterClient`.
- A test proving condensation uses the correct local context ceiling when
  this backend is active, not the OpenRouter-lookup path.

## Verification checklist

1. `npx tsc --noEmit` clean.
2. `npm test` — all suites green including new ones.
3. Every e2e suite under `scripts/e2e*/run.sh` still passes (feature OFF by
   default — confirm nothing changed for existing suites).
4. The honest evaluation above, run for real, with real quoted evidence for
   the correctness comparison specifically.
5. Independent review (Step 3.5) completed and passed before anything
   merges.

## What to report back

- The full honest evaluation: cost, wall-clock, and — most importantly —
  a rigorous, evidence-backed correctness comparison between the cloud and
  local runs on the identical task.
- Your resolution of the `codebase_search`/embedding-coexistence question
  for a full-length session, with real measurements.
- Whether `think: true` worked cleanly for tool-calling turns as expected,
  and exactly how the plain-text-with-empty-content edge case behaved in
  practice.
- Confirmation of tsc/test/e2e results.
- The independent reviewer's verdict, in full.
- Your honest overall verdict: does local-model-driven `code` mode work
  well enough to consider using beyond this one trial, or not — and
  specifically why, with evidence.
