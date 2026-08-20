Paste everything below this line into a fresh session.

---

I'm continuing work on getting `headlesscode`'s `code` mode running reliably
on a local model (Qwen3-14B, RTX 5080) instead of cloud DeepSeek. Read
`/home/joe/Projects/headlesscode/plans/local-dual-model-code-agent-PROMPT-2026-08-23-handoff.md`
in full before doing anything — it has the complete history, what got fixed
last session, exact commands, and infra state. Don't re-derive any of that
from scratch.

The short version: two separate, previously-mysterious problems both got
resolved last session.

**1. The identical-call bug (repeating one tool call, immune to corrective
nudges) is genuinely fixed.** Took eight separate sub-fixes to get there,
each caught live by a NEW failure mode appearing once the previous one was
closed — two leaks that let the model narrate its way past an "excluded"
tool, a guard-state freeze, a one-shot-exclusion oscillation bug, and a
self-reinforcing history-poisoning loop where the daemon's own synthetic
error text was fed back to the model as if it had said it. All verified
live, fully documented in the handoff doc if you need the blow-by-blow.

**2. The "model sometimes produces a genuinely empty reply" mystery — which
looked like it might be a deep, unrelated sampling issue — turned out to
have a single, findable root cause, and it's fixed.** Traced the request
pipeline end to end with live instrumentation at every layer (the incoming
request, the flattened prompt string, the LangGraph initial state, the
post-checkpoint-merge state — all confirmed correct) until finding it:
`WorkflowManager`'s `max_history_tokens` defaults to 8000, and since every
Ollama-compat raw_mode request (everything headlesscode sends) gets
flattened into ONE single HumanMessage, once that one message alone
exceeds 8000 tokens, LangChain's `trim_messages(allow_partial=False)`
can't include even a fragment of it and silently returns an EMPTY list —
the model was generating against a prompt with no actual task in it at
all. Fixed with `allow_partial=True` (airunnerdesktop). Verified live
across two trials, zero recurrence at context sizes that previously
produced 100% empty replies.

What's left, in priority order (see the handoff doc's "what to try next"
for full detail):

1. Run a few more trials past the old 8000-token trigger point to build
   confidence the fix holds under sustained load (only verified twice so
   far). Separately, consider raising the global `max_history_tokens=8000`
   default itself toward `n_ctx` — `allow_partial=True` stops catastrophic
   failure, but a long raw_mode conversation still gets silently truncated
   to its tail at 8000 tokens. Deliberately not raised last session since
   the companion-chatbot path also uses this constant and wasn't tested —
   verify that path isn't regressed first.
2. A separate, well-characterized daemon-level generation hang (first
   token decodes fast, then the underlying llama.cpp generator's next
   token pull blocks forever) reproduces once a session's accumulated
   context gets into the low thousands of tokens — confirmed unrelated to
   fix #2 above (recurred at ~3671 tokens, well below the 8000 trigger).
   THREE theories already ruled out live: n_ctx, last_n_tokens_size, KV
   cache quantization (F16 vs Q8_0). Next candidates: disable `flash_attn`
   entirely, or check for a cumulative-requests-since-daemon-restart
   correlation. This is starting to look like a genuine third-party
   llama.cpp/llama-cpp-python bug.
3. Two smaller bugs noticed in passing, not yet chased down: an
   `ask_followup_question` recovery path that sometimes loses the actual
   question text, and a recurring test-writing pattern where the model
   defaults to Jest/Mocha syntax (and once even tried installing
   `@types/mocha`, violating an explicit "don't touch other files"
   instruction) despite this codebase's plain-assert convention.

Keep running several trials per change, not just one — there's real
run-to-run variance even at temperature 0. Keep committing real fixes as
you find them, same bar as every session so far: verified live against
the real daemon, not guessed from a log line. Don't conclude "model
capability ceiling" without first checking, in order: a raw daemon-bypass
reproduction, then a code read for a harness/tool/prompt explanation.
When watching a trial run in the background, use the bulletproof watcher
(exit + needs-decision + stall, all three — see the handoff doc) so a
legitimate follow-up question doesn't get mistaken for silence. Never
suggest stopping or wrapping up — keep pushing on this until the model is
genuinely solid.
