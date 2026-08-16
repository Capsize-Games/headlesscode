# Token & wall-clock efficiency, round 3: reasoning echo, checkpoint-on-critical-path, oversized reads, prompt/tool-catalog trimming

## Who you are working on this for

You are implementing this against the `headlesscode` repository — a standalone
Node/TypeScript CLI that runs a headless coding-agent loop, ported from the
open-source Zoo Code VS Code extension (vendored verbatim under
`src/vendor/zoo-code/`). Match the project's established conventions: no test
framework beyond hand-rolled `assert` + `tsx`-run `.test.ts` files, minimal new
dependencies, `npx tsc --noEmit` clean, `npm test` green in full, and re-run the
relevant `scripts/e2e*/run.sh` suites when the change touches the orchestrator,
watcher, or spawn/worker scripts. Read `.roo/rules/rules.md` in full before
starting — especially the "non-fatal failure pattern" and "citation" rules.

**Commit your work before calling `attempt_completion`.** Every real, working
change must be committed via `git add` + `git commit` with a descriptive message
per logical change (run `git log --oneline` for this repo's normal style).

## Scope note — what this document is

This document is an evaluation of the harness's remaining efficiency
opportunities, prioritized by expected impact. It contains **eight independent
items**. Each is self-contained and can be dispatched as its own worktree/round.
Items marked **"measure first"** must produce real per-session numbers (from
`harness.log`'s `[usage] running total` lines and the per-session
`.headlesscode/usage/*.jsonl` records) BEFORE any code change — the whole point
is to confirm the spend is real rather than assume it. Items marked
**"implement directly"** are changes whose cost/benefit is already clear from
the code, not guesswork.

Two things are deliberately NOT in scope, because they are already implemented
(do not re-do them, but know they exist so you don't chase them):

- **Prompt-cache stable prefix** — `truncateHistory` evicts in fixed batches
  rather than reslicing every call, so the sent prefix stays byte-identical
  between eviction points and provider-side prompt caching accrues
  (`src/engine/loop.ts:3402-3484`).
- **Session-scoped `read_file` cache** — identical args + identical on-disk hash
  short-circuit re-reads (`src/tools/executor.ts:472-615`).
- **Token-budget-aware condensation + async early-fire** — `src/engine/condense.ts`
  and `src/engine/loop.ts:1628-2030`.
- **Cheaper condensation model (`_condensation`)** — resolved and wired in
  `src/cli.ts:851-858`.
- **Graded reasoning effort (`_reasoning_effort`)** — resolved and wired in
  `src/cli.ts:868-869`; validated by `parseReasoningEffort` in
  `src/llm/openrouter.ts:729-750`.

---

## Item 1 — Reasoning content is echoed into history and re-billed every turn (HIGHEST impact; measure first)

### The evidence

The harness pins the DeepSeek family and requests reasoning text on every
main-loop call: `src/llm/openrouter.ts:788-802` sets `include_reasoning: true`
unconditionally for `deepseek/*` models (and `allow_fallbacks: false`). The
reasoning arrives on the response message (`src/engine/types.ts:42` documents
`reasoning?: string`).

The loop then **echoes the reasoning back onto the assistant history message**
it pushes: `src/engine/loop.ts:2454-2464` constructs `assistantMessage` with
`reasoning: assistant.reasoning`, so the full thinking text is re-sent on every
subsequent request.

The pricing math makes the double-billing concrete (`src/budget/cost.ts:99-103`
and `src/budget/cost.ts:293-301`): reasoning is billed once as output at
`$0.28/1M`, then re-billed as input on every later turn — `$0.0028/1M` on a
cache hit, `$0.14/1M` on a cache miss. For a reasoning model, the reasoning
string is typically **2-10x the length of the visible output**, so this is the
single largest source of recurring input tokens in a long session. It also
inflates the working context, which forces condensation earlier and makes every
condensation call summarize thinking text that is of no value to keep.

### What to do (in this order)

1. **Measure first.** Pull real numbers from one or two long sessions: the
   per-iteration `[usage] running total` log line already records
   `outputTokens` and `lastPromptTokens` separately
   (`src/engine/loop.ts:2386-2395`). Confirm that output tokens per iteration
   are dominated by reasoning (compare `outputTokens` vs. the actual
   `assistant.content`/tool-call text), and that `lastPromptTokens` grows in
   step with the accumulated reasoning history. Record before/after numbers.
2. **Verify the DeepSeek constraint.** The current comment
   (`src/engine/loop.ts:2454-2457`) claims DeepSeek drops prior reasoning unless
   it is echoed on assistant messages *within tool-call turns*. Establish, with
   a real probe against the pinned endpoint, whether reasoning must be echoed on
   **every** assistant history message, or only on the **immediately-preceding**
   assistant message in the active tool-call chain. The difference decides how
   aggressively reasoning can be stripped.
3. **Strip reasoning where safe.** Based on the probe result, strip
   `reasoning` from assistant history messages that are no longer part of the
   active tool-call chain (the safe minimal case: drop reasoning from any
   assistant message older than the most recent turn, and from any message that
   has been superseded by a condensation summary). This is a pure reduction in
   re-sent input tokens with no behavioral cost if the probe confirms it is
   safe.
4. **Default reasoning effort to `low` for routine work.** The
   `_reasoning_effort` config key already exists and is wired
   (`src/cli.ts:868-869`, `src/llm/openrouter.ts:808-813`), but defaults to
   unset (endpoint default). Evaluate defaulting the `code` mode's effort to
   `low` (or adding a per-mode default) so routine edit/explore turns generate
   less thinking text. Keep `high`/`xhigh` for review/QA/architect roles via the
   existing per-mode mapping.

### What NOT to do

- Do not remove `include_reasoning: true` wholesale without the probe — if
  DeepSeek genuinely requires reasoning to be echoed for tool-call turns, naive
  removal breaks the session with HTTP 400s.
- Do not strip reasoning from the *immediately preceding* assistant message in
  an active tool-call chain until the probe confirms that is safe.
- Do not change the reasoning *pricing* — that is a guardrail table, and the
  numbers in `src/budget/cost.ts:99-103` are already verified against the
  official endpoint.

### Verification checklist

- `npx tsc --noEmit` clean and `npm test` green.
- A real (or e2e mock) session shows `lastPromptTokens` no longer grows with
  accumulated reasoning history, and cache-hit rate (`lastCachedTokens /
  lastPromptTokens`) is unchanged or improved.
- No new HTTP 400 "messages with role tool" or DeepSeek reasoning-drop errors.

---

## Item 2 — Condensation sizing ignores `reasoning`, so it fires too little/too late (implement directly)

### The evidence

`estimateMessageChars` counts only `content` and `tool_calls` — it never looks
at `reasoning` (`src/engine/condense.ts:312-320`). `buildCondenseUserPrompt`
also transcribes `content`/`tool_calls` but not `reasoning`
(`src/engine/condense.ts:170-198`). This matters because:

- `computeCondenseCount` uses `estimateMessageChars` to decide how many messages
  to fold (`src/engine/condense.ts:219-258`), so for reasoning models it
  **under-counts** the real size of the oldest chunk and condenses too little.
- `truncateHistory`'s fallback is message-COUNT based with
  `DEFAULT_WINDOW_SIZE = 300` (`src/engine/loop.ts:199`), so a session whose
  every turn carries a large `reasoning` string can carry far more real tokens
  than the window size intends before anything fires.

### What to do

1. Include `reasoning` length in `estimateMessageChars` (`src/engine/condense.ts:312-320`)
   so condensation/eviction sizing reflects true history size. Keep the estimate
   cheap and monotonic (just add `m.reasoning?.length ?? 0`), matching the
   existing character-length heuristic.
2. Confirm that `computeCondensePlan`'s `conservativeCharsPerToken = 8`
   default (`src/engine/condense.ts:270-280`) is still a reasonable over-estimate
   once reasoning is counted; adjust the constant with a comment if the probe
   from Item 1 shows it should change.
3. Optionally make `buildCondenseUserPrompt` **omit** reasoning from the
   transcript it feeds the condensation model — reasoning is disposable and
   including it only inflates the condensation call's own input cost. (This is
   the correct direction even though Item 2.1 adds it to the *sizing* path: the
   sizing must know about it, the summarizer does not need to read it.)

### What NOT to do

- Do not make `estimateMessageChars` do a real tokenization — keep it a cheap
  character-length estimate, consistent with the existing approach.

### Verification checklist

- New/extended unit test in `src/engine/__tests__/condense.test.ts` asserting
  that a history containing `reasoning` strings yields a larger
  `computeCondenseCount`/`estimateMessageChars` than the same history without
  them.
- `npm test` green; `tsc --noEmit` clean.

---

## Item 3 — Per-iteration checkpoint commit is on the critical path, and fires after read-only turns (implement directly)

### The evidence

After every tool-call turn the loop **awaits** a checkpoint save:
`src/engine/loop.ts:2771-2774` calls `await this.saveIterationCheckpoint(iteration)`.
`saveIterationCheckpoint` (`src/engine/loop.ts:2850-2866`) calls
`checkpointService.save(...)`, which performs a real shadow-git `git add -A` +
commit (`src/checkpoints/service.ts:180-182` → vendored `saveCheckpoint`, with
`stageAll` patched to `git add -A --ignore-errors` at
`src/checkpoints/service.ts:140-150`).

Two separate costs are visible here:

1. **Wall-clock on the critical path.** The `await` means the next iteration's
   LLM call waits for the git commit to finish. A long session (up to
   `DEFAULT_MAX_ITERATIONS = 250`, `src/engine/loop.ts:140`) can do up to 250
   synchronous git commits, each touching the shadow repo's index and worktree.
2. **Snapshots after read-only turns.** The comment at
   `src/engine/loop.ts:2771-2774` snapshots whenever `calls.length > 0` — which
   includes turns that only called `read_file`/`list_files`/`search_files`
   (nothing changed on disk). Those commits are empty (`allowEmpty: true`) and
   pure waste.

### What to do

1. **Skip checkpointing on read-only turns.** Only snapshot when at least one
   edit tool ran (`write_to_file`/`apply_diff`/`search_replace`/`edit_file`, and
   ideally `execute_command` that is NOT read-only-equivalent — reuse
   `isReadOnlyEquivalentShellCommand` at `src/engine/loop.ts:288-336`). This
   alone removes most commits, because exploration dominates the tool-call mix
   (the harness's own comment at `src/engine/loop.ts:272-287` documents that
   `execute_command` is the dominant exploration tool).
2. **Decouple the commit from the LLM critical path.** Checkpoints are already
   non-fatal by contract (`src/engine/loop.ts:2843-2866` wraps save in
   try/catch). Change the save to fire-and-forget (kick off the promise without
   awaiting it, tracking a single in-flight save so writes stay ordered), OR
   throttle to every N edit turns. Keep the baseline snapshot at session start
   synchronous (`src/engine/loop.ts:1227-1230`) since nothing else runs at that
   point.
3. Preserve the restore/diff/list API unchanged — only the *save cadence*
   changes, not the checkpoint format or the shadow-repo layout.

### What NOT to do

- Do not disable checkpoints entirely or change the shadow-repo storage
  location — the restore safety property (`src/checkpoints/service.ts:26-34`) is
  load-bearing.
- Do not drop the baseline checkpoint (`src/engine/loop.ts:1227-1230`) — test
  selection (`getSessionChangedFiles`) depends on it
  (`src/engine/loop.ts:1064-1076`).

### Verification checklist

- `tsc --noEmit` clean, `npm test` green.
- Re-run `scripts/e2e-phase2/run.sh` (spawn/watch flows) since the loop's
  checkpoint behavior is exercised there.
- A session whose turns are all reads produces **no** iteration checkpoints
  beyond the baseline; a session with edits still produces restorable
  checkpoints after each edit turn.

---

## Item 4 — `read_file` default is 2000 lines → up to 30k chars of context per read (measure first)

### The evidence

The vendored `read_file` default is `DEFAULT_LINE_LIMIT = 2000`
(`src/vendor/zoo-code/src/core/prompts/tools/native-tools/read_file.ts:6`), and
the harness's `readFileHandler` defaults `limit` to 2000
(`src/tools/executor.ts:579`). Tool results are then capped at
`MAX_RESULT_CHARS = 30_000` (`src/tools/executor.ts:119`), so a single default
`read_file` can append ~30,000 characters (~7-8k tokens) to history. The
read-cache (`src/tools/executor.ts:472-615`) only helps on *re-reads*, not on
the first read of each distinct file. The harness already logs "default broad
read" as a distinct signal (`src/engine/loop.ts:3381-3383`), which implies this
pattern is common enough to be worth surfacing.

### What to do (in this order)

1. **Measure first.** From real session logs, count how often `read_file` is
   called with no `offset`/`limit` (the `summarizeToolArg` log at
   `src/engine/loop.ts:3361-3400` already distinguishes "default broad read"
   from targeted reads) and how many tokens those results contribute to
   `lastPromptTokens`.
2. **Lower the harness default.** Add a configurable default line limit
   (env/flag, e.g. `HEADLESSCODE_READ_LIMIT`) that overrides the vendored 2000
   with a smaller value (candidate: 500-800) in `readFileHandler`
   (`src/tools/executor.ts:579`). Keep 2000 as an explicit opt-in when the model
   passes a larger `limit`.
3. **Strengthen the indentation-mode nudge.** The vendored tool description
   already says "PREFER indentation mode" (`src/vendor/zoo-code/.../read_file.ts:67-71`),
   but the harness's own rules files are where model behavior actually changes
   (per `.roo/rules/rules.md`'s "a new tool is not done until something tells a
   model to reach for it"). Add a short scannable line to the relevant
   `.roo/rules-code/rules.md` pointing models at indentation mode for targeted
   reads, mirroring the existing `codebase_search` guidance style.

### What NOT to do

- Do not truncate `read_file` results below what a model needs to edit a file —
  a summarized file body would be a correctness hazard (the harness already
  documents this for write/diff content at `src/tools/executor.ts:412-415`).
- Do not change `MAX_RESULT_CHARS` in a way that lets a single result exceed the
  context budget it exists to bound.

### Verification checklist

- `tsc --noEmit` clean, `npm test` green.
- `src/tools/__tests__/read-cache.test.ts` (and any read_file tests) extended to
  assert the new default limit is honored and an explicit `limit` still works.

---

## Item 5 — `switch_mode` rebuilds the entire system prompt + tool catalog even when nothing changes (implement directly)

### The evidence

`handleSwitchMode` recomputes `buildSystemPrompt(...)` and reassembles the full
tool list on every approved switch (`src/engine/loop.ts:3153-3171`), then
replaces `messages[0].content` with the new prompt
(`src/engine/loop.ts:3179-3181`). `buildSystemPrompt` builds the full vendored
`SYSTEM_PROMPT` plus headless conventions plus stack rules
(`src/engine/prompt.ts:273-327`), and the tool list includes the code-intel,
browser, describe-image, and run-tests schemas (`src/engine/loop.ts:1165-1174`).

Two costs:

1. **Cache invalidation.** Replacing `messages[0]` changes the entire cached
   prefix, so the request after every switch is a full-prompt cache miss (full
   input price for the whole fixed prefix, not the `0.0028/1M` cache rate).
2. **Wasted work** when the target mode's effective tool set is identical to the
   current one (e.g. two custom modes that differ only in role text but share
   the same `groups`).

### What to do

1. Compute the target mode's tool list first and compare it to the current
   `this.state.tools` (compare the sorted set of tool names — cheap and
   sufficient). When identical, skip `buildSystemPrompt` and the `messages[0]`
   replacement entirely, and emit a shorter "mode label changed, tool set
   unchanged" result that does not invalidate the cached prefix.
2. When the tool set *does* change, keep the current behavior but consider
   keeping `messages[0]` stable across switches that only change tool
   *availability* by documenting (not necessarily implementing) that the prompt
   could be split into a stable base + a per-mode tools/section appended
   separately. Do not implement that split in this item unless Item 6 first
   establishes the fixed-prefix size is actually worth it.

### What NOT to do

- Do not skip the approval gate or the mode-switch cap — this item only changes
  the *prompt rebuild*, not the security boundary
  (`src/engine/loop.ts:3090-3144`).

### Verification checklist

- `tsc --noEmit` clean, `npm test` green.
- New/extended test in `src/engine/__tests__/switch-mode.test.ts` asserting the
  prompt is NOT rebuilt (and `messages[0]` not replaced) when the target mode's
  tool set equals the current one.

---

## Item 6 — The fixed prompt + tool catalog is large and sent every request (measure first, then decide)

### The evidence

Every main-loop LLM call sends the full system prompt **and** the full tool
catalog: `src/engine/loop.ts:2222-2230` passes `messages` (which begins with the
system prompt) plus `tools: this.state.tools`. The system prompt is the vendored
Zoo Code `SYSTEM_PROMPT` (built at `src/engine/prompt.ts:291-305`), which is a
GUI-oriented prompt including mode/role/tool-group descriptions, then the
headless conventions (`src/engine/prompt.ts:323-324`,
`src/engine/prompt.ts:335-344`) and stack rules
(`src/engine/prompt.ts:310-313`). The tool catalog is ~18-20 schemas: the
vendored native tools plus code-intel (`src/engine/prompt.ts:438-447`), browser
action (`src/engine/prompt.ts:405-410`), describe-image
(`src/engine/prompt.ts:422-427`), and run-tests (`src/engine/prompt.ts:472-477`).

This fixed prefix is cached after the first call, so the steady-state cost is the
cache-read rate — but the **first call of every session** (and every post-switch
call, see Item 5) pays full input price for all of it, and the prefix is still
re-sent byte-for-byte every turn.

### What to do (measure first)

1. **Measure the fixed prefix size.** Use the `--dry-run` path (or a one-off
   script) to print the token size of the built system prompt and the
   `tools` array for the `code` mode. This is already partially wired —
   `src/cli.ts:761-773` resolves the model/effort for dry-run without an LLM
   call; extend it (or a small script) to print prompt+tools character counts.
2. **Decide based on the number.** If the fixed prefix is a material share of
   `lastPromptTokens` on early iterations (e.g. >20k tokens), consider a
   trimmed "headless minimal" system prompt that drops GUI-only vendored
   sections, OR a tool-catalog trim that omits tools the mode will never use
   (the TS-gated code-intel tools are already omitted on non-TS workspaces at
   `src/tools/executor.ts:1777-1799`; check whether the same discipline can be
   extended to browser/describe/run-tests for modes that don't need them).
3. Report the measured number back before any prompt surgery — the tradeoff
   (losing vendored prompt fidelity vs. first-call cost) is a judgment call the
   measurement should inform, not a code change to make blind.

### What NOT to do

- Do not edit the vendored `SYSTEM_PROMPT` in place (vendoring convention,
  `.roo/rules/rules.md`). Any trimming must happen in
  `src/engine/prompt.ts` by wrapping/substituting, not mutating vendored files.

### Verification checklist

- `tsc --noEmit` clean, `npm test` green.
- A recorded before/after measurement of the fixed prefix size, with a written
  recommendation on whether to trim.

---

## Item 7 — Local output summarization is opt-in (default OFF) even though `execute_command` dominates exploration (measure first)

### The evidence

`summarizeCommandOutput` falls back to blunt 30k-char truncation unless local
summarization is enabled (`src/tools/executor.ts:417-430`), and the feature is
gated OFF by default (`src/tools/output-summarizer.ts:101-103`). Yet the
harness's own live-round comment documents that `execute_command` is the
dominant exploration tool, and large noisy command output (verbose test runs,
big greps, install logs) is the canonical case the summarizer exists for
(`src/tools/output-summarizer.ts:5-14`). Blunt truncation discards everything
past 30k chars — including, sometimes, the one relevant line.

### What to do (measure first)

1. **Measure the token cost** of the current default: from real session logs,
   sum the `execute_command` result sizes that hit the 30k cap and estimate how
   many input tokens those re-sent outputs add across a session.
2. **Run an A/B with `HEADLESSCODE_LOCAL_SUMMARIZATION=1`** on a comparable
   session, and compare `lastPromptTokens` growth + wall-clock (the local
   summarizer adds a 1-2s warm call per oversized result per
   `src/tools/output-summarizer.ts:42-45`).
3. **If the token savings are material and the latency is acceptable**, flip the
   default to ON for `execute_command` output only (the summarizer is already
   correctly scoped to command output, never file/diff content —
   `src/tools/executor.ts:412-415`). Keep the env var as an opt-out.

### What NOT to do

- Do not extend summarization to `read_file`/diff/write content — a summarized
  file body or diff would be a correctness hazard (already documented at
  `src/tools/executor.ts:412-415`).

### Verification checklist

- `tsc --noEmit` clean, `npm test` green.
- `src/tools/__tests__/local-summarization-gate.test.ts` and
  `src/tools/__tests__/output-summarizer.test.ts` extended for the new default.

---

## Item 8 — No default `max_tokens` cap on the main call or the condensation call (implement directly)

### The evidence

The main call sends `maxTokens: this.config.maxTokens`, which is `undefined`
unless a caller/flag sets it (`src/engine/loop.ts:2227`), and `buildRequestBody`
only emits `max_tokens` when it is present (`src/llm/openrouter.ts:763-765`).
The condensation call has the same shape: `maxTokens: options.maxTokens`
(`src/engine/condense.ts:350`), defaulting to `config.condenseMaxTokens ??
config.maxTokens` (`src/engine/loop.ts:1666`), both of which are commonly
`undefined`. The summary is hard-capped at `MAX_CONDENSED_MESSAGE_CHARS = 16_000`
*after* generation (`src/engine/condense.ts:118`, `src/engine/condense.ts:362-366`),
so an unbounded generation can be produced and then rejected.

For a reasoning model an unbounded generation is a long-tail cost/latency risk
with no steady-state benefit. A small default cap bounds the worst case.

### What to do

1. Add a default `condenseMaxTokens` (candidate: 4096) so the condensation call
   always sends `max_tokens`, independent of the session's own `maxTokens`.
   Wire it where the resolved config defaults are set (`src/engine/loop.ts:977-978`)
   and pass it through the two call sites that currently use
   `config.condenseMaxTokens ?? config.maxTokens` (`src/engine/loop.ts:1666`,
   `src/engine/loop.ts:1897`, `src/engine/loop.ts:2139`, `src/engine/loop.ts:2151`).
2. Add a sane default `maxTokens` for the main call (or, less intrusively,
   surface a clear warning in `--dry-run` when it is unset) so long-tail output
   is bounded. Make it overridable via the existing flag/env plumbing.

### What NOT to do

- Do not set the main-call cap so low that legitimate multi-file write turns
  truncate mid-tool-call — reasoning models generate long tool-call turns by
  design (the timeout comment at `src/engine/loop.ts:200-207` documents this).
  Choose a value well above typical output and validate against a real session.

### Verification checklist

- `tsc --noEmit` clean, `npm test` green.
- New/extended tests asserting `buildRequestBody` includes `max_tokens` for the
  condensation path even when the session has no `maxTokens`.

---

## Common verification bar (every item)

Before any item is considered done:

- `npx tsc --noEmit` must be clean.
- `npm test` must pass in full (hand-rolled `assert` + `tsx`; add new test files
  to the `test` script in `package.json`).
- Items touching `src/engine/loop.ts` or `src/engine/condense.ts`: also re-run
  `scripts/e2e-phase2/run.sh` (loop/condense/spawn/watch flows against a mock
  LLM server) if the change alters loop behavior or message history shape.
- Items touching `src/orchestrator/`, `src/watcher/`, or `scripts/*.sh`: re-run
  the relevant `scripts/e2e*/run.sh` suites.

## What to report back

For each completed item, report:

1. The measured before/after numbers (for "measure first" items, this is the
   actual deliverable, not just the code).
2. The exact `file:line` of each change (the worker reading this has no other
   context; cite real locations).
3. Which suites you ran and their results (`tsc`, `npm test`, `e2e*`).
4. Any behavior change that affects prompt-cache stability (items 1, 2, and 5
   all touch the sent prefix) and the measured effect on cache-hit rate.
5. The final commit hash(es) and branch name.
