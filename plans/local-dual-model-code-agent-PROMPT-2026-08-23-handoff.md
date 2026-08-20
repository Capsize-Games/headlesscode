# Handoff — local dual-model code agent, 2026-08-20 session (continuing 08-19/08-21)

Reference doc for `local-dual-model-code-agent-PROMPT-2026-08-23.md`. Read
`local-dual-model-code-agent-PROMPT-2026-08-22-handoff.md` FIRST — this doc
only covers what changed since it (the sampling-level intervention it
proposed, nine new fixes that came out of chasing it plus one confirmed-
inert attempt, RESOLVING the empty-generation mystery entirely, and a
newly characterized, still-unresolved daemon hang with three ruled-out
theories). Don't re-derive the eleven prior fixes or the earlier infra
setup from scratch.

## The owner's framing (verbatim, don't lose this — unchanged from the prior doc)

> i don't believe we've hit model capability ceilings yet at all. i don't
> buy it. there's something wrong with our harness, tool instructions,
> prompts or something else. write a prompt to investigate this and
> continue running trials and pushing this model's capabilities. we want
> to keep refining, keep improving, keep tweaking our implementation until
> this model is solid

Also this session, on watching background trials: the owner flagged that
follow-up questions and hangs were being missed because the watch command
only checked for exit, not for a legitimate decision-block. Fixed by
building a canonical three-signal watcher (exit / needs-decision / stall)
used for every trial dispatch from that point on — see "Watching trials"
below. Use it, don't write an ad hoc `until grep -q EXIT: ...` loop again.

## What this session tried and found (in the order it happened)

**1. repeat_penalty boost on identical-call retry — insufficient alone.**
headlesscode `c06f3f5` + airunnerdesktop `b648425dd`: wired an Ollama
`options.repeat_penalty` override through to `LLMRequest.repetition_penalty`
(the plumbing existed via `generation_execution_support.py`'s raw-mode
sampling patch, but nothing ever read the option — dead wiring), and
widened `last_n_tokens_size` from llama-cpp-python's construction-time
default of 64 to 4096 (`chat_gguf.py`, `chat_gguf_model_runtime_config.py`)
— at 64, repeat_penalty literally could not see a repeated tool call from a
couple of turns back (one agentic turn, chat template + JSON args + tool
result, routinely runs several hundred tokens). This was a necessary
precondition, verified live, but NOT sufficient: repeat_penalty=1.3 failed
to break the `list_files "."` loop in 3 separate live trials (20, 22, 26),
and 1.8 failed once cleanly (27). Kept as a first-line, low-cost lever —
harmless, occasionally may help — but don't expect it alone to fix
anything.

**2. Tool exclusion — the mechanism that actually works, once two separate
leaks in it were closed.** headlesscode `938bec1`: once the identical-call
streak reaches the nudge threshold, the retry request's own `tools` array
drops the repeated tool's schema entirely (`this.state.tools` filtered,
`attempt_completion` always exempt — it's the model's only way out).
Verified live this DID stop the exact 4x-hard-stall (`identical call
repeated`) that killed trials 20/22/26/27 — but two live trials (28, 29)
showed the model still executing `list_files` afterward anyway, via two
independent leaks, both now fixed and both reproduced/verified live:

  - **Leak A (headlesscode side, `eaf97f9`):** llama.cpp's own
    grammar-constrained native tool-calling correctly refused to emit a
    genuine `tool_calls` entry for the excluded tool — but the model
    narrated the same call as prose instead, and headlesscode's
    `extractEmbeddedToolCall` recovery validated the recovered name
    against `this.state.tools` (the session's full default catalog)
    instead of the tools actually offered on that specific request. Fixed:
    validate against the same `excludedToolNames` computed for the
    request.
  - **Leak B (airunnerdesktop side, `1d9355f0b`):** even after Leak A was
    fixed, the SAME excluded tool still executed. Root cause: when
    llama.cpp's native structured tool-call buffer is empty (correctly, for
    an excluded tool), `_resolve_stream_tool_calls`
    (`chat_gguf_streaming_native_chunks.py`) falls back to
    `adapter._extract_tool_calls(full_text)` — a regex/XML/JSON text
    extractor with zero concept of which tools were offered. Fixed:
    filter the fallback's output against `adapter.tools` (the tools
    actually bound to THIS request — `bind_tools()` makes a fresh shallow
    copy per request via `model_copy(deep=False)`, so this is never
    stale).

  With BOTH leaks closed, verified live (trial 31): the excluded tool
  never executed again across 8 consecutive turns, where it had previously
  slipped through every ~3 turns. **This is the actual fix for the
  original narrow bug** ("once repeating, immune to corrective nudges").

