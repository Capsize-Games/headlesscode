# Handoff — local dual-model code agent, 2026-08-20/21 session

Reference doc for `local-dual-model-code-agent-PROMPT-2026-08-22.md`. Full
history and exact commands live here so the prompt itself can stay short.

## The owner's framing (verbatim, don't lose this)

> i don't believe we've hit model capability ceilings yet at all. i don't
> buy it. there's something wrong with our harness, tool instructions,
> prompts or something else. write a prompt to investigate this and
> continue running trials and pushing this model's capabilities. we want
> to keep refining, keep improving, keep tweaking our implementation until
> this model is solid

This was validated repeatedly. Every "the model can't do X" read that got
chased down properly turned out to be a real, fixable bug — not a
capability ceiling. Hold the same bar going forward: a "model capability"
conclusion needs (a) a raw daemon-bypass reproduction, bypassing
headlesscode entirely, AND (b) a code read that finds no plausible harness/
prompt/tool explanation. Guilty until proven innocent.

## Prior context (read in order if you need earlier history)

1. `/home/joe/Projects/airunner/plans/local-dual-model-code-agent-handoff-2026-08-19.md`
2. `/home/joe/Projects/headlesscode/plans/local-dual-model-code-agent-PROMPT-2026-08-19-night2.md`
3. `/home/joe/Projects/headlesscode/plans/local-dual-model-code-agent-PROMPT-2026-08-20.md`
4. `/home/joe/Projects/headlesscode/plans/local-dual-model-code-agent-PROMPT-2026-08-21.md`

## Ground rules (unchanged, still binding)

Isolated worktrees only (`.worktrees/bench-tier-a` in headlesscode),
checkpoints on, never touch `orchestrator`/`architect`/`deepseek-reviewer`/
`qa-agent` modes' backend (cloud-only), never edit `src/vendor/zoo-code/`
directly (extend via lazy-tools/prompt.ts), always read the real event-level
JSONL transcript for a failure — never trust a summary log line, check for
`.harness.needs-decision` before assuming a hang, clean the worktree and
check for orphaned processes between every trial, never commit temporary
debug instrumentation, never fabricate or oversell a result, restore
`lan-daemon-daemon-1` (production) if you tear down the bench daemon.

## Eleven fixes shipped and verified this session

All committed, `tsc --noEmit` clean, full suite green except the
pre-existing Python-codemap failure (no Python interpreter in the dev
container, unrelated, ignore it). Read each commit message for full
reasoning — this is just the index.

**headlesscode (`master`)**:

1. `48d901e` — `guardLargeOverwrites` + `verifyBeforeCompletion` no longer
   one-shot.
2. `89bb8cc` — `list_files` repeat guard: hard refusal → soft cache-hit
   notice (hard refusal was making the model burn its whole mistake budget
   refusing itself).
3. `c274ddc` — **the biggest one.** Recovering a tool call the model wrote
   as narrated prose (`extractEmbeddedToolCall`) used to keep the model's
   entire hallucinated narration — once 26K characters, including a fully
   fabricated fake tool result — as the persisted message content. That
   poisoned every subsequent request and reproduced a genuine daemon
   generation hang (first chunk arrives, then total silence past the 300s
   client timeout) on the next request that included it, twice,
   independently. Now clears content to `null` once a call is recovered.
4. `d917e0f` — tight identical-consecutive-call guardrail (nudge at 2
   repeats, hard stop at 4), any tool, success or error streak. Unifies
   `apply_diff`/`ask_followup_question`/`list_files` repeat patterns into
   one fix.
5. `a6157a8` — dropped `search_replace` from the local core tool set
   (same precedent as `apply_diff`). It requires an exact literal match
   with zero fallback; `edit_file` has a 3-stage fallback chain built for
   exactly the whitespace drift that was tripping it.
