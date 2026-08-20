# Prompt for a clean session — continue local-model harness accommodation

Paste everything below this line into a fresh session.

---

I'm continuing work from tonight's session on `plans/local-dual-model-code-agent.md`
(get `headlesscode`'s `code` mode running well on a local model — Qwen2.5-Coder-14B
on this workstation's RTX 5080 — instead of cloud DeepSeek). Read
`/home/joe/Projects/headlesscode/plans/local-dual-model-code-agent-handoff-2026-08-19.md`
first — it's the detailed handoff from the FIRST half of tonight (bug fixes to
airunnerdesktop's streaming/tool-parsing, headlesscode's lazy-tools/lean-prompt,
attempt_completion bundling). This prompt covers the SECOND half, which happened
after that handoff was written. Read this whole thing before doing anything — you
do not have access to the conversation that produced it.

## What happened in the second half

I ran the confidence-baseline task (the trivial one from the first handoff —
add `estimateTokensForText` to `src/engine/condense.ts` + a test file) five times
against Qwen2.5-Coder-14B through the local Ollama backend. The first three
trials failed in ways that turned out to be **harness bugs, not model
incapacity** — every time I dug into the actual event-level transcript
(`.headlesscode/events/<sessionId>.jsonl`, NOT the summary log — it has the
full untruncated tool-call args and text content) instead of trusting the
summary, the failure traced back to our own code:

1. **Fabricated success**: a bare text-only reply (no tool call at all) was
   unconditionally accepted as a successful session — a local model that gives
   up and dumps prose got recorded as `session succeeded` with zero files
   touched. This also applied to `new_task` child sessions, which had their own
   separate bug (didn't inherit the fix from the parent).
2. **Tool call written as prose instead of using native tool-calling**: the
   model would reason correctly about which tool to call, then write
   `{"name": "edit_file", "arguments": {...}}` as TEXT (sometimes fenced in
   \`\`\`json, sometimes with Python-literal syntax — single-quoted strings,
   `None`) instead of issuing a real `tool_calls` entry. A separate shape of
   the same failure: narrating in past tense that it already called a tool —
   `[Called tool "read_file" with arguments {...}]` — when no such call was
   ever made.

### Fixes made tonight (all UNCOMMITTED — see below)

- `src/engine/loop.ts` / `src/cli.ts`: new `requireExplicitCompletion` config
  field. When true (auto-enabled for the local backend via
  `useLocalCodeBackend` in `cli.ts`, opt-out via
  `HEADLESSCODE_ALLOW_TEXT_ONLY_COMPLETION`), a text-only reply is nudged
  as a mistake instead of accepted as success. Propagated into `new_task`
  child sessions too (line ~3403, `requireExplicitCompletion: this.config.requireExplicitCompletion`).
- `src/engine/parser.ts`: new `extractEmbeddedToolCall(text)` — recovers
  BOTH observed shapes (JSON-blob-as-prose, and the `[Called tool "X" with
  arguments {...}]` narration) tolerant of Python-literal syntax. Wired into
  `loop.ts`'s text-only-reply branch (~line 2898): only executes the
  recovered call for real if its `name` matches a tool actually in
  `this.state.tools` — an arbitrary JSON-shaped blob in ordinary prose can't
  trigger execution.
- `src/engine/prompt.ts`: strengthened `buildLeanSystemPrompt`'s `toolUseNote`
  with a concrete, explicit warning about this exact failure pattern.
- `src/engine/__tests__/loop.test.ts`: 5 new tests covering all of the above
  (nudge-not-accept, bounded-failure-not-fabricated-success, JSON-shape
  recovery + real-tool-name gating, narrated-call-shape recovery, unknown-tool
  refusal). All passing, 53/53 total in `loop.test.ts`, full suite green
  except one PRE-EXISTING unrelated failure (`src/codemap/__tests__/build.test.ts`
  — no Python interpreter in the throwaway test container, nothing to do with
  tonight's changes).

**Nothing is committed.** `git status` in `/home/joe/Projects/headlesscode`
shows modified: `src/cli.ts`, `src/engine/loop.ts`, `src/engine/parser.ts`,
`src/engine/prompt.ts`, `src/engine/__tests__/loop.test.ts`. (There's also an
unrelated untracked `plans/phase-gated-session-loop.md` — not mine, don't
touch it, don't commit it.) Decide whether to commit before doing more work —
probably yes, so you have a clean baseline to diff future changes against.

### Trials 4 and 5 (after the fixes) — where the REAL remaining problem is

With all three fixes active:

- **Trial 4**: correctly FAILED fast (17s, 5 iterations, bounded failure) —
  no fabrication, no 24-minute derailment. Good — the harness is now honest.
  But the embedded-call recovery didn't fire because the model's text at
  those iterations was the narrated-call shape, which (at the time) wasn't
  recognized yet — that's what motivated adding the second regex.
- **Trial 5** (after adding narrated-call recovery): real progress — the
  model correctly wrote `src/engine/__tests__/estimate-tokens-for-text.test.ts`
  to disk via a genuine `write_to_file` call. But it NEVER successfully
  edited `condense.ts`: **twice** (iteration 1 before ever reading the file,
  AND iteration 4 — after it had already read the file's full contents at
  iteration 2) it called `edit_file` with an **empty `old_string`**, which the
  tool correctly rejects as "that means create a new file, but this one
  already exists." Session ended in bounded failure (3 consecutive mistakes).
  This is a real, repeated model mistake, not a harness bug.

## Your task: pursue the prompt/tool-description hypothesis

I'm confident the remaining gap is in OUR prompting and tool descriptions —
they were written for cloud models used through a GUI (this is the vendored
Zoo Code prompt/tool set, `src/vendor/zoo-code/`), not for a 14B local model
called headlessly. Two concrete leads to start from:

1. **`edit_file`'s tool description** — read
   `src/vendor/zoo-code/src/core/prompts/tools/native-tools/edit_file.ts` in
   full (72 lines, I already read it tonight). It DOES say "Use empty string
   to create a new file" and "File must not already exist" — but this is
   presented as usage pattern #2, options-list style, without a sharp warning
   that picking the WRONG one against an existing file is a hard error. A
   smaller model may not be reliably distinguishing "I want to add new
   content" (which reads as similar to "create") from "I want to modify
   existing content" when it hasn't fully internalized the file's current
   state. Also worth checking: did the model maybe get confused by having
   ALREADY tried the empty-old_string form at iteration 1 and then just
   repeating the same tool-call shape at iteration 4 out of some kind of
   anchoring/repetition tendency, rather than genuinely re-deciding? That's a
   different failure class (repetition bias) that a description rewrite
   won't fix — worth checking the full events transcript for trial 5
   (`3df2bdcf-9f3c-4384-b832-c00b42dca4ae`, in
   `.headlesscode/events/` under the bench worktree if it's still there —
   see Infra below) to see the model's actual reasoning text before each
   `edit_file` call, not just the call itself.
2. **The broader pattern**: `plans/local-dual-model-code-agent-handoff-2026-08-19.md`
   already found two other instances of this same class of bug — `apply_diff`'s
   `[line_number]` bracket-placeholder literalism (fixed by dropping
   `apply_diff` from local sessions' default tool set — see
   `src/engine/lazy-tools.ts`) and a reference to a nonexistent
   `environment_details` file in the vendored OBJECTIVE section (fixed via
   `buildLeanSystemPrompt`'s `objectiveNote` in `src/engine/prompt.ts`). Both
   fixes follow the SAME pattern: extend `buildLeanSystemPrompt` or
   `lazy-tools.ts`, NEVER edit the vendored files directly (project
   convention — `src/vendor/zoo-code/` is shared with the cloud path and
   must stay complete/unmodified). Audit the rest of the vendored native-tool
   descriptions (`src/vendor/zoo-code/src/core/prompts/tools/native-tools/`)
   for more of the same: GUI-oriented framing, ambiguous branching logic,
   placeholder syntax that reads as literal, anything assuming a much larger
   model's ability to disambiguate from sparse instructions.

### Concrete options to weigh (pick based on what the evidence supports —
### don't just implement the first idea)

- **Drop `edit_file` for local sessions**, same as `apply_diff` already was,
  defaulting fully to `write_to_file` (whole-file rewrite). Simple, robuts,
  but wasteful for large files and loses the "small diff" signal a
  successful `edit_file` call gives about the model's precision.
- **Add a supplemental warning** via `buildLeanSystemPrompt`'s `objectiveNote`
  or a new note, specifically calling out: "before calling `edit_file` on a
  file, if you're not 100% sure the file doesn't exist, read it first — an
  empty `old_string` against an existing file is always an error, never a
  way to append or insert." Cheap, but tonight's evidence (repeated even
  after `read_file` succeeded) suggests it might not be a text-comprehension
  problem at all — see the repetition-bias caveat above.
- **Make `edit_file`'s error message itself more corrective** — it already
  has decent recovery suggestions; check whether the model is even reading
  the tool_result content back before its next call, or whether something in
  history truncation/condensation is dropping it before the next turn.
- **Investigate whether this is really a description problem vs. a
  Qwen2.5-Coder-14B-specific weakness in structured-diff-based editing** —
  before rewriting anything, it might be worth a quick side-by-side: same
  task, same tool set, run through OpenRouter/cloud DeepSeek (which
  presumably handles `edit_file` fine — that's the existing production path)
  to confirm the description itself isn't the bottleneck for a competent
  model, isolating whether this is truly local-model-specific.

## Infra state (may have decayed — reverify first)

- **Bench inference daemon**: `bench-daemon-daemon-1` container, compose
  project `bench-daemon`, compose file at
  `/tmp/claude-1000/-home-joe-Projects-airunner/8ceecc3a-7b44-4804-a241-72fcc32fea3c/scratchpad/bench-daemon/docker-compose.yml`
  (this path is in MY session's scratchpad and may be gone — the compose
  file content is simple, recreate it if needed: serves
  `Qwen2.5-Coder-14B-Instruct-Q5_K_M.gguf` in ollama-compat mode, host port
  `127.0.0.1:11435`, `n_ctx=32768`, connected to the `airunner-hc_default`
  Docker network so `headlesscode` containers can reach it by container
  name). Was healthy and NOT auto-unloading (`AIRUNNER_LLM_AUTO_UNLOAD=0`)
  as of the end of tonight's session. Check
  `docker ps --filter name=bench-daemon-daemon-1` and
  `curl http://127.0.0.1:11435/api/tags` first. The PRODUCTION chat daemon
  (`lan-daemon-daemon-1`, Qwen3.5-9B, port 11434) was left running throughout
  — untouched, don't need to restore it.
- **Throwaway writable headlesscode container**: `headlesscode-rw`. The
  regular `airunner-hc-headlesscode-1` container has its repo mount
  READ-ONLY by design — don't try to write through it. Recreate with:
  ```
  docker run --rm -d --name headlesscode-rw \
    -v /home/joe/Projects/headlesscode:/workspace/headlesscode:rw \
    -v /home/joe/.local/share/headlesscode:/data/headlesscode-store:rw \
    --network airunner-hc_default \
    -w /workspace/headlesscode \
    headlesscode:0.1.0 sleep infinity
  ```
- **Bench worktree**: `/home/joe/Projects/headlesscode/.worktrees/bench-tier-a`
  (branch `bench/tier-a`). Was clean (no diff) except for trial 5's leftover
  `src/engine/__tests__/estimate-tokens-for-text.test.ts` (untracked) — decide
  whether to keep it as a starting point or `git clean`/reset before the next
  trial. The `.headlesscode/events/<sessionId>.jsonl` files for each trial
  are still in there (`d2603f93-...` = trial 3, `267340b5-...` = trial 4,
  `3df2bdcf-...` = trial 5) — these have the full untruncated transcripts,
  read them with a small Python one-liner (`json.loads` each line, look at
  `type`, `iteration`, `tool`, `result`/`textPreview` fields) rather than the
  summary log.
- **Dispatch command** (same task used for all 5 trials tonight — keep using
  it for continuity, it's deliberately the trivial confidence-baseline task):
  ```
  docker exec -e HEADLESSCODE_CODE_MODE_BACKEND=ollama \
    -e HEADLESSCODE_CODE_MODE_MODEL=qwen2.5-coder:14b \
    -e HEADLESSCODE_OLLAMA_URL=http://bench-daemon-daemon-1:11434 \
    -e HEADLESSCODE_OPENROUTER_API_KEY=<get from airunner-hc-headlesscode-1's env> \
    -w /workspace/headlesscode \
    headlesscode-rw \
    npx tsx src/cli.ts --workspace /workspace/headlesscode/.worktrees/bench-tier-a \
    --mode code --task "In src/engine/condense.ts, add a new exported function \
    estimateTokensForText(text: string): number using the same chars-per-token \
    heuristic as estimateMessageChars in that file. Add a test file at \
    src/engine/__tests__/estimate-tokens-for-text.test.ts with 3+ cases. Do not \
    modify any other file. Run npx tsc --noEmit and node scripts/run-tests.mjs \
    --filter estimate-tokens-for-text yourself before calling attempt_completion." \
    --context-window 16384
  ```
  Get the OpenRouter key fresh with:
  `docker exec airunner-hc-headlesscode-1 sh -c 'echo "$HEADLESSCODE_OPENROUTER_API_KEY"'`
  (it's needed even for the local backend — `cli.ts` requires it unconditionally
  before reaching the backend-selection branch; a real pre-existing minor
  wart, not something you need to fix).

## Methodology (carry forward from the first handoff, reconfirmed tonight)

- **Always read the event-level JSONL transcript for a real failure, never
  just the summary log.** Every single "harness bug" finding tonight came
  from reading `.headlesscode/events/<sessionId>.jsonl`'s full `result`/
  `textPreview` fields — the summary log's truncated one-line `arg` field
  hides exactly the content you need (Python-repr syntax, fenced JSON,
  narrated-call text all only showed up in the full transcript).
- **`ask_followup_question` blocks for real** — write a plain-text answer to
  `.harness.decision-answer` in the worktree to unblock (a `.harness.needs-decision`
  file appears with the question). Push the model to self-correct (re-read
  the file, reconsider) rather than handing it the literal answer when
  possible — more informative about real capability. Twice tonight the
  model asked something that was clearly hallucinated/off-task (a reference
  to `// Add new functions here` that doesn't exist in the file, and a
  question about a nonexistent `frontend-config.json`) — redirecting firmly
  back to the real task and real file contents worked both times.
- **Dispatch backgrounded properly**: use `nohup ... > log 2>&1 < /dev/null &
  disown`, NOT a bare trailing `&` inside a `run_in_background: true` Bash
  call — the outer shell exits immediately either way, but without `nohup`/
  `disown`/`< /dev/null` the child process can still die with the parent in
  some shell configurations. Poll for a terminal state with a separate
  `run_in_background: true` Bash call running an `until grep -qE
  "ERROR session failed|session succeeded|headlesscode: task (failed|completed)|bounded failure"
  "$LOG"; do sleep 5; done` loop — you get one clean notification when it
  actually finishes, no manual polling needed.
- **Never commit debug instrumentation** — if you add a temporary
  `console.log`/`process.stderr.write` to trace something (I did this once
  tonight, in `cli.ts`, to confirm `useLocalCodeBackend` was actually true),
  revert it before moving on to the next thing.
- **Always typecheck + run the affected test file** after any engine change:
  `docker exec -w /workspace/headlesscode headlesscode-rw npx tsc --noEmit`
  and `docker exec -w /workspace/headlesscode headlesscode-rw node
  scripts/run-tests.mjs --filter <name>` (or no `--filter` for the full
  suite — expect the one pre-existing Python-codemap failure, everything
  else must stay green).
- **Clean up before ending the session**: stop/remove `headlesscode-rw` and
  `bench-daemon-daemon-1` (`docker compose down` from the bench-daemon
  compose dir, or `docker rm -f`) if you're truly done for the night: they
  hold GPU VRAM and a Docker network attachment that don't need to persist.
  Leave them running if you expect to keep iterating soon — reconnecting is
  cheap, tearing down and rebuilding the compose stack is not (though the
  image is already built, so it's not THAT slow).

## Ground rules (carry forward, don't relitigate)

- Isolated worktrees only, this is real write/execute authority for a local
  model — treat it that way.
- Don't fabricate or oversell a result — an honest "still doesn't work well"
  is a valid outcome.
- Do NOT touch `orchestrator`/`architect`/`deepseek-reviewer`/`qa-agent`
  modes' backend — cloud-only, unaffected by any of this, by design.
- Do NOT edit `src/vendor/zoo-code/` directly — extend via
  `buildLeanSystemPrompt`/`lazy-tools.ts` instead, same pattern as every fix
  tonight.
- This is the `headlesscode` repo (`/home/joe/Projects/headlesscode`), a
  SEPARATE repo from `airunner` (this conversation's primary working
  directory) and `airunnerdesktop` (the inference daemon repo, branch
  `fix/qwen3-thinking-directive-first-turn-only` — unrelated to tonight's
  second half, no changes needed there this time).