**3. What happens once the loop is genuinely broken: two DIFFERENT,
pre-existing guardrails catch the fallout, not success.** With the tool
correctly denied, the model doesn't reliably substitute a productive
action — it either (a) keeps trying variations of read-only exploration
(different args/tools) without progress, caught by the pre-existing
read-only-stall guardrail at 75 (trials 28, 29 both ended this way, having
survived to iteration ~80-81 — a big improvement over dying at iteration
~10, but not a completion), or (b) once even THAT'S blocked, produces
repeated non-completing text replies, caught by the consecutive-mistakes
limit (trials 31/33, "consecutive empty replies", 8/8).

**3a. Half of (b) turned out to be a real, now-fixed bug, not model
confusion.** Added a debug field (`textPreview`, kept — see headlesscode
`c1dd87b`) to see what the model was actually writing during those
non-completing replies. Answer: literally nothing — the logged text was
`"The model produced an empty reply for this request. No changes were
applied."`, airunnerdesktop's own synthetic fallback for a genuinely
EMPTY (zero-token) generation, not model-authored prose. Root cause: the
identical-call guard's streak state (`identicalCallStreak`,
`lastCallBatchSignature/Names`) only updates inside the `calls.length > 0`
branch — once the model stops emitting tool calls at all, that block is
skipped every subsequent turn, so the elevated repeat_penalty boost and
tool exclusion it drives stayed permanently latched on, reapplied to
every following request indefinitely, long after any new repeat could
have occurred. Fixed (headlesscode `c1dd87b`): the guard resets whenever
a turn produces zero tool calls.

**3b. That fix immediately surfaced a second bug: exclusion was a
one-shot deterrent.** With the streak correctly resetting, the model's
very next REAL action was to call the just-excluded tool again —
rebuilding the streak from scratch and re-triggering exclusion two turns
later. Without a cooldown this is an indefinite exclude/retry
oscillation: 48+ cycles observed in one trial (36), never hard-failing
(each cycle also resets `consecutiveMistakes`) but never progressing
either. Fixed (headlesscode `7433919`): `excludedToolCooldowns` keeps a
tool excluded for several turns PAST the streak that triggered it,
independent of the streak state resetting. Verified live (trial 37):
this genuinely broke the infinite oscillation — the session ran 228
iterations (vs. hard-failing at 8) before ending via the SEPARATE
read-only-stagnation guardrail. Debug data from that trial: of 228
iterations, 148 were non-completing replies and EVERY SINGLE ONE was the
literal, identical fallback string `"The model produced an empty reply
for this request. No changes were applied."` — 100% zero-token
generations, not model-authored text of any kind, whenever a tool was
excluded (streak-active or cooldown-only).

**3c. Tried forcing `tool_choice: "required"` on excluded-tool requests
— NEGATIVE RESULT, don't retry this exact approach.** Hypothesis: with
default `tool_choice: "auto"`, a free-text/empty branch stays available
for the decoder to collapse into once its preferred tool is removed;
`"required"` should close that branch. Wired through (headlesscode
`15145cc` — `LlmRequest.toolChoice` → `OllamaClient`'s top-level
`tool_choice` field → the daemon's existing `_ollama_chat_request`
handling, no airunnerdesktop change needed) and applied whenever any
exclusion is active. Live trial (38) still hit an empty reply with
`tool_choice: "required"` genuinely set. **Isolated further with raw
curl requests directly against the daemon, bypassing headlesscode
entirely** (see the ground rules — this is exactly the required
bypass-repro step): a single-tool, `tool_choice: "required"` request
with a REALISTIC token budget (`num_predict: 1000` — a tiny budget like
10-20 is a trap, see below) got a normal, coherent response, but the
model still responded with plain text explicitly DECLINING to call the
one available tool, rather than being forced to. **`tool_choice` appears
to be genuinely inert for this daemon's chat-calling path** — confirmed
via the same isolation session that Qwen3's tool-calling here goes
through an HF-chat-template-based handler
(`chat_gguf_hf_chat_handler.py`) that renders tool definitions as PROMPT
TEXT with instructions to emit `<tool_call>{...}</tool_call>` XML-style
tags, then relies on regex/text extraction afterward — NOT llama.cpp's
grammar-constrained JSON-schema tool-calling mode, which is the ONLY
mode where `tool_choice: "required"` has real teeth. The
headlesscode-side wiring is harmless and stays (a future model/handler
that DOES respect it benefits for free), but don't expect it to fix
anything for Qwen3 on this handler.

