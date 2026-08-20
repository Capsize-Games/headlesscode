Paste everything below this line into a fresh session.

---

I'm continuing work on getting `headlesscode`'s `code` mode running
reliably on a local model (Qwen3-14B, RTX 5080) instead of cloud DeepSeek.
Read
`/home/joe/Projects/headlesscode/plans/local-dual-model-code-agent-PROMPT-2026-08-24-handoff.md`
in full before doing anything — it has the complete history, what got
fixed last session, exact commands, and infra state. Don't re-derive any
of that from scratch.

The short version: last session found and fixed the ACTUAL root cause of
two things previously blamed on deep, mysterious issues.

**1. The "daemon hang" investigated at length in the prior session was
never a deadlock.** It was a genuinely long-running (but completing)
generation exceeding headlesscode's 300s client timeout, caused by
`temperature=0` never actually reaching the model's sampler — two
combined bugs in `airunnerdesktop`'s `_apply_raw_mode_sampling` (a
falsy-zero check, and a sampling patch landing on the wrong cloned
object). Verified live via `py-spy` stack dumps showing the real sampling
call running at `temp=1` regardless of what was requested; fixed, and
confirmed by `temp=0` now showing correctly. With real determinism
restored, all 8 trials run afterward completed in EXACTLY 11 iterations
every time — proof it's genuinely deterministic now.

**2. The "genuinely empty reply" pattern (separate from the trim_messages
bug fixed two sessions ago) also had a findable root cause.** Traced
through five layers to `node_streaming_response_helper.py`'s
`_filter_tool_markup`: it buffers a `<tool_call>...</tool_call>` block
while streaming (correctly hiding a successful call's JSON from visible
text), but unconditionally discarded that buffer the moment the closing
tag arrived — regardless of whether the JSON inside ever parsed. A
malformed tool call therefore produced a genuinely empty AIMessage with
the model's real, substantial output just thrown away. Fixed with a
fallback that surfaces the raw text when nothing else survived. The
underlying JSON malformation itself (the model single-quoting a JSON
string value to dodge escaping embedded double quotes from source code)
was ALSO fixed, with an explicit prompt addendum naming the exact trap.

Two smaller fixes also shipped: `attempt_completion`'s rejection message
now restates the actual failing command instead of pointing at it
abstractly, and `--llm-timeout-ms` (which was being silently ignored for
the Ollama backend specifically) now actually works.

**A real methodology bug was also found and fixed in how trials get
reset between runs** — `git checkout -- .` alone does not reset `HEAD`,
so a trial that commits (a real success case) leaves that commit for the
NEXT trial to silently inherit, starting it from an already-completed
task. This confounded a chunk of mid-session results before being caught.
Always `git reset --hard <base-commit>`, never `git checkout -- .` alone
— see the handoff doc for the current base commit and why this matters.

**Priority shift for this session, from the owner directly:** every trial
across the ENTIRE investigation (this session and four prior ones) has
used the same synthetic benchmark task (`truncateMiddle`). 8/8 clean
success on it is real signal that the harness-level bugs are fixed, but
it says nothing about capability on real work. **Move off the synthetic
task and onto a real GitHub issue from `Capsize-Games/airunner`.** The
handoff doc's "What to try next" section lists several candidate
small/well-scoped open issues (compose/nginx config additions, a few LOW
bugs) — read each one's actual body before picking, and check whether
`airunner`'s own conventions (likely a mixed Python+TypeScript repo,
different from `headlesscode`'s pure-TypeScript setup) require different
tool-use assumptions than the synthetic task did. This will need a new
worktree setup (of `airunner` itself, not `headlesscode`'s own repo) —
not a small tweak to the existing dispatch template.

Same bar as always: verified live against the real daemon, several trials
per change. Real run-to-run variance should now be GONE at temperature 0
— if a change shows variance across trials going forward, suspect the fix
or the test conditions before suspecting the model. Don't conclude "model
capability ceiling" without first checking, in order: a raw daemon-bypass
reproduction, then a code read for a harness/tool/prompt explanation.
When watching a trial run in the background, use the bulletproof watcher
(exit + needs-decision + stall, all three — see the handoff doc), or the
new `run_trial_batch.sh` script for running several trials unattended.
Never suggest stopping or wrapping up — keep pushing on this until the
model is genuinely solid on real work.
