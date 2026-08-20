Paste everything below this line into a fresh session.

---

I'm continuing work on getting `headlesscode`'s `code` mode running reliably
on a local model (Qwen3-14B, RTX 5080) instead of cloud DeepSeek. Read
`/home/joe/Projects/headlesscode/plans/local-dual-model-code-agent-PROMPT-2026-08-22-handoff.md`
in full before doing anything — it has the complete history, the eleven
fixes shipped in the last session, exact commands, and infra state. Don't
re-derive any of that from scratch.

The short version: I don't believe we've hit a real model capability
ceiling. Every time a trial failure looked like "the model can't do X,"
digging in found a real harness/prompt/tool bug underneath — eleven of them
got fixed and verified last session. The one thing still unresolved: once
the model starts repeating the same tool call (`list_files "."`, mainly)
back-to-back, even a specific, correct, on-topic corrective nudge in the
conversation doesn't reliably break it. That's a narrower and different
claim than "can't plan" or "can't follow conventions" — both of those got
fixed and stayed fixed. This might be a real limit on responding to
injected context mid-repetition, not on capability generally.

Next concrete thing to try, not yet attempted: a sampling-level
intervention instead of another prompt-level one. Two candidates:

1. Raise `repeat_penalty` (or equivalent) specifically once the harness's
   own identical-call guard detects a repeat, instead of just injecting
   text. Check what `airunnerdesktop`'s GGUF adapter currently sends for
   this param and whether it's configurable per-request.
2. Force `tool_choice` to exclude the just-repeated tool on the retry
   request, if the wire format supports excluding rather than only
   requiring a specific tool.

Try one of those, or something better if you find it. Then keep running
trials against the standard task (in the handoff doc) — several per
change, not just one, there's real run-to-run variance even at
temperature 0. Keep committing real fixes as you find them, same bar as
last session: verified live against the real daemon, not guessed from a
log line. Don't conclude "model capability ceiling" without first
checking, in order: a raw daemon-bypass reproduction, then a code read for
a harness/tool/prompt explanation. Never suggest stopping or wrapping up —
keep pushing on this until the model is genuinely solid.