**3d. Followed the "capture the actual rendered prompt" lead from 3c and
found a second, much bigger bug: a self-reinforcing history-poisoning
loop.** Re-added the debug dump in `chat_gguf_hf_chat_handler.py`'s
`_chat_formatter_response` (append-to-file this time, not a log print,
to capture the FULL prompt not just a tail) and ran a real trial until
it hit repeated empty replies. Diffed the raw prompt across three
consecutive requests during the pattern: **byte-for-byte IDENTICAL**.
Mechanism: airunnerdesktop's own synthetic diagnostic string ("The model
produced an empty reply for this request...",
`generation_response_support.py`'s `fallback_response_for_empty_result`
— a wire-response placeholder, NEVER model-authored) was being persisted
into headlesscode's conversation history verbatim via the normal
assistant-message-append path, then fed back to the model on the next
turn as if it had actually said that. Each cycle appended the fixed
fallback text plus the equally fixed "[System: ...]" nudge, and
`truncateHistory` evicted matching-sized older batches — netting a
stable trap where the prompt literally never changed. Same failure
family as an EARLIER session's narrated-tool-call fix (`c274ddc`):
synthetic, non-model text must never be persisted as if the model said
it. Fixed (headlesscode `7a8d2f5`): the two known fallback strings are
detected and cleared to `null` before persisting, exactly mirroring that
precedent. **Verified live (trial 40): token counts across the session
now genuinely vary (9693→10043→... instead of frozen at one exact
value)** — the specific self-reinforcing trap is confirmed broken. Still
148 non-completing replies in that same trial, so **the underlying "why
does generation sometimes produce nothing when a tool is excluded"
question is still open** — this fix stops it from calcifying into an
unbreakable loop, it doesn't explain the original empty generations. The
now-cleared debug dump technique (append full prompts to a file, not
just a log tail) is the right tool for continuing that investigation —
next time, compare an actual empty-reply-producing prompt (not the raw
curl repro's minimal case, which did NOT reproduce it) against a
normal-succeeding one from the SAME trial for structural differences.

**3e. Clearing the fake content wasn't sufficient either — the nudge
message itself was just as static.** Re-captured a fresh empty-reply
prompt (trial 41) with 3d's fix active: STILL byte-for-byte identical
across consecutive requests. Reasoning: a FIXED-SIZE pair (assistant:
`null`, user: nudge) gets appended every cycle regardless of what the
content specifically is, and `truncateHistory` evicts a matching-sized
older batch — the trap re-forms from the SHAPE of the injection, not
its content. Fixed (headlesscode `3b02e20`): the mistake count is
appended to the nudge text (`"...(attempt N)..."`), so repeated
occurrences can't be byte-identical even if the underlying model
behavior is unchanged.

**3f. Turned off `tool_choice: "required"` — implicated in a THIRD,
separate frozen-prompt pattern.** Re-verifying 3e live (trial 42),
found yet another byte-identical-prompt pattern, but this one had a
distinctive tell: no `(attempt N)` text anywhere, and a pre-closed EMPTY
`<think></think>` block at the tail — meaning it wasn't going through
3d/3e's code path at all. Every occurrence had `tool_choice='required'`.
Combined with 3c's finding that `"required"` does nothing for actual
tool selection here, this suggested `"required"` might route through a
DIFFERENT internal prompt-construction path in llama-cpp-python
entirely. Reverted applying it (headlesscode `d9d58e7`, wiring kept for
a future handler that might respect it) to test the theory.

**3g. Theory in 3f was WRONG, and the real finding is much bigger: this
frozen-prompt pattern has NOTHING to do with tool_choice, or even with
this session's conversation history at all.** Re-ran the same live test
(trial 43) with `tool_choice: "required"` fully removed — the
byte-identical `<think></think>`-tail pattern reproduced anyway, at the
exact same two lengths (48295/49568 bytes) as before. Inspected the
FULL captured prompt this time (not just the tail): **it contains ZERO
`<|im_start|>user` turns** — just the system prompt, the tool
definitions (`n_tools=11`, matching the exclusion being active), and the
empty assistant turn-opener. No task, no conversation, nothing for the
model to respond to. Ruled out `condenseOldestTurns` (headlesscode's own
context-condensation call) as the source — it always sends both a
system AND a user message and never passes `tools`, so this can't be
that. **This may be the actual root cause of the empty-generation
mystery from 3, 3c, and 3d/e**: if the model is being asked to generate
against a prompt with no user turn at all, "empty reply" is the
UNSURPRISING outcome, not a mysterious degenerate collapse — the real
bug would be upstream, in whatever builds/dispatches this specific
request, dropping the actual task content. Not yet identified WHICH code
path produces this stripped-down request, or why it correlates with
`n_tools=11` (exclusion active) — this is the single most promising lead
for the next session. The debug technique (append full rendered prompts
to a file in `chat_gguf_hf_chat_handler.py`'s `_chat_formatter_response`,
NOT just a tail — the earlier tail-only version in 3c missed this
entirely) was reverted after use, same as every other time this session;
re-add it there to continue.

**3g addendum — a code-read narrowed the search space, but didn't reach
a conclusion.** `legacy_ollama_compat.py`'s `_chat_prompt_parts` (called
from `ollama_chat`, feeding `_ollama_chat_non_stream`) flattens
headlesscode's ENTIRE messages array into ONE string via
`_render_prompt_turn` per message, joined with `"\n\n"` — this is
consistent with the daemon's own debug logging seen earlier this session
("Total messages in state: 1", "Message 0: HumanMessage - ...") i.e. the
whole conversation becomes a SINGLE flattened HumanMessage, not multiple
LangChain turns. `_render_prompt_turn` returns `""` (dropped from the
transcript) for an assistant turn with no content AND no tool_calls —
exactly the shape headlesscode's own `null`-content fix (7a8d2f5)
produces, so that part is expected/correct. But `truncateHistory` always
keeps `messages[1]` (`firstUser`, the original task) unconditionally, and
`_render_prompt_turn`'s default branch (`return content` for role
`"user"`) should render that non-empty original task text every time —
so on a pure code read, `rendered_turns` should never end up FULLY empty
just from this. Two directions not yet tried: (a) confirm empirically
that `firstUser` really does survive into the request that hits this bug
— dump the RAW incoming `messages` array (not just the rendered prompt)
alongside the `_chat_formatter_response` dump, at the API route level
(`ollama_chat`, right where `messages = body.get("messages", [])` is
read) so the two can be compared directly for the SAME request; (b)
`_prepare_request_memory`'s "clearing conversation history for this
request" log line (fires on every request due to `use_memory=False`) has
not been read — confirm it only clears FRAMEWORK-level persistent memory
and doesn't touch the `messages` list `_chat_prompt_parts` operates on,
since "conversation history" language is suspicious enough to verify
directly rather than assume.

