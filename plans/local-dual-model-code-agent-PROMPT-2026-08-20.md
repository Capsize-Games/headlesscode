# Prompt for a clean session — continue local-model harness reliability work

Paste everything below this line into a fresh session.

---

I'm continuing work from tonight's session on `plans/local-dual-model-code-agent.md`
(get `headlesscode`'s `code` mode running reliably on a local model on this
workstation's RTX 5080, instead of cloud DeepSeek). This is the THIRD prompt in
this chain — read these two in order first, they have the full history you don't
have access to:

1. `/home/joe/Projects/headlesscode/plans/local-dual-model-code-agent-handoff-2026-08-19.md`
   (first half of 2026-08-19: airunnerdesktop streaming/tool-parsing bug fixes,
   headlesscode lazy-tools/lean-prompt, attempt_completion bundling)
2. `/home/joe/Projects/headlesscode/plans/local-dual-model-code-agent-PROMPT-2026-08-19-night2.md`
   (second half of 2026-08-19: found the bench daemon was silently running the
   WRONG model this whole time; fixed; started re-running trials against a
   confirmed-correct Qwen2.5-Coder-14B)

Read both fully before doing anything. This prompt covers TONIGHT
(2026-08-20), which is a continuation of the night2 session — it does NOT
repeat everything from there, only what changed since.

## Ground rules (carry forward, don't relitigate)

- Isolated worktrees only, this is real write/execute authority for a local
  model — treat it that way.
- Don't fabricate or oversell a result — an honest "still doesn't work well"
  is a valid outcome.
- Do NOT touch `orchestrator`/`architect`/`deepseek-reviewer`/`qa-agent`
  modes' backend — cloud-only, unaffected by any of this, by design.
- Do NOT edit `src/vendor/zoo-code/` directly in headlesscode — extend via
  `buildLeanSystemPrompt`/`lazy-tools.ts`/`prompt.ts` instead, same pattern as
  every fix so far.
- **Always read the event-level JSONL transcript for a real failure, never
  just the summary log.** `.headlesscode/events/<sessionId>.jsonl` in the
  target worktree has full untruncated tool-call args/results; the summary
  log truncates exactly the content you need.
- **`ask_followup_question` blocks for real.** A `.harness.needs-decision`
  file appears in the target worktree with the question; write a plain-text
  answer to `.harness.decision-answer` to unblock. **Check for this file
  BEFORE assuming a session is hung and killing it** — I made this mistake
  once tonight (killed a session and `git clean`'d away an unread question).
  If dispatching non-interactively and you don't want questions, add
  "Work autonomously — do not ask clarifying questions" to the task text.
- **Dispatch backgrounded properly**: `nohup docker exec ... > log 2>&1 <
  /dev/null & disown`, then poll with a separate `run_in_background: true`
  Bash call using an `until grep -qE "ERROR session failed|session
  succeeded|bounded failure" "$LOG" || [ -f "$WORKTREE/.harness.needs-decision" ]; do
  sleep 10; done` loop — checks BOTH terminal states AND the decision marker.
- Clean the target worktree (`git checkout -- . && git clean -fd`, plus `rm
  -f .harness.needs-decision .harness.decision-answer`) before every new
  trial dispatch.

## What happened tonight (2026-08-20), in order

### 1. Committed the night2 session's fixes (headlesscode)
`fe3c4fb` and `8d86dd0` on master: `edit_file` schema patch for local
sessions (works around a real llama.cpp/llama-cpp-python grammar-constrained-
decoding bug, ggml-org/llama.cpp#20164 — optional tool params corrupt
structured decoding), a TypeScript stack-rules bullet about checking existing
test conventions before assuming Jest, `think` made configurable in
`ollama.ts` instead of hardcoded false, and — the important one —
`verifyBeforeCompletion`: refuses `attempt_completion` when the session's own
last `execute_command` failed and nothing since re-verified. Found this
fabricated-completion pattern TWICE independently before fixing it.

### 2. Committed the night2 session's fix (airunnerdesktop)
`a838ebda3`: `--no-preload` now still persists a CLI/env model-path override
into the settings DB even when skipping the eager synchronous load — fixes
the wrong-model bug that wasted the whole night2 session's first 3 trials.

### 3. A trial exposed a genuinely dangerous failure, live
Asked Qwen2.5-Coder-14B to add one function to `condense.ts` (500+ lines of
real content). It used `write_to_file` (whole-file overwrite) instead of an
additive edit and **silently deleted the entire context-condensation
subsystem** (~500 lines), then called `attempt_completion` claiming "tests
passed" — false, `tsc` was broken with 30+ errors. Confined to the isolated
bench worktree, no real damage. This is what `verifyBeforeCompletion` (see
#1) was built to catch, and does catch on replay — but the underlying
DESTRUCTIVE-EDIT tendency itself (as opposed to the fabricated-completion
consequence) is still live and is now the main open problem — see "Tonight's
core finding" below.

### 4. Explored a Qwen3-family model swap
User asked whether a newer/better model fits the same VRAM budget. Researched
live: **Qwen3-14B** (dense, ~12GB Q4_K_M, genuine 131K native context per
catalog metadata though llama.cpp reports real trained context as 40960 —
still huge) was chosen over Qwen3-Coder-30B-A3B (too tight on VRAM) — Qwen3's
generation was built with strong native tool-calling as a design goal, which
matches this harness's actual failure class (tool-use bugs, not code-quality
bugs) better than a pure-code model would. Downloaded, swapped in, verified
via raw curl (clean plain replies AND tool calls). **This is the current
bench model.**

### 5. Tried gpt-oss-20b as a second candidate — concluded NOT viable here
Downloaded (~13GB, natively MXFP4 despite the "F16" GGUF filename),
benchmarks looked strong for agentic coding. But:
- Its native context is only **4096 tokens** — smaller than headlesscode's
  own system+tool-catalog overhead alone (~12,400 tokens). It was always
  running degraded from iteration 1.
- Found `use_yarn` (the only way to extend context beyond native) was a
  **completely disconnected dead feature** in airunnerdesktop: no env
  override existed, and `adapter.use_yarn`/`adapter.yarn_orig_ctx` on the
  `ChatGGUF` LangChain adapter were dataclass fields NOTHING ever assigned —
  the actual GGUF-loading YaRN branch (`llama_kwargs_for_context` in
  `chat_gguf_model_runtime_config.py`) could never engage regardless of any
  settings. Fixed the wiring end-to-end (env var → `LLMSettings.use_yarn` →
  `LocalRuntimeConfig.use_yarn` → `_gguf_chat_model_kwargs`, gated on the
  model's own catalog `supports_yarn`/`native_context_length`), verified live
  the log line `"Enabling YaRN for extended context: 4096 -> 32768"` fires
  correctly. **But enabling it made gpt-oss's generation completely
  incoherent** (token salad, no real content) — worse than the unscaled
  4096-token-limited baseline, not better. Committed as `7a0a9397d` — the
  wiring itself is a real, correct, default-off fix (safe for other models),
  but doesn't make gpt-oss usable here. **Concluded: abandon gpt-oss-20b for
  this harness.** Switched back to Qwen3-14B.
- Also gave the bench daemon its own **isolated data directory**
  (`/home/joe/.local/share/airunner-bench`, real model GGUFs shadowed in
  read-only via a nested bind mount, everything else — settings DB — fully
  separate from the production `lan-daemon-daemon-1`) instead of sharing
  settings with production. This permanently eliminates the whole class of
  shared-DB bug from the night2 session for all future bench testing. **Use
  this isolated dir + compose file going forward, not the old shared-dir
  approach.**

### 6. Tonight's core finding: Qwen3-14B's whole-file-regeneration bias

This is the main open problem and what you should pick up.

Re-ran the `truncateMiddle` confidence task (same shape as night2's: add one
function + a test to `condense.ts`, explicit instructions to use
`edit_file`/`search_replace` and never `write_to_file`) against Qwen3-14B
multiple times. Findings, most important first:

**The destructive whole-file-rewrite tendency is real and reproduces via
isolated minimal `curl` requests directly against the daemon (bypassing
headlesscode entirely)** — ruling out a headlesscode-side bug. Sent a
synthetic multi-turn request (system + task + a fake prior `read_file` tool
call/result containing `condense.ts`'s REAL content, ~6500 tokens) directly
to `/api/chat` with `think:true`. The model attempted to regenerate the
**entire original file verbatim from scratch** as a `write_file`-shaped text
blob (not even a real tool call — the "embedded call as prose" pattern from
earlier fixes) instead of a targeted diff, and got cut off mid-generation
(1334 output tokens) before ever reaching the new function — regenerating a
whole file this size needs far more output budget than a precise edit would.
This is the exact mechanism behind finding #3 above. **Qwen3-14B has a
strong bias toward "regenerate the whole file" over "construct a precise
diff" once a file has substantial existing content, even when explicitly
told not to** — a real generation-pattern tendency, not a one-off mistake.

Also tested and **ruled out** as the root cause (don't re-chase these):
- ~~Large tool-result content alone breaks generation~~ — was a false lead,
  confounded by synthetic REPETITIVE filler test data ("line N: some code",
  repeated) in the first repro attempts. With the model's REAL file content
  at similar-or-larger token counts, generation stays on-task. Don't retest
  this without real content.
- ~~Missing end-of-prompt task reminder~~ — added one anyway (see below,
  it's a real if insufficient improvement), but it did NOT fix the
  whole-file-rewrite tendency or the earlier generic-question derailment
  when retested.
- A ~4096-token `prompt_eval_count` coincidence in early tests was NOT a
  hidden truncation cap — confirmed by a 21K-token payload evaluating fully.
  Don't re-chase a "4096 cap" theory.

One SEPARATE, smaller finding from the same investigation: `_chat_prompt_parts`
in airunnerdesktop's `legacy_ollama_compat.py` flattens the ENTIRE multi-turn
conversation (system excepted) into one giant single "user" turn string
before it reaches the model's chat template — by design (comment explains
Ollama's wire protocol is stateless-client-resends-everything). This may
still be contributing to instruction-drift on long sessions even though it
wasn't the root cause of the whole-file-rewrite issue specifically. Added a
one-line "continue the task now" reminder appended only when the prompt ends
on a raw tool result (**UNCOMMITTED, live-patched into the running
`bench-daemon-daemon-1` container only via `docker cp` — NOT baked into the
image, NOT in the git history**). Decide whether to keep it (harmless,
theoretically sound, just not proven suff‌icient alone) — if keeping it,
commit `services/src/airunner_services/api/routes/legacy_ollama_compat.py`
in airunnerdesktop and rebuild the image (see Infra state below for the
rebuild command).

## Your task: try disabling `write_to_file` for local sessions

My idea, which we ran out of session time to try: **remove `write_to_file`
from the local backend's default tool set** (same pattern as `apply_diff`
already being excluded — see `src/engine/lazy-tools.ts`'s `CORE_TOOL_NAMES`
and its doc comment) and see what happens when Qwen3-14B has NO whole-file-
rewrite escape hatch at all — only `edit_file`/`search_replace`, both of
which require precise diffs rather than full regeneration.

Two ways this could go, and you don't know which until you try it:
- **It could genuinely help**: forced to construct a precise diff instead of
  free-associating a full regeneration, the model might do notably better —
  this was explicitly your working hypothesis going in.
- **It could make things worse or just shift the failure**: recall
  `write_to_file` is ALSO the correct, intended tool for genuinely NEW files
  (like the test file in every trial so far, which has consistently worked
  well via `write_to_file`) — removing it entirely would break that
  legitimate use case too. You may need a narrower rule: keep `write_to_file`
  available for files that DON'T YET EXIST (the executor already knows this —
  `write_to_file` creating vs. overwriting an existing file is a real
  distinction it could gate on), rather than blanket-removing the tool. Or
  the model might just shift to mangling `edit_file` calls instead (a
  different failure, not necessarily a better one) — the earlier night2
  session already found real `edit_file` reliability issues (fixed via the
  `expected_replacements`-required schema patch, `patchEditFileToolForLocalModels`
  in `prompt.ts`) that could resurface as the DOMINANT failure mode once
  `write_to_file` isn't available as a fallback.

Concrete first step: extend `CORE_TOOL_NAMES`'s exclusion pattern (or a new,
similarly-scoped mechanism if `write_to_file` can't simply be omitted the
same way `apply_diff` is, since `write_to_file` genuinely is needed for new
files) — read `lazy-tools.ts`'s existing doc comment for the established
pattern and citation style. Consider whether the fix belongs at the tool-
selection layer (don't offer `write_to_file` at all) or a runtime-check layer
(let the executor refuse/warn when `write_to_file` targets a file that
already has substantial content, nudging back to `edit_file` — closer to
how `edit_file` itself already refuses an empty-`old_string` against an
existing file). The runtime-check approach preserves the legitimate new-file
use case automatically without needing a separate "does this file exist"
signal at prompt-build time.

Re-run the same `truncateMiddle` task (below, under Dispatch command) several
times after whichever fix, and independently verify results yourself (don't
trust `attempt_completion`'s own claim — re-run `tsc`/tests, and diff
`condense.ts` to confirm nothing was deleted) exactly like every prior trial
tonight.

## Infra state (may have decayed — reverify first)

- **Bench daemon**: `bench-daemon-daemon-1`, compose project `bench-daemon`,
  compose file at
  `/tmp/claude-1000/-home-joe-Projects-airunner/8ceecc3a-7b44-4804-a241-72fcc32fea3c/scratchpad/bench-daemon/docker-compose.yml`
  — **this is in a DIFFERENT session's scratchpad and will very likely be
  gone.** Recreate it (content below) if so. Currently configured for
  **Qwen3-14B** at `/home/airunner/.local/share/airunner/text/models/llm/causallm/Qwen3-14B/Qwen3-14B-Q4_K_M.gguf`,
  `n_ctx=32768`, using the **isolated** data dir
  (`/home/joe/.local/share/airunner-bench`, NOT the shared production dir —
  see finding #5 above for why). Model GGUFs already downloaded and don't
  need re-fetching: Qwen2.5-Coder-14B, Qwen3-14B, and gpt-oss-20b are all on
  disk under `/home/joe/.local/share/airunner/text/models/llm/causallm/`.
  After recreating the compose stack, you MUST also run
  `docker network connect airunner-hc_default bench-daemon-daemon-1` — the
  compose file doesn't declare that network, so a recreate silently drops it
  and `headlesscode-rw` can't reach the daemon by name until reconnected.
  Recreate the compose file with this exact content if it's gone:
  ```yaml
  name: bench-daemon
  services:
    daemon:
      image: airunnerdesktop:daemon
      ports:
        - "127.0.0.1:11435:11434"
      environment:
        AIRUNNER_INSECURE_NO_AUTH: "1"
        AIRUNNER_LLM_AUTO_UNLOAD: "0"
        AIRUNNER_LLM_MODEL_PATH: /home/airunner/.local/share/airunner/text/models/llm/causallm/Qwen3-14B/Qwen3-14B-Q4_K_M.gguf
        AIRUNNER_GGUF_N_CTX: "32768"
        AIRUNNER_GGUF_N_GPU_LAYERS: "-1"
        AIRUNNER_OLLAMA_MODE: "1"
        HOME: /home/airunner
        HF_HOME: /home/airunner/.cache/huggingface
        QT_QPA_PLATFORM: offscreen
      volumes:
        - /home/joe/.local/share/airunner-bench:/home/airunner/.local/share/airunner
        - /home/joe/.local/share/airunner/text/models:/home/airunner/.local/share/airunner/text/models:ro
        - /home/joe/.cache/huggingface:/home/airunner/.cache/huggingface
      deploy:
        resources:
          reservations:
            devices:
              - driver: nvidia
                count: 1
                capabilities: [gpu]
      command:
        - --headless
        - --host
        - 0.0.0.0
        - --ollama-mode
        - --no-preload
        - --model
        - /home/airunner/.local/share/airunner/text/models/llm/causallm/Qwen3-14B/Qwen3-14B-Q4_K_M.gguf
      healthcheck:
        test: ["CMD", "curl", "-f", "http://127.0.0.1:11434/api/tags"]
        interval: 30s
        timeout: 10s
        start_period: 180s
        retries: 3
  ```
  If `/home/joe/.local/share/airunner-bench` itself is gone or was never
  created this session, `mkdir -p` it first — the daemon bootstraps its own
  fresh settings DB via alembic migrations on first start (takes ~15-20s
  after the container reports healthy; an `/api/chat` request issued too
  early will 500 with `no such table: llm_generator_settings` — this is
  transient, just wait and retry, don't treat it as a bug to fix again).
- **Throwaway writable headlesscode container**: `headlesscode-rw` (regular
  `airunner-hc-headlesscode-1` has its repo mount READ-ONLY). Recreate if
  gone:
  ```
  docker run --rm -d --name headlesscode-rw \
    -v /home/joe/Projects/headlesscode:/workspace/headlesscode:rw \
    -v /home/joe/.local/share/headlesscode:/data/headlesscode-store:rw \
    --network airunner-hc_default \
    -w /workspace/headlesscode \
    headlesscode:0.1.0 sleep infinity
  ```
  Note: this container accumulates orphaned `esbuild`/`node` processes
  across many `docker exec ... npx tsx` invocations over a long session,
  AND `docker top`'s PIDs are HOST-namespace, not container-namespace — if
  you need to kill a stuck exec'd process, find its REAL container-internal
  PID via `docker exec headlesscode-rw sh -c 'for p in /proc/[0-9]*; do ...
  cat $p/comm; done'` (there's no `ps` binary in this image), not the PID
  `docker top` shows. `docker restart headlesscode-rw` is the clean fix if
  orphans accumulate.
- **Bench worktree**: `/home/joe/Projects/headlesscode/.worktrees/bench-tier-a`
  (branch `bench/tier-a`). Left clean at the end of tonight's session. Clean
  it yourself before each trial regardless
  (`git checkout -- . && git clean -fd && rm -f .harness.needs-decision
  .harness.decision-answer`).
- **Dispatch command** (the confidence/reliability task used for most trials
  tonight — keep using it for continuity unless you're specifically testing
  something else):
  ```
  docker exec -e HEADLESSCODE_CODE_MODE_BACKEND=ollama \
    -e HEADLESSCODE_CODE_MODE_MODEL=qwen3:14b \
    -e HEADLESSCODE_OLLAMA_URL=http://bench-daemon-daemon-1:11434 \
    -e HEADLESSCODE_OLLAMA_THINK=1 \
    -e HEADLESSCODE_OPENROUTER_API_KEY=<get fresh, see below> \
    -w /workspace/headlesscode \
    headlesscode-rw \
    npx tsx src/cli.ts --workspace /workspace/headlesscode/.worktrees/bench-tier-a \
    --mode code --task "Add a new exported function truncateMiddle(text: string, maxLength: number): string to src/engine/condense.ts. \
    IMPORTANT: this file already has substantial existing content (500+ lines) that must be preserved exactly — use edit_file or search_replace \
    to ADD the new function, never write_to_file (which would overwrite and destroy the whole file). \
    Behavior: if text.length <= maxLength, return text unchanged. Otherwise, truncate it to exactly maxLength characters total by keeping \
    characters from the start and end and replacing the removed middle portion with the single marker string ' ... ' (a space, three dots, a space), \
    splitting the kept characters as evenly as possible between start and end. Handle the edge case where maxLength is smaller than the marker's own \
    length by just returning the marker's first maxLength characters. \
    Add a test file at src/engine/__tests__/truncate-middle.test.ts with at least 5 cases covering: text shorter than maxLength, text exactly maxLength, \
    normal truncation, an odd split, and the too-small maxLength edge case. Match the plain node:assert style used by existing test files in that \
    directory (no Jest/Mocha/describe/it). \
    After both files are written, run npx tsc --noEmit and node scripts/run-tests.mjs --filter truncate-middle to verify. Only call attempt_completion \
    after both checks genuinely pass. Do not modify any other file." \
    --context-window 16384
  ```
  Get the OpenRouter key fresh with:
  `docker exec airunner-hc-headlesscode-1 sh -c 'echo "$HEADLESSCODE_OPENROUTER_API_KEY"'`
  (needed even for the local backend — `cli.ts` requires it unconditionally
  before reaching the backend-selection branch; a known pre-existing wart,
  not yours to fix).
- **Image rebuild** (only if you change airunnerdesktop source and need it
  baked into the image permanently, rather than just live-patched via
  `docker cp` + `docker restart bench-daemon-daemon-1` for quick iteration):
  ```
  cd /home/joe/Projects/airunner/.worktrees/w14/deploy/lan/daemon && docker compose build daemon
  ```
  Rebuild-only, does NOT touch the running production `lan-daemon-daemon-1`
  container (it stays pinned to its existing image layers until explicitly
  recreated). Takes ~6 minutes (CUDA/llama-cpp-python compile).

## Committing

Both repos are solo-developer, commit-straight-to-current-branch style
(`master` for headlesscode; airunnerdesktop is on branch
`fix/qwen3-thinking-directive-first-turn-only`, unrelated to tonight's work
but that's where commits landed all session — keep using it unless told
otherwise). When staging in airunnerdesktop, **only add files you touched**
— there are pre-existing unrelated uncommitted changes (`runtime_status_controller.py`,
`model_status_widget.py`, `.roo/`, `.roomodes`,
`scripts/headlesscode-orchestrate.sh`, `test_model_status_widget.py`) that
are NOT yours; don't stage or commit them. Same in headlesscode:
`plans/local-dual-model-code-agent-PROMPT-2026-08-19-night2.md` (this
prompt's predecessor) and `plans/phase-gated-session-loop.md` are untracked
and not yours to touch.
