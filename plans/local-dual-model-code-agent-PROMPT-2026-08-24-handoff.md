# Handoff — local dual-model code agent, 2026-08-20 session (continuing 08-19/08-20/08-21/08-22/08-23)

Reference doc for `local-dual-model-code-agent-PROMPT-2026-08-24.md`. Read
`local-dual-model-code-agent-PROMPT-2026-08-23-handoff.md` FIRST — this doc
only covers what changed since it. Short version of that prior doc: the
identical-call bug and the "genuinely empty reply" mystery were both fixed
last session, but the empty-reply fix (`allow_partial=True` on
`trim_messages`) turned out to be necessary but NOT the full story — this
session found the rest of it.

## The owner's framing (verbatim, carried forward, now with a new directive)

> i don't believe we've hit model capability ceilings yet at all... write a
> prompt to investigate this and continue running trials and pushing this
> model's capabilities. we want to keep refining, keep improving, keep
> tweaking our implementation until this model is solid

New this session, after the standard benchmark task went 8/8 clean:

> do we have this working on real tasks from the github issue list? yes
> let's continue, but let's pass it to a clean session

**This is the priority shift for the next session.** Every trial across
this ENTIRE investigation (this session and all four prior ones) has used
the exact same synthetic task (`truncateMiddle` — see "Standard dispatch
template" below). 8/8 clean success on that one task is real, verified
signal that the harness-level bugs are fixed — but it says nothing about
capability on a real, more varied task. The next session's job is to run
this same rigor against a REAL GitHub issue from `Capsize-Games/airunner`
(candidates below), not to keep re-running the synthetic task.

## What this session found (in the order it happened)

**1. Repaired broken trial infrastructure before anything else.** The
`bench-tier-a` worktree's `.git` file pointed at a HOST-absolute path
(`/home/joe/Projects/headlesscode/.git/worktrees/bench-tier-a`) that
doesn't exist inside the `headlesscode-rw` container's mount namespace (it
only has `/workspace/headlesscode`) — this must have been recreated from
the HOST at some point, breaking every in-container git operation
("fatal: not a git repository"). Fixed by removing and re-adding the
worktree FROM INSIDE the container (`git config --global --add
safe.directory` was also needed for the dubious-ownership check). Separately,
`bench/tier-a` was 22 commits behind `master` (it had never been
fast-forwarded since creation) — every fix from the entire prior
investigation (tool exclusion, cooldown, the history-poisoning fix,
everything) was silently absent from every trial workspace. Fixed with
`git reset --hard master` from inside the worktree.

**2. A SECOND, much worse instance of the same class of methodology bug,
found much later in the session (see item 7) and IMPORTANT for the next
session to internalize:** the standard "clean the worktree" step used all
session was `git checkout -- . && git clean -fd` — this resets the
WORKING TREE but does NOT reset `HEAD`. A trial that commits (a real
`attempt_completion` success, which does `git add` + `git commit` as part
of verification) leaves that commit sitting on the branch for the NEXT
trial, which silently starts from an ALREADY-COMPLETED task instead of the
intended baseline. This happened twice this session — trial 53 committed,
then trials 54–70 (16 trials!) ran against a worktree where the task was
already done, and later trial 71's apparent "success" turned out to be the
model just re-confirming pre-existing code needed no changes. **Always use
`git reset --hard <base-commit>` before every trial, never `git checkout
-- .` alone** — the base commit for `bench/tier-a` is currently
`d9d58e7` (headlesscode) after this session's own fixes landed on top of
it; check `git log --oneline -1` after resetting matches expectation
before dispatching. `run_trial_batch.sh` (see below) now does this
correctly; any manual dispatch must too.

**3. The "daemon hang" from the prior session's investigation — RESOLVED,
and it was never a deadlock.** The prior session ruled out
`last_n_tokens_size`, `n_ctx`, and KV-cache type (F16 vs Q8_0) live, and
was about to escalate to `llama-cpp-python` version bisection. This
session installed `py-spy` in the bench-daemon container (needs
`cap_add: [SYS_PTRACE]` in the compose file — added, see "Infra state"
below) and dumped the ACTUAL native stack mid-"hang": the generation
thread was genuinely, continuously active inside `llama_cpp/_internals.py`'s
`sample()` call — `returned_tokens` climbed steadily across two dumps 15s
apart (5033→6712, ~112 tok/s). **It was not stuck. It was a real,
legitimate generation that just took longer than headlesscode's 300s
client timeout** — one observed case took 483 seconds and 15,236 tokens
(hit its max_tokens ceiling exactly, a clean finish) because decode speed
measurably slows as context grows (80 tok/s early, ~29 tok/s later in the
same generation).

**3a. Root cause of WHY generations ran unnecessarily long: temperature=0
was never actually being honored, for the whole investigation's
duration.** Confirmed via py-spy showing the real `sample()` call running
at `temp=1` regardless of what was requested. Two combined bugs in
`generation_execution_support.py`'s `_apply_raw_mode_sampling`
(airunnerdesktop):
  - `request_values.get(attr) or default` treated an explicit `0` as "not
    provided" (Python: `0` is falsy) and silently substituted the
    raw-mode default (0.7) instead.
  - The real one, and why fixing the falsy-zero bug ALONE had zero
    effect when tested: the function patched `owner._chat_model`
    (`LLMModelManager`'s own reference, never reassigned after model
    load), but `bind_client_tools()` — called on every request carrying
    client tool schemas, i.e. EVERY headlesscode/raw_mode request —
    reassigns `WorkflowManager._chat_model` to a FRESH clone built from
    `_original_chat_model` before generation ever runs
    (`tool_management_mixin.py`). The sampling patch was landing on an
    object generation never reads. Fixed by reading
    `owner._workflow_manager._chat_model` instead, falling back to
    `owner._chat_model` only if that's unavailable.

Fixed: airunnerdesktop `11173504c`. Verified live via py-spy, before and
after — `temp=0, repeat_penalty=1.15` now shown correctly in the actual
sampling call. **Behavioral effect, also verified live: with real
determinism restored, all 8 clean trials this session (see item 8)
completed in EXACTLY 11 iterations, every single time** — proof the
model's behavior at temperature=0 is now genuinely reproducible. This also
retroactively explains the "real run-to-run variance even at temperature
0" that was an ACCEPTED, UNQUESTIONED premise repeated across every prior
session's handoff doc — it was this bug the whole time.

**3b. `flash_attn=False` tested and RULED OUT as a hang fix (before the
real root cause above was found) — hard negative result, don't retry.**
Added an `AIRUNNER_GGUF_FLASH_ATTN` diagnostic env knob
(airunnerdesktop `790c73380`, same pattern as the existing
`AIRUNNER_GGUF_KV_CACHE_TYPE`/`AIRUNNER_GGUF_OFFLOAD_KQV` knobs) and
tested it. Result: `llama_context` creation fails OUTRIGHT at every
`n_ctx` fallback level (32768→16384→8192→4096, all failed) — llama.cpp
requires `flash_attn` when the KV cache is quantized (this daemon
hardcodes Q8_0 for `type_k`/`type_v`), so disabling flash_attn while
keeping Q8_0 is an invalid combination, not a real A/B test. The knob is
kept (harmless when unset) for whoever eventually pairs it with
`AIRUNNER_GGUF_KV_CACHE_TYPE=1` (F16) instead — F16 alone was already
tested in the prior session and did NOT fix the hang, so that combination
is a low-priority lead. Same commit also fixed `_runtime_signature`'s
`flash_attn` log field, which read `self.flash_attn` (the stale adapter
default) directly instead of the resolved tuning dict, unlike every other
overridable field there — the log line was silently misreporting this
knob's actual effect during testing.

**4. A separate, well-characterized "empty reply" pattern remained AFTER
the temperature fix — traced through five layers to its real root
cause.** With determinism restored, `read_file` getting excluded
(identical-call cooldown) still reliably produced a genuinely empty
`AIMessage` (no content, no tool_calls) on the next several turns, even
though the model was producing real, substantial (1248-char) output each
time. The chase, in order:
  - `_parse_xml_tool_call_match` (`chat_gguf_tool_parsing_mixin.py`)
    logged `Failed to parse tool call JSON: Expecting value: line 1 column
    90` — the model's tool-call JSON was malformed (see item 6 below for
    why).
  - First fix attempt: `_strip_xml_tool_calls` ran unconditionally,
    erasing the `<tool_call>...</tool_call>` text from the visible
    content regardless of whether it parsed — fixed (airunnerdesktop
    `ea81fa8c4`) to only strip when something inside actually parsed,
    matching the sibling `_strip_function_tag_tool_calls` call two lines
    below which already did this correctly. **This fix alone did NOT
    resolve the symptom** — verified live via a debug print showing
    `message.content` was STILL `len=0` after this fix, because...
  - ...`_resolve_stream_tool_calls` (`chat_gguf_streaming_native_chunks.py`)
    discards the `cleaned` text entirely (`raw_calls, _ =
    adapter._extract_tool_calls(full_text)`) — it only extracts
    `tool_calls` there, never touches visible content. The actual
    disconnect was two files away, in the PER-CHUNK streaming callback,
    not the post-stream tool-call resolver.
  - Root cause, found via a `py-spy`-style approach — direct debug
    instrumentation at three narrowing layers (per-message content in
    `_stream_messages`, then per-delta `raw_text` inside `_content_chunk`,
    confirming individual deltas DID carry real text like `'<tool_call>'`,
    `'{"'`, etc.) — landed on
    `node_streaming_response_helper.py`'s `_filter_tool_markup`: once a
    streamed delta contains `<tool_call>`, everything until the matching
    `</tool_call>` gets buffered into `state.tool_call_tag_buffer`
    (correctly hiding a SUCCESSFUL tool call's JSON from visible text
    while streaming) — but the moment the closing tag arrives, that
    buffer is unconditionally discarded (`state.tool_call_tag_buffer =
    []`), regardless of whether the JSON inside it ever parsed. Whether it
    parses is only decided much later (`_resolve_stream_tool_calls`,
    after the whole stream ends) — this per-chunk callback can't know yet,
    so it was throwing away the model's entire response with nothing to
    show for it.