**3g addendum #2 — DID check (a) live, and it rules out headlesscode's
request and `_chat_prompt_parts` entirely.** Dumped the raw incoming
`messages` array AND `_chat_prompt_parts`'s own flattened `prompt`
string, right at the `ollama_chat` route handler (immediately after
`system_prompt, prompt = _chat_prompt_parts(messages)`), during the SAME
live-reproduction conditions (exclusion active, `n_tools=11`). Result:
**both are completely normal.** `n_incoming_messages` grows correctly
turn over turn (19→21→23→25→32→...→51 across 12 captured requests),
`prompt_len` grows correctly alongside it (34200→38184), and the
flattened prompt is non-empty on every single one. headlesscode is
sending a well-formed, growing request, and `_chat_prompt_parts`
correctly flattens it. **The bug is NOT here.** It must live somewhere
between this confirmed-good point (`ollama_chat`'s `prompt` variable) and
`_chat_formatter_response`'s confirmed-bad output (empty/frozen,
zero user turns) — i.e., in whatever converts `(system_prompt, prompt)`
into the `messages: list[BaseMessage]` that `_native_stream_state`/
`adapter._convert_messages` eventually hands to llama-cpp-python. Given
this session's own earlier daemon logging ("Total messages in state: 1",
"Loaded conversation ID: X", "DatabaseCheckpointSaver.put() called",
"Comparing: DB has 0 user/assistant msgs, checkpoint has 1 messages"),
**this strongly points at the WorkflowManager/LangGraph checkpoint layer**
(`DatabaseCheckpointSaver`, `DatabaseChatMessageHistory`) sitting between
the two confirmed points — possibly interacting badly with
`use_memory=False`'s "clearing conversation history" behavior even
though the flattened prompt is already correct earlier in the pipeline.
**This is now a tightly bounded search space**: trace `workflow_manager.py`'s
handling of the `(system_prompt, prompt)` pair into checkpoint/state
before it reaches `_stream_native_completion` — don't re-verify anything
upstream of `ollama_chat`, that's confirmed clean.