6. `c9d6a48` — `edit_file` refuses a large-insertion replacement applied
   at multiple sites. `edit_file`'s OWN error-recovery suggestion
   ("if you intend to replace all occurrences, set expected_replacements
   to N") walked the model into inserting a whole new function body into
   4 unrelated call sites at once, corrupting 3 of them.
7. `74b4678` — local sessions get an explicit planning note pointing at
   `update_todo_list` (registered and offered every turn, but nothing in
   the prompt ever explained it existed).
8. `ccf603d` — local sessions told to `read_file` an existing example
   before writing a new file in an "existing style" (the model defaulted
   to Jest syntax three separate times despite the task saying to match
   this codebase's actual plain-assert style).
9. `7d8077c` — the identical-call nudge names the concrete next pending
   todo-list step instead of generic "try something different" advice
   (verified live that the generic version didn't change behavior).
10. `34d1a50` — planning note says the todo checklist starts all-pending;
    a trial marked all 3 items `[x]` before doing any real work, which
    also defeated fix #9 (nothing pending to point at).

**airunnerdesktop (`fix/qwen3-thinking-directive-first-turn-only`)**:

11. `21c8b87a0` — every `json.loads()` parsing a model-generated tool call
    now passes `strict=False`. Strict JSON rejects a literal newline
    inside a string value — exactly what a tool-call argument holding real
    code routinely contains. A genuine, complete `edit_file` call was
    being silently discarded and reported back as "the model produced an
    empty reply," indistinguishable from the model generating nothing.

**n_ctx**: tried raising from 32768 to the GGUF's real trained ceiling of
40960 (the catalog's claimed 131072 is wrong — `llama.cpp` itself logs
"possible training context overflow" past 40960). Reproduced a
deterministic generation hang twice under real multi-turn load at both
40960 and 32768 with zero change in outcome — **not n_ctx-related**,
reverted to 32768 for now. Worth re-testing once fix #3 above is confirmed
to be the actual cause (a giant hallucinated blob in history would behave
differently at different context sizes — never directly tested).

## Where trials landed (19 total across this session and the prior one)

Trajectory is real and measurable:

- Trial 5 (before any of tonight's fixes): died in 8 iterations refusing
  itself via the old hard-refuse `list_files` guard.
- Trial 15 (after fixes 1-8): reached iteration 27, self-corrected from an
  `ask_followup_question` redirect, wrote a correctly-styled test file,
  got `tsc` to pass — died on a genuine remaining bug (its own test
  assertion didn't match its own implementation's real output).
- Trial 19 (after all 11 fixes): wrote its todo list correctly (pending →
  done as it actually completed steps, verified via the event log), then
  still fell into the `list_files` loop immediately after — even with the
  nudge correctly naming the exact next pending step
  ("Verify the changes with typecheck and tests — do THAT now").

**The remaining failure mode is narrower than it was**: not "no plan," not
"wrong conventions," not "corrupting edits" — all of those got fixed and
stayed fixed across multiple trials. What's left: once the model is
mid-repetition on one specific tool call, an injected corrective message —
however specific — doesn't reliably interrupt it. That's a real,
well-isolated question, not a vague "capability ceiling."

## What to try next (concrete, not yet attempted)

**A sampling-level intervention instead of another prompt-level one.**
Every fix so far has been "add better text to the context." That's
provably hit diminishing returns on this specific failure shape (three
rounds of increasingly specific nudges, same outcome). Two untried levers:

1. Raise `repeat_penalty` (or the daemon's equivalent knob) specifically
   once the harness's identical-call guard detects a repeat is starting,
   instead of only injecting text. Find where `airunnerdesktop`'s GGUF
   adapter sets sampling params per-request
   (`chat_gguf_model_loading.py`/`chat_gguf_runtime_mixin.py` are the
   likely spots — grep from there) and check whether it's already
   request-overridable or needs wiring.
2. On the retry after a detected repeat, try forcing `tool_choice` to
   exclude the just-repeated tool (if llama.cpp's grammar-constrained
   tool-calling supports an exclusion list, not just a forced single
   tool) — removes the option to repeat instead of asking nicely.

Try one, verify live (does the SAME repeat-prone task sequence actually
stop repeating, not just "seems better"), then keep running trials — several
per change, not one, there's real run-to-run variance even at
`temperature: 0` (seen directly: trials 11 and 12 took different paths from
an identical starting task).

## Infra state (verify live — decays fast, this is a session-scratchpad path)

- **`bench-daemon-daemon-1`**: compose file at
  `/tmp/claude-1000/-home-joe-Projects-airunner/*/scratchpad/bench-daemon/docker-compose.yml`
  — this path will NOT survive a new Claude Code session's temp dir being
  cleaned. If gone, recreate with `AIRUNNER_GGUF_N_CTX: "32768"`,
  `AIRUNNER_LLM_MODEL_PATH` pointing at
  `Qwen3-14B/Qwen3-14B-Q4_K_M.gguf`, `--no-preload`, GPU reservation, ports
  `127.0.0.1:11435:11434`. Full template in doc #3 (2026-08-20)'s "Infra
  state" section.
- **`headlesscode-rw`**: a throwaway read-write container (repo mounted
  `rw`, unlike the read-only `airunner-hc-headlesscode-1`), connected to
  `bench-daemon_default`. `/tmp/hc-key.env` inside it holds
  `HEADLESSCODE_OPENROUTER_API_KEY` (re-copy from
  `airunner-hc-headlesscode-1`'s env if recreated). `/tmp/task.txt` holds
  the standard task (below).
- **`bench-tier-a` worktree**
  (`/home/joe/Projects/headlesscode/.worktrees/bench-tier-a`, base
  `c41180e`): run git commands on the HOST path, not inside
  `headlesscode-rw` (its absolute-path git metadata for this worktree is
  broken — `fatal: not a git repository`). Clean between every trial:
  `git checkout -- . && git clean -fd`. Also remove
  `.harness.needs-decision`/`.harness.decision-answer` if a prior trial
  left one blocked.
- **Orphan check** (no `ps` in the container):
  ```sh
  docker exec headlesscode-rw sh -c '
    for f in /proc/[0-9]*/cmdline; do tr "\0" " " < "$f" 2>/dev/null; echo; done | grep -a "cli.ts"
  '
  ```

### Standard dispatch template

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

Poll with a bounded loop watching for either `EXIT:` in the stdout log OR
`.harness.needs-decision` appearing (the model called
`ask_followup_question` and is genuinely blocked, not hung — read the
question, write a redirect-not-literal-answer to
`.harness.decision-answer`, matching the established methodology).

Standard task (`/tmp/task.txt` inside `headlesscode-rw`):

```
Add a new exported function truncateMiddle(text: string, maxLength: number): string to src/engine/condense.ts, near estimateMessageChars. IMPORTANT: this file already has substantial existing content (500+ lines) that must be preserved exactly — use edit_file or search_replace to ADD the new function, never write_to_file (which would overwrite and destroy the whole file). Behavior: if text.length <= maxLength, return text unchanged. Otherwise, truncate it to exactly maxLength characters total by keeping the first half and last half of the available length with an ellipsis "..." in the middle. Add a test file at src/engine/__tests__/truncate-middle.test.ts with at least 3 cases (short text unchanged, long text truncated to exact length, edge case at maxLength boundary), following the existing plain-assert test style used elsewhere in src/engine/__tests__/. Do not modify any other file. Call ONE tool at a time. Verify with npx tsc --noEmit and node scripts/run-tests.mjs --filter truncate-middle yourself before calling attempt_completion.
```

## Methodology notes specific to this session

- A daemon "hang" (first chunk arrives, then silence past the client
  timeout) is diagnosable from `docker logs bench-daemon-daemon-1` —
  `_log_first_native_chunk` with no following `_log_stream_finish`.
  `docker inspect ... Health.Status` staying "healthy" means nothing (that
  only probes `/api/tags`); a real check is a trivial `curl .../api/chat`
  with `num_predict: 10` and a short `-m` timeout.
- To capture the exact raw request that triggers a specific failure: add a
  one-line dump to `legacy_ollama_compat.py`'s `ollama_chat` (write
  `body` to a file), bind-mount
  `/home/joe/Projects/airunnerdesktop/services/src` over
  `/app/services/src:ro` in the bench-daemon compose file for fast
  iteration without a full CUDA rebuild, `docker compose up -d
  --force-recreate`. Revert the debug line and remove the bind mount in
  the SAME sitting once done — never commit either.
- `eval_count`/per-turn token counts in headlesscode's own logs are NOT
  reliable — `legacy_ollama_compat.py`'s `_ollama_timings` computes
  `eval_count = len(response_text) // 4`, a crude character estimate, not
  a real llama.cpp token count. Not yet fixed (separate, larger piece of
  work — real counts would need threading through from llama.cpp's own
  response). Don't reason about generation size from these numbers; pull
  the real daemon log line (`Total chunks: N, content length: M`) instead.