Fixed (airunnerdesktop `67510cbfd`, two files): added
`StreamingState.last_tool_call_raw_text`, populated with the reconstructed
`<tool_call>...</tool_call>` text right before the scratch buffer is
cleared; `generate_streaming_response` now falls back to it ONLY when
NOTHING else survived (no streamed text, no resolved tool calls from
either `collected_tool_calls` or the last chunk's own `tool_calls`) — a
successful tool call is completely unaffected, since `collected_tool_calls`
is non-empty in that case.

Verified live: the failure signature changed from `hadText:false,
textPreview:""` (every single occurrence, for the whole investigation) to
`hadText:true, textPreview:"<tool_call>\n{\"name\": \"edit_file\", ..."` —
the raw text genuinely reaches headlesscode now instead of vanishing.

**5. Also found and fixed the SAME `<tool_call>` streaming issue happens
right at the very start of a prompt-ends-on-tool-result turn — kept a
pre-existing uncommitted fix from earlier in the day (not authored this
session, found already sitting in the working tree at session start).**
`legacy_ollama_compat.py`'s `_chat_prompt_parts` now appends an explicit
"[Continue the task above...]" nudge whenever the flattened prompt's last
rendered turn is a `tool` result — its own comment claims verification
against Qwen3-14B and gpt-oss-20b earlier the same day. Committed this
session (airunnerdesktop `dcf0908f3`) since it was confirmed active and
exercised across every trial tonight with no adverse effect, and leaving
it uncommitted risked losing it.

**6. The JSON malformation itself — root cause found and fixed via prompt
guidance.** The actual broken JSON in item 4: `"old_string": 'export const
CONDENSE_SYSTEM_PROMPT = ...'` — a SINGLE-quoted JSON string value. JSON
has no single-quote string syntax at all; this is unconditionally invalid.
Mechanism: the text the model needed to copy verbatim into `old_string`
(a real TypeScript source line) was itself full of double-quoted string
literals — rather than keep the outer JSON value double-quoted and escape
each embedded `"` as `\"`, the model dodged the escaping by switching the
OUTER wrapper to single quotes (correctly escaping only the occasional
internal apostrophe as `\'`, showing awareness of SOME escaping need, just
the wrong strategy). This produced BYTE-IDENTICAL broken JSON on every
retry — the model never recognized single-quoting as the actual defect,
even once it could see its own prior (now-visible, thanks to fix #4)
output. Fixed with an explicit prompt addendum (headlesscode `970caaf`,
`prompt.ts`'s `jsonEscapingNote`) naming the exact trap: never switch
quote style to avoid escaping, always double-quote + `\"`-escape.
Bundled in the same commit: a second addendum (`testStructureNote`)
promoting the existing "don't default to Jest describe/it" guidance from a
passing "e.g." mention (which live trials kept ignoring, every time) to
its own explicit rule — same "soft example isn't enough, name the exact
pattern" lesson as the console.assert fix from two sessions ago.

**7. Also fixed: `attempt_completion` rejection had nothing concrete for
the model to act on.** Separately noticed while chasing item 4: when
`verifyBeforeCompletion`'s guardrail rejects `attempt_completion` because
the last `execute_command` failed, the rejection message only said "fix
the issue, re-run the relevant check" — completely abstract. By the time a
model reaches this point, `truncateHistory`/condensation has often already
evicted the actual error text from context, so it has nothing concrete to
act on. Live symptom: the model settled into an alternating loop of
re-issuing the IDENTICAL fabricated `attempt_completion` claim and
genuinely empty replies, 8 times, never once trying a real corrective
action. Fixed (headlesscode `ab381a3`): the loop now tracks the last
failing `execute_command`'s command string + a 500-char slice of its
output (`lastExecuteCommandSummary`), and restates both in the rejection
message.

**8. `--llm-timeout-ms` was silently ignored for the Ollama backend —
found while trying to validate item 3's "it's not a hang, it just takes
longer" finding by giving trials a longer budget.** `OllamaClient` has
its OWN independent abort timer (`DEFAULT_OLLAMA_TIMEOUT_MS`), completely
separate from `loop.ts`'s `llmTimeoutMs`-driven `AbortController`s — the
`new OllamaClient({...})` construction in `cli.ts` never forwarded the CLI
option. A trial dispatched with `--llm-timeout-ms 900000` still aborted at
exactly 300000ms. Fixed (headlesscode `13f1a9f`).

**9. A real, separate git-operations gotcha, distinct from item 2, hit
mid-session:** the `docker exec headlesscode-rw` container runs as root,
and its bind-mounted `/workspace/headlesscode` (owned by the host user)
trips git's dubious-ownership check on first use after a container
recreate — `fatal: detected dubious ownership in repository`. Fixed once
with `git config --global --add safe.directory /workspace/headlesscode`
inside the container; this setting does NOT survive a container recreate,
so it may need re-running if `headlesscode-rw` itself ever gets rebuilt
(it did not need re-running this session after the one initial fix, since
that container was never recreated — only `bench-daemon-daemon-1` was
recreated repeatedly, and that's a different container).

## Fixes shipped and verified this session (commit index)

**headlesscode (`master`)**:
- `ab381a3` — `attempt_completion` rejection restates the actual failing
  command + a slice of its output (item 7 above).
- `13f1a9f` — `--llm-timeout-ms` wired through to `OllamaClient`, was
  silently ignored before (item 8 above).
- `970caaf` — two prompt addenda: test-structure (describe/it trap,
  promoted from a passing mention) and tool-call JSON escaping (the
  single-quote trap, item 6 above).

**airunnerdesktop (`fix/qwen3-thinking-directive-first-turn-only`)**:
- `11173504c` — **the actual root cause of the "daemon hang."**
  Raw-mode sampling overrides (temperature, top_p, top_k, repeat_penalty)
  were being patched onto the wrong object AND had a falsy-zero bug on
  top — temperature=0 was never honored for the whole investigation.
  Item 3a above.
- `ea81fa8c4` — don't strip a `<tool_call>` block that failed to parse
  (necessary but not sufficient on its own — item 4 above).
- `67510cbfd` — **the actual root cause of the "empty reply" pattern.**
  Fall back to the raw `<tool_call>` text when nothing else survived
  streaming. Item 4 above.
- `790c73380` — `AIRUNNER_GGUF_FLASH_ATTN` diagnostic knob (tested,
  ruled out — item 3b above) + fixed its own stale log line.
- `dcf0908f3` — tool-result continuation nudge (item 5 above, kept from
  an earlier uncommitted sub-session, not authored this session).

All verified live against the real bench daemon. Full headlesscode test
suite green except the same pre-existing, unrelated Python-codemap
failure documented in every prior handoff (no Python interpreter in the
`headlesscode-rw` dev container — confirmed still true this session,
`which python3` exits 1).

**Deliberately NOT done this session, still open:**
- Two smaller bugs from two sessions ago, never actually chased down
  despite being carried forward in every handoff since: an
  `ask_followup_question` recovery path that sometimes loses the actual
  question text (`"(no question)"` fallback), and a `node:assert/strict`
  IMPORT-PATH confusion (distinct from the assertion-library confusion
  already fixed) — "the 'assert' member is not found in
  'node:assert/strict'" / "the module 'engine/condense' cannot be found."
  Neither reproduced this session (may be rarer, or may simply not have
  come up against the one synthetic task) — worth a targeted look if
  either shows up again against a real task.
- Raising the global `max_history_tokens=8000` default itself
  (`workflow_manager.py`'s constructor) toward `n_ctx` — still not done,
  still needs the companion-chatbot path verified first (still untested
  by anyone in this investigation).
- `llama-cpp-python` version bisection (0.3.21 installed vs. 0.3.35
  latest) — this was being considered as the next hang-investigation step
  before the real root cause (item 3a) was found instead. Checked the
  changelog between the two versions via `gh api compare` and found
  nothing relevant to this daemon's actual code path (the one plausible
  "streaming" fix touches the library's bundled example server, which
  this codebase doesn't use) — **not a live lead anymore now that the
  hang has a confirmed different root cause.** Don't rebuild the CUDA
  wheel for this; if it resurfaces, get concrete evidence (a `py-spy`
  dump showing a genuinely non-advancing native stack, not just a slow
  one) before considering it again.

## A methodology note for the next session, learned the hard way

Batch-running trials without careful attention to WHAT'S BEING RESET
produces misleading results. This session's first "confirmation" batch
(trials 60-65, run before item 2's discovery) showed 0/6 success and
looked alarming — it was actually confounded by both the temperature bug
AND the stale-commit bug at once. After both were fixed and the reset
methodology corrected, the SAME task went 8/8 with identical iteration
counts. When results look bad, verify the test conditions are actually
clean (worktree reset to the RIGHT commit, container actually restarted
if code changed) before trusting the outcome.

## Watching trials — use the bulletproof watcher, not an ad hoc loop

Same tool as every prior session:
`/tmp/claude-1000/-home-joe-Projects-airunner/*/scratchpad/watch_trial.sh`
— session-scratchpad path, will NOT survive a new session; recreate from
the description in the 2026-08-23 handoff doc if gone (bash script
watching stdout for `^EXIT:`, checking `.harness.needs-decision` vs
`.harness.decision-answer`, and stall-probing the daemon's `/api/tags` on
90s+ silence). Invoke via the `Monitor` tool:
`bash watch_trial.sh <trial_number>`.

**New this session: `run_trial_batch.sh`** (same scratchpad directory) —
automates the mechanical loop (clean worktree via `git reset --hard
$BASE_COMMIT`, dispatch, auto-answer the recurring mocha/jest question,
classify outcome as SUCCESS/LLM_TIMEOUT/EMPTY_REPLY_LIMIT/
UNKNOWN_FAILURE, restart the daemon after any timeout to cancel the
orphaned server-side generation before the next trial). Usage:
`bash run_trial_batch.sh <start_trial_num> <count>`, writes to
`batch_results.log` in the same directory. Uses a 60s per-request
`--llm-timeout-ms` for fast fail/pass signal — this is DELIBERATELY
harsh and will kill some trials that would have eventually succeeded at a
longer timeout (see item 3: a legitimate generation can take 8+ minutes).
Only auto-answers the ONE known recurring question (mocha/jest); any
OTHER `ask_followup_question` is left blocked and flagged
`UNHANDLED_DECISION` for manual follow-up — do not extend the
auto-answer list without being confident the answer is actually safe/
correct for every case it might match.

**Only ask_followup_question in this session that was NOT the mocha/jest
one:** an `edit_file` `old_string` mismatch, asking whether
`buildCondensedMessage` exists — a real, garden-variety "re-read the file
before retrying" case, answered with a redirect each time it came up.
Expect more of these once real tasks are in play; they don't need a
batch-script auto-answer, just a sensible redirect at dispatch time.

## Infra state (verify live — decays fast, session-scratchpad path)

- **`bench-daemon-daemon-1`**: compose file at
  `/tmp/claude-1000/-home-joe-Projects-airunner/*/scratchpad/bench-daemon/docker-compose.yml`
  — will NOT survive a new session's temp dir being cleaned; recreate from
  the template in the 2026-08-20 doc's "Infra state" section if gone, PLUS:
  - the fast-iteration bind mount
    (`/home/joe/Projects/airunnerdesktop/services/src:/app/services/src:ro`)
    — keep it, every fix this session needs it to run (the baked
    `airunnerdesktop:daemon` image predates all of them).
  - **NEW this session:** `cap_add: [SYS_PTRACE]` — added so `py-spy` can
    attach to the daemon process for stack inspection. Debug-only; safe to
    remove once no longer actively debugging, but cheap to leave.
  - `py-spy` is NOT baked into the image — `pip install py-spy` inside the
    container after every recreate if you need it again (each
    `docker compose up -d --force-recreate` wipes it).
  - Current env: `AIRUNNER_GGUF_N_CTX=32768`, `AIRUNNER_GGUF_N_GPU_LAYERS=-1`,
    `AIRUNNER_GGUF_LAST_N_TOKENS_SIZE` unset (4096 default),
    `AIRUNNER_GGUF_KV_CACHE_TYPE` unset (Q8_0 default),
    `AIRUNNER_GGUF_FLASH_ATTN` unset (enabled default — see item 3b, do
    NOT set this to 0 while KV cache type is unset/Q8_0, it will hard-fail
    model load).
  - **Restarting the daemon is REQUIRED after any airunnerdesktop source
    edit** — this container has no watchdog/hot-reload (`--no-preload`
    plain process), unlike the main airunner dev server. `docker compose
    up -d --force-recreate` then poll `docker inspect
    bench-daemon-daemon-1 --format '{{.State.Health.Status}}'` until
    `healthy` (takes ~15-20s).
  - **A client-side timeout does NOT cancel the daemon-side generation**
    — it keeps running server-side for its full duration on the single
    serialized worker thread (confirmed via py-spy: one
    `LLMGenerateWorker` thread, `Thread-1 (_run)`, handles ALL generation
    requests one at a time — no real concurrency is possible with this
    daemon architecture without a significant restructure). The NEXT
    trial's request silently queues up behind an abandoned one unless the
    daemon is restarted first. `run_trial_batch.sh` handles this
    automatically after a timeout; any manual dispatch after a timeout
    must restart the daemon too.
- **`headlesscode-rw`** / **`bench-tier-a` worktree**: same throwaway rw
  container as every prior session, same `/tmp/hc-key.env` +
  `/tmp/task.txt`. Worktree was BROKEN at this session's start (see item
  1) and its branch was stale (22 commits behind) — both fixed. Base
  commit for a clean reset is now `d9d58e7`+this session's 3 headlesscode
  commits = current `master`/`bench/tier-a` tip (`970caaf` as of this
  writing) — **always verify with `git log --oneline -1` after any reset
  that it matches what you expect**, given item 2's lesson.
- Clean the worktree before EVERY trial dispatch with `git reset --hard
  <base-commit> && git clean -fd && rm -f .harness.needs-decision
  .harness.decision-answer` — NEVER `git checkout -- .` alone (item 2).

### Standard dispatch template (updated — now includes `--llm-timeout-ms`)

```sh
docker exec "$CONTAINER" sh -c "cd $WORKTREE && git reset --hard $BASE_COMMIT && git clean -fd && rm -f .harness.needs-decision .harness.decision-answer"

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
  --llm-timeout-ms 300000 \
  --log-file /tmp/trialN.log \
  > /tmp/trialN-stdout.log 2>&1
echo "EXIT:$?" >> /tmp/trialN-stdout.log
'
```

Standard synthetic task (still in `/tmp/task.txt` inside `headlesscode-rw`,
unchanged since the 2026-08-20 doc — the `truncateMiddle` task). **This
session's directive is to move OFF this task onto a real one** — see "What
to try next" below.

## What to try next (concrete, in priority order)

1. **PRIMARY DIRECTIVE: run the standard trial rigor against a REAL
   GitHub issue instead of the synthetic task.** Repo is
   `Capsize-Games/airunner` (confirmed via `gh repo view`). `headlesscode`
   would need to operate on a worktree of `airunner` itself (or
   `airunnerdesktop`, depending on which repo the chosen issue lives in),
   NOT the `headlesscode` repo's own `bench-tier-a` worktree — this is a
   new setup, not a small tweak to the existing one. Candidate issues
   (from `gh issue list --state open` at session end, un-vetted for
   scope/difficulty beyond their titles — read each one's actual body
   before picking, some appeared to have minimal detail):
   - #135/#136 — `deploy/lan` compose stack + nginx sidecar additions
     (infra/config work, may be well-scoped for a first real-task trial)
   - #117 — Stripe webhook dedup TOCTOU (bug, LOW severity)
   - #116 — trusted-proxy CIDR defaults (security, LOW)
   - #115 — promo code logged in raw form (bug/security, LOW)
   - Avoid the HIGH-severity money-path/compliance issues (#108-110) for
     a first real-task trial — pick something small and self-contained
     first to establish whether the harness handles a REAL repo's setup
     (different build tooling, different test runner, possibly Python not
     just TypeScript) before attempting anything with real stakes.
   - Also worth checking whether `headlesscode`'s own prompt/tool
     assumptions (the plain-assert TypeScript convention, `npx tsc`, etc.)
     even apply to `airunner` — it may be a different stack entirely
     (Python per the CLAUDE.md at the top of this repo's own instructions
     mention `server/src/airunner_services/`, so likely a Python+
     TypeScript mixed repo). Read `airunner`'s own CLAUDE.md/CONTRIBUTING
     conventions before dispatching, same as `headlesscode`'s own
     "read an existing example first" rule the prompt teaches the model.
2. Once a real-task setup exists, run the SAME rigor as this session:
   several trials per task, live py-spy/debug-instrumentation
   investigation of any NEW failure mode (don't assume it's the same as
   a synthetic-task failure just because the symptom looks similar),
   verified-live fixes only, commit each as found.
3. Lower priority, still open: the `ask_followup_question` "(no
   question)" recovery bug and the `node:assert` import-path confusion
   (item under "Deliberately NOT done" above) — revisit if either shows
   up again, now against real tasks where they may reproduce more (or
   less) readily than they did against the synthetic one.
4. Lower priority: raising `max_history_tokens=8000` (needs
   companion-chatbot path verification first — still nobody's tested that
   path in this whole investigation).

Same bar as always: verified live against the real daemon, several trials
per change (real run-to-run variance should now be GONE at temperature 0,
which is itself a signal — if a "fix" shows variance across trials at
temp=0 going forward, suspect the fix or the test conditions before
suspecting the model). A capability-ceiling conclusion needs a
daemon-bypass repro AND a code read first, same as always. Never suggest
stopping or wrapping up — keep pushing on this until the model is
genuinely solid on REAL work, not just the one synthetic benchmark task.