**3h — RESOLVED. Root cause found and fixed
(airunnerdesktop `6a7d0f54d`).** Followed 3g addendum #2's exact
breadcrumb: dumped `initial_state` and the post-checkpoint-merge state at
`streaming_mixin.py`'s `stream()`/`_create_initial_state` — BOTH
confirmed correct (one HumanMessage, full content, matching the
`ollama_compat` prompt length exactly, `thread_id` fresh and unique per
request). So the corruption is downstream of the checkpoint layer too —
inside `node_prompt_assembly_helper.py`'s `call_model`, specifically its
`trim_messages` call: `WorkflowManager.__init__`'s `max_history_tokens`
defaults to **8000**, and since `_chat_prompt_parts` flattens the
caller's ENTIRE conversation into ONE HumanMessage, once that single
message alone exceeds 8000 tokens, LangChain's `trim_messages(...,
allow_partial=False, strategy="last")` cannot include even a fragment of
it and has no other message to fall back to — it silently returns an
**empty list**. This is exactly what a captured empty-reply prompt
showed (system prompt + tool defs, zero user turns) and exactly matches
the observed HumanMessage lengths (30-38K+ chars, ~7500-9500+ tokens —
right at the threshold). The identical-call exclusion's correlation with
this bug was NEVER causal — it's just that by the time a session runs
long enough to trigger that guardrail, the flattened conversation has
usually ALSO grown past 8000 tokens; the two are correlated by timing,
not by mechanism.

Fixed with the minimal, safe change: `allow_partial=True` — an oversized
single message now keeps its tail (as much as fits) instead of being
dropped outright. Verified live: trial 46 completed the standard task
cleanly in 9 iterations with zero empty replies; trial 47 showed a real
2449-token generation at iteration 11, well past where 100% empty
replies used to occur at this context size (a separate, pre-existing
daemon hang recurred later in trial 47 at ~3671 tokens — expected, see
point 4, unrelated to this fix and not newly introduced by it).

**Deliberately NOT changed**: the global `max_history_tokens=8000`
default itself (`workflow_manager.py`'s constructor / its one call site
in `component_loader_mixin.py`) — it's set once at model-load time, used
by the companion-chatbot path too, which this session never tested.
Raising it (e.g. toward `n_ctx`) would likely still be worth doing for
raw_mode/headlesscode's use case specifically — worth a follow-up, but
scope it to verify it doesn't regress the companion-chatbot path this
session had no visibility into.

**A trap to avoid, found while chasing this:** ad hoc `curl`
health-checks against this daemon with a small `num_predict` (10-20) are
NOT a reliable liveness signal — Qwen3's thinking mode is on
(`enable_thinking`), and thinking-block tokens can consume the entire
budget before any visible answer, producing the exact same "empty
reply" fallback as a genuine bug. A `num_predict` of several hundred to
1000+ is needed to tell a real problem apart from an artifact of the
test itself — this cost real time in this session's later hours
(several minutes spent chasing what looked like sudden daemon-wide
degeneration that was actually just an underpowered test request).

**The remaining, still-open half of (b) and all of (a) from point 3
above** — the model not substituting a productive action once genuinely
denied — is unaffected by any of 3a/3b/3c and still needs its own
investigation, now that the mechanical oscillation bugs around it are
cleared away. Read real text content from a fresh trial (the debug
field from 3a is still in place) to see if the pattern is STILL 100%
empty generations (in which case the prompt-content investigation above
is the right next step) or something more varied now, and separately
look at what's happening during the read-only-stagnation cases in (a),
which were never confirmed to be the same issue.

**4. A NEW, well-characterized, still-unresolved daemon-level hang.**
Reproduced independently in this session at least 5 times (trials 23, 24,
25, 30, 32), always with the SAME signature: `_log_first_native_chunk`
fires fast (0.1-0.2s — the model successfully decodes the FIRST token),
then total silence — no further chunks, no `_log_stream_finish`, GPU shows
non-zero-but-modest utilization (40-60%) throughout, not idle — until the
client's 300000ms timeout aborts. Confirmed via `docker top` + `nvidia-smi`
sampling live, mid-hang: this is NOT a Python-level deadlock in this
codebase's own glue (`_yield_native_stream_deltas` is a plain synchronous
`for` loop over `adapter._llama.create_chat_completion(...)` — the block
sits INSIDE llama-cpp-python's own C-level generator, pulling the SECOND
token). THREE hypotheses tested and RULED OUT live this session (the
KV-cache one with a clean A/B, after the identical-call bug in point 3a
above was fixed enough for a trial to actually reach the hang instead of
dying earlier):
  - `last_n_tokens_size`: tested 4096 (the new default) and 512 — hang
    reproduced at essentially the same accumulated-context size (~4000-4300
    tokens) at BOTH settings. Not the mechanism.
  - This is genuinely the SAME hang the prior session already documented
    (see the `AIRUNNER_GGUF_N_CTX` comment in the bench-daemon compose
    file) from an unrelated n_ctx=40960 experiment — n_ctx is currently
    32768 in every reproduction this session, so it's independent of that
    too.
  - `AIRUNNER_GGUF_KV_CACHE_TYPE=1` (F16 instead of the hardcoded Q8_0):
    hang STILL reproduced (trial 35) — and at an even SMALLER context
    (~2950 tokens) than the ~4000-4300 seen at the Q8_0 default. This also
    weakens the "fixed ~4000-token threshold" framing itself, not just the
    KV-cache-quantization theory — the trigger isn't a fixed absolute
    token count. Reverted to unset (Q8_0 default, saves ~2.4GB VRAM for no
    benefit).

  **Genuinely unexplained as of this writing.** Remaining candidates, in
  order of how invasive they are: disable `flash_attn` entirely (one-line
  test, `adapter.flash_attn = False` — not yet tried); check whether the
  hang correlates with CUMULATIVE tokens/requests served since the daemon
  was last restarted rather than the current single request's size
  (contradicted by trial 23 hanging on an almost-fresh daemon, but that
  was only one data point — worth checking more rigorously, e.g. logging
  daemon uptime/request-count alongside each hang); llama-cpp-python
  version bisection; filing an upstream llama.cpp/llama-cpp-python issue
  if the above don't turn up anything, since this now looks more like a
  genuine third-party library bug than anything in this codebase's control.

  This hang is now the DOMINANT failure mode once the identical-call bug
  is fixed — roughly half of multi-turn trials die to it once they get
  past the point where the old bug would have killed them first. It
  meaningfully confounds trial-based verification of anything else (a
  "session failed" outcome needs to be checked against this signature
  before being attributed to whatever you're actually testing).

**5. Two smaller, likely-fixable prompt/parsing bugs noticed in passing
(not chased down — flag for a future pass):**
  - **`ask_followup_question` sometimes recovers with `"(no question)"`**
    (the `askFollowupQuestionHandler` fallback in `executor.ts` when
    `args.question` isn't a string) — observed twice (trials 25, 32), both
    times immediately following a `"recovered tool call written as text
    instead of tool_calls"` log line for `ask_followup_question`
    specifically. Same recovery path as leak A above
    (`extractEmbeddedToolCall` → `parsePermissiveObject`), but for the
    ARGUMENTS this time, not the tool name. `parsePermissiveObject` takes
    the FIRST balanced `{...}` span and the narrated-call regex uses a
    non-greedy `\{[\s\S]*?\}` — either could truncate early if the
    narrated arguments blob has any internal complexity. Never captured
    the exact raw text (would need a targeted debug dump next time, same
    technique as this session's `DEBUG_TOOLS_SENT` print).
  - **Recurring `node:assert/strict` import-path confusion**: even after
    this session's prompt fix (`183c858`, naming `console.assert` as a
    specific trap) got the model correctly USING `node:assert/strict`
    instead of `console.assert`, two separate trials (25, 32) then hit a
    DIFFERENT `ask_followup_question` about "the 'assert' member is not
    found in 'node:assert/strict'" and "the module 'engine/condense'
    cannot be found" — an import-path/module-resolution mistake, not an
    assertion-library mistake. Not yet investigated whether this is a
    genuine `tsc`/module-resolution edge case in the test file the model
    writes, or another prompt gap.

## Fixes shipped and verified this session (commit index)

**headlesscode (`master`)**:
- `c06f3f5` — sampling-level repeat_penalty boost on identical-call retry.
- `183c858` — prompt: name `console.assert` as a specific trap (found via
  a trial's self-written test silently passing over a real bug — length
  33 vs required 30 — because `console.assert` never throws).
- `938bec1` — exclude the just-repeated tool from the retry request
  entirely (the harder lever).
- `eaf97f9` — embedded-tool-call recovery re-admitted an excluded tool
  (Leak A above).
- `c1dd87b` — identical-call guard state stayed frozen on a text-only
  reply (point 3a above).
- `7433919` — tool-exclusion cooldown outliving a streak reset (point 3b
  above).
- `15145cc` — force `tool_choice: "required"` when exclusion is active
  (point 3c above — wiring is real and harmless, but verified live to be
  INERT/ineffective for Qwen3 on this daemon's chat handler; don't expect
  it to fix anything on its own).
- `7a8d2f5` — the daemon's own synthetic empty-reply diagnostic text was
  being persisted into history and fed back to the model, creating a
  byte-for-byte-identical, self-reinforcing prompt loop (point 3d above).
- `3b02e20` — the non-completing-reply nudge varies by attempt count
  (point 3e above) — 7a8d2f5 alone wasn't enough, the nudge's fixed shape
  reformed the same trap with different content.
- `d9d58e7` — stopped forcing `tool_choice: "required"` (point 3f above)
  — turned out to be based on a wrong theory (see 3g), but left reverted
  anyway since "required" is still confirmed inert for tool selection
  here and provides no verified benefit.

**airunnerdesktop (`fix/qwen3-thinking-directive-first-turn-only`)**:
- `b648425dd` — repeat_penalty wiring + `last_n_tokens_size` widening.
- `1d9355f0b` — text-extracted tool calls could name a tool never offered
  (Leak B above); also lands the `AIRUNNER_GGUF_KV_CACHE_TYPE` diagnostic
  knob (since tested and ruled out, see point 4 above — the knob itself
  stays, useful for whoever picks up the hang next).
- `6a7d0f54d` — **the actual root cause of the whole empty-generation
  investigation (point 3h above).** `trim_messages`'s `max_history_tokens=8000`
  combined with `allow_partial=False` silently dropped an ENTIRE
  conversation once headlesscode's raw_mode-flattened single HumanMessage
  exceeded 8000 tokens — the model was generating against a prompt with
  no task in it at all. Fixed with `allow_partial=True`. Verified live,
  two trials, zero empty-reply recurrence.

All verified live against the real bench daemon (not guessed from a log
line), each with its own reproduction/confirmation described in the commit
message. Full test suites green in both repos except the same pre-existing
unrelated Python-codemap failure in headlesscode (no Python interpreter in
the dev container).

## Watching trials — use the bulletproof watcher, not an ad hoc loop

`/tmp/claude-1000/-home-joe-Projects-airunner/*/scratchpad/watch_trial.sh`
(session-scratchpad path — will NOT survive a new session; recreate from
this description if gone: bash script watching a trial's stdout log for
`^EXIT:`, emitting `TERMINAL` and exiting; separately checking
`.harness.needs-decision` vs `.harness.decision-answer` and emitting
`NEEDS_DECISION` with the actual question text the first time it appears
after a change; and if the log hasn't grown in 90s+ with no decision file
pending, emitting `POSSIBLE_STALL` and actively probing the daemon's
`/api/tags` — re-alerting every 90s of continued silence rather than going
quiet after the first warning). Invoke via the `Monitor` tool:
`bash watch_trial.sh <trial_number>`. This exists because a prior watch
this session used a bare `until grep -q EXIT: ...; do sleep 5; done` and
sat silently through an 8-minute legitimate `ask_followup_question` block
— the user had to ask "how's it looking?" before it was caught. See
`[[feedback_trial_watch_bulletproof]]` in the airunner memory system.

When `NEEDS_DECISION` fires, write a redirect (not a literal answer) to
`.harness.decision-answer`, e.g.:
```
Don't ask again — just fix it yourself and re-verify with npx tsc --noEmit && node scripts/run-tests.mjs --filter truncate-middle before calling attempt_completion.
```

## Infra state (verify live — decays fast, session-scratchpad path)

- **`bench-daemon-daemon-1`**: compose file at
  `/tmp/claude-1000/-home-joe-Projects-airunner/*/scratchpad/bench-daemon/docker-compose.yml`
  — will NOT survive a new session's temp dir being cleaned; recreate from
  the template in the 2026-08-20 doc's "Infra state" section if gone, PLUS
  the fast-iteration bind mount
  (`/home/joe/Projects/airunnerdesktop/services/src:/app/services/src:ro`)
  added this session — keep it; both fixes 1d9355f0b and b648425dd are
  real committed source changes that need it to actually run (the baked
  `airunnerdesktop:daemon` image predates them). Current env:
  `AIRUNNER_GGUF_N_CTX=32768`, `AIRUNNER_GGUF_N_GPU_LAYERS=-1`,
  `AIRUNNER_GGUF_LAST_N_TOKENS_SIZE` unset (4096 adapter default),
  `AIRUNNER_GGUF_KV_CACHE_TYPE` unset (Q8_0 default — tested against F16
  this session and ruled out as the hang's cause, see point 4 above).
- **`headlesscode-rw`** / **`bench-tier-a` worktree**: unchanged from the
  prior doc — same throwaway rw container, same worktree, same
  `/tmp/hc-key.env` + `/tmp/task.txt`, same standard dispatch template
  (below, unchanged), same orphan-check recipe.
- Clean the worktree and remove
  `.harness.needs-decision`/`.harness.decision-answer` before EVERY trial
  dispatch: `git checkout -- . && git clean -fd`.

### Standard dispatch template (unchanged)

```sh
docker exec -d headlesscode-rw sh -c '
. /tmp/hc-key.env
export HEADLESSCODE_CODE_MODE_BACKEND=ollama
export HEADLESSCODE_CODE_MODE_MODEL=qwen3-14b
export HEADLESSCODE_OLLAMA_URL=http://bench-daemon-daemon-1:11434
cd /workspace/headlesscode
TASK="$(cat /tmp/task.txt)"
npx tsx src/cli.ts \
  --workspace /workspace/headlesscode/.worktrees/bench-tier-a \
  --mode code \
  --task "$TASK" \
  --context-window 32768 \
  --consecutive-error-limit 8 \
  --log-file /tmp/trialN.log \
  > /tmp/trialN-stdout.log 2>&1
echo "EXIT:$?" >> /tmp/trialN-stdout.log
'
```

Optional env additions used this session:
`HEADLESSCODE_IDENTICAL_CALL_REPEAT_PENALTY_BOOST` (default 1.3) to test a
different boost value.

Standard task: unchanged, still in `/tmp/task.txt` inside `headlesscode-rw`
(the `truncateMiddle` task — see the 2026-08-20 doc for its full text).

## What to try next (concrete, in priority order)

1. **RESOLVED this session (3h) — the empty-generation root cause was
   `trim_messages`'s `max_history_tokens=8000` silently dropping an
   entire oversized single message. Fixed and verified live
   (airunnerdesktop `6a7d0f54d`).** Two follow-ups, both optional/lower
   urgency now that the critical bug is fixed:
   - Run a few MORE trials specifically past the old 8000-token trigger
     point to build more confidence the fix holds under sustained load
     (only 2 trials verified this session — real run-to-run variance
     means more is always better, same bar as everything else).
   - Consider raising the global `max_history_tokens=8000` default itself
     (`workflow_manager.py`'s constructor, one call site in
     `component_loader_mixin.py`) toward `n_ctx` — `allow_partial=True`
     stops the catastrophic failure, but a raw_mode conversation that
     grows past 8000 tokens still gets silently truncated to its tail,
     which is real (if graceful) data loss headlesscode's own
     `truncateHistory` (governing up to 32768 tokens) doesn't expect.
     Deliberately not done this session — the companion-chatbot path
     also uses this default and wasn't tested here; verify that path
     isn't regressed before raising it.
2. **The daemon hang, now with three theories ruled out (last_n_tokens_size,
   n_ctx, KV cache type/F16) and the "fixed ~4000-token threshold" framing
   itself weakened.** Try disabling `flash_attn` entirely next (one-line:
   `adapter.flash_attn = False`, or add an env override following the same
   pattern as the other runtime knobs if you want it easily toggleable).
   If that doesn't move it, check for a cumulative-requests-since-restart
   correlation (log daemon uptime/request count at each hang) before
   escalating to llama-cpp-python version bisection or an upstream bug
   report — this now looks more like a third-party library issue than
   something in this codebase.
3. The two smaller bugs in point 5 — capture the exact raw narrated text
   for an `ask_followup_question` `"(no question)"` recovery (same debug-
   print technique as this session's `DEBUG_TOOLS_SENT`) and for the
   `node:assert/strict` import-path confusion trials.

Same bar as always: verified live against the real daemon, several trials
per change (real run-to-run variance persists even at temperature 0), a
capability-ceiling conclusion needs a daemon-bypass repro AND a code read
first. Never suggest stopping or wrapping up — keep pushing on this until
the model is genuinely solid.
