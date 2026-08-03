# `switch_mode` — a real headless-native implementation (not a stub) — design + implementation instructions

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI that runs a headless coding-agent loop (ported
from a VS Code extension called Zoo Code, vendored under `src/vendor/zoo-code/`).
The full original source is also available for reference (read-only, do not
edit) at `zoo-code/` in this repo.

Match this project's established style: no test framework (plain `tsx`-run
test files, hand-rolled `assert`, `All N tests passed` trailer); `npx tsc
--noEmit` and `npm test` must stay green; re-run every e2e suite under
`scripts/e2e*/run.sh` afterward.

**This task changes core loop semantics (`src/engine/loop.ts`) and adds a new
blocking human-escalation path. Read this whole document before writing any
code — the design section below is not optional background, it's the actual
spec.** Also read `plans/recursive-orchestrator-mode.md` in full before you
start — it is the closest prior art in this repo (the `new_task` tool, which
this task's mode-resolution logic and session-level-handler pattern directly
reuse) and this document assumes you've read it.

## Why this exists

The project owner wants the headless harness to support the same "start in
one mode, pivot into another mode mid-session" workflow the interactive Zoo
Code GUI supports — e.g. Architect mode gathering context and then handing
off to Code mode to actually implement, all in the SAME conversation, not a
new one.

This is deliberately **not** the same thing as `new_task`/Orchestrator mode
(already implemented — see `plans/recursive-orchestrator-mode.md`). `new_task`
spawns a scoped CHILD session that runs to completion and returns a result;
the parent's own mode never changes. `switch_mode` is different: the
CURRENT, already-running session's own active mode changes in place — same
message history, same iteration count, same budget, just a different
system prompt / tool set / role from that point forward. Both are legitimate
and should coexist; do not conflate them or try to reimplement one in terms
of the other.

The tool's schema is already vendored verbatim
(`src/vendor/zoo-code/src/core/prompts/tools/native-tools/switch_mode.ts` —
`{mode_slug, reason}`, both required) and is currently in the stub set in
`src/tools/executor.ts` (`IMPLEMENTED_TOOLS` does not include it — calling it
returns "not implemented"). This task replaces the stub with a real
implementation.

## Read this before designing anything: the GUI's approval gate is the crux

The vendored tool's own description says it plainly: *"The user must approve
the mode switch."* In the VS Code extension, this is a real modal-ish
approval UI — the user can accept or reject the switch before it happens.
There is no webview here, but **do not read that as license to silently
auto-approve every switch** — the approval gate is not incidental UI
polish, it is the actual security boundary: a mode like Architect is
deliberately restricted (`groups: ["read", ["edit", {fileRegex: "\\.md$"}],
"mcp"]` — see `src/vendor/zoo-code/types/mode.ts` for all `DEFAULT_MODES`)
specifically so it *can't* edit arbitrary source files on its own; letting
it silently grant itself Code mode's full edit permissions on request
defeats that boundary entirely.

This repo already has a real headless-native answer to "the model needs a
human decision and there's no webview": `ask_followup_question`'s decision-
escalation mechanism (`src/tools/executor.ts`, search `NEEDS_DECISION_FILENAME`
/ `askFollowupQuestionHandler`). It writes `<workspaceRoot>/.harness.needs-
decision` (JSON: question, suggestions, askedAt), polls for
`<workspaceRoot>/.harness.decision-answer` up to a configurable timeout
(default 30 min, `DEFAULT_DECISION_TIMEOUT_MS`), pauses the session's
budget-duration clock for the wait (`ctx.pauseBudgetClock`/
`resumeBudgetClock`), and is already wired into `src/orchestrator/watch.ts`
(a group with this marker present is reported as `"blocked"` in
`.orchestrator-state.json`, with the question text attached) and
`scripts/headlesscode-answer.sh` (a human/orchestrator writes the answer
file to unblock it).

**Reuse this exact mechanism for `switch_mode`'s approval, do not invent a
parallel marker-file pair.** Concretely: escalate a question shaped like
`Switch from mode '<current>' to mode '<mode_slug>'? Reason: <reason>` with
suggestions `["approve", "deny"]`, through the SAME
`.harness.needs-decision` / `.harness.decision-answer` files and the same
poll/timeout/pause-clock plumbing. This gets you, for free, with no new
code in `watch.ts`, `status.ts`, or the dashboard: the switch request shows
up as a normal `"blocked"` group in `orchestrate status`, and
`scripts/headlesscode-answer.sh` already works to approve/deny it (a human
just writes `"approve"` or `"deny"` — or any text starting with "approve"/
"yes", case-insensitive — as the answer).

You will need to factor the marker-write/poll/timeout logic out of
`askFollowupQuestionHandler` into something both handlers can call (a small
shared helper — your call on its exact shape, e.g. `escalateDecision(ctx,
question, suggestions): Promise<{answer: string} | {timedOut: true}>`) —
don't duplicate that logic, and don't break `ask_followup_question`'s
existing behavior or its own tests while refactoring.

## The one deliberate divergence from `ask_followup_question`: fail CLOSED, not open

`ask_followup_question` times out to "model must decide autonomously" — a
reasonable fallback when the cost of guessing wrong is usually low (the
model picks an answer to a question about approach, style, etc.).
`switch_mode` is different: a timed-out or malformed answer must **deny the
switch and keep the session in its current mode**, returning a clear tool
error the model can react to (e.g. "mode switch to 'code' was not approved
within the timeout; continue in your current mode, or ask a human directly
via ask_followup_question if this is blocking your progress"). Silently
granting the switch on timeout would mean an unattended, never-approved
request eventually succeeds anyway — exactly the failure mode the approval
gate exists to prevent. Justify this choice explicitly in your report; it's
a deliberate, spec-mandated deviation from the sibling tool's precedent, not
something you get to silently pick either way.

## Unattended rounds need an opt-out, or this stalls every orchestrator run for 30 minutes

Given the fail-closed default above, an operator running a fully unattended
`headlesscode orchestrate` round with no human watching would have any
`switch_mode` call hang for the full timeout and then get refused — not
great for a legitimate, pre-approved workflow (e.g. "this project's
Architect-then-Code handoff is always fine, don't make me answer it every
time"). Add an explicit, off-by-default opt-in to auto-approve without
escalating at all:
- A new `HeadlessSessionConfig` field, e.g. `autoApproveModeSwitch?:
  boolean` (default `false`).
- A matching CLI flag (e.g. `--auto-approve-mode-switch`) and env var (e.g.
  `HEADLESSCODE_AUTO_APPROVE_MODE_SWITCH=1`) wired through `src/cli.ts` the
  same way other boolean toggles in this file already are — grep the file
  for an existing simple boolean flag (e.g. how `--dry-run` or `--qa` is
  parsed) and follow that precedent.
- When set, `switch_mode` performs the mode change immediately with no
  marker file, no poll, no wait — just log it and emit the event (see
  below) so it's still auditable, just not gated.

Document your reasoning on where this flag lives (session config vs. only a
CLI/env toggle) in your report.

## The headless-native design: how the switch actually takes effect

Read `HeadlessSession.run()` (`src/engine/loop.ts`, starting ~line 714)
before writing the handler. Relevant existing facts you need to rely on,
not rediscover:

- `this.state.mode`, `this.state.tools`, `this.state.systemPrompt`,
  `this.state.messages` already exist as mutable session state (see the
  `state` initialization ~line 700 and the `SessionState` type ~line 372).
- Each LLM call inside the iteration loop reads `tools: this.state.tools`
  fresh (line ~1304) — it is NOT a value closed over once at session start.
  This means mutating `this.state.tools` mid-session is sufficient for the
  very next iteration's LLM call to see the new tool set; you do not need
  to restart or reconstruct the iteration loop.
- The system prompt is seeded once as `messages[0] = { role: "system",
  content: systemPrompt }` (line ~745) and is otherwise just a regular
  entry in `this.state.messages`.
- `new_task`'s mode resolution precedent (`handleNewTask`,
  `src/engine/loop.ts` ~line 1696): `getModeBySlug(mode, this.customModes)
  ?? modes.find((m) => m.slug === mode)`, refusing an unknown slug as a
  normal tool error. Reuse this exact resolution for `switch_mode` too —
  same known-modes error message shape.
- `new_task` is registered on the executor as a session-bound handler
  (`this.executor.register("new_task", (args) => this.handleNewTask(args))`,
  line ~687) rather than in `src/tools/executor.ts`'s stateless factory,
  because it needs access to session state. `switch_mode` needs the same —
  register it the same way (`handleSwitchMode`), and add `switch_mode`
  wherever `new_task` was added to `IMPLEMENTED_TOOLS` in
  `src/tools/executor.ts` (see that file's own comment noting `new_task` is
  "implemented by HeadlessSession itself" for the precedent to follow).

### What `handleSwitchMode` must actually do, in order

1. Parse `mode_slug` and `reason` from args; both required per the vendored
   schema (`additionalProperties: false`) — a missing/blank one is a normal
   tool error, not a crash.
2. Resolve `mode_slug` via the `new_task` precedent above. Unknown slug →
   tool error listing known modes, no escalation, no state change.
3. Switching to the mode the session is ALREADY in: treat as a harmless
   no-op tool error ("already in mode 'X'") rather than escalating a
   pointless approval request — your call on the exact wording.
4. A hard cap on total switches per session (mirrors `new_task`'s
   recursion-depth cap, same rationale: bound worst-case cost/thrash, not
   just infinite loops). Add a small counter (e.g.
   `this.modeSwitchCount`) and a config field (e.g. `maxModeSwitches`,
   default your call — justify it) — exceeding it is a normal tool error,
   not a crash, and does not escalate.
5. Approval: if `config.autoApproveModeSwitch` is not set, escalate via the
   shared decision-escalation helper (see above) and wait for an answer
   (or timeout). If it times out, or the answer text does not start with
   "approve"/"yes" (case-insensitive), refuse with a clear tool error and
   make NO state changes — session stays in its current mode. Log both
   outcomes distinctly (approved vs. denied vs. timed out) via
   `this.logger`.
6. On approval (or `autoApproveModeSwitch`): perform the actual switch —
   - Recompute the system prompt for the new mode the same way `run()`
     does at session start (`buildSystemPrompt({ workspaceRoot, mode:
     newMode, customModes: this.customModes, globalCustomInstructions:
     this.config.globalCustomInstructions })`).
   - Recompute the tool list for the new mode the same way `run()` does
     (`appendCodeIntelTools(appendDescribeImageTool(appendBrowserActionTool(
     selectToolsForMode(newMode, this.customModes))))` — check whether
     `this.config.tools` override should still win here, same as it does
     at session start, and preserve that precedent).
   - Update `this.state.mode` and `this.state.tools` to the new values.
   - Do **not** silently overwrite `messages[0]`'s content in place — the
     model's own transcript should show the switch actually happened,
     not have its history quietly rewritten underneath it (compare
     `plans/local-explore-phase-experiment.md`'s convention of folding in a
     "clearly-labeled synthetic message" rather than mutating history
     invisibly). Update `messages[0].content` to the new system prompt
     (the "living" system prompt each LLM call sees), AND push a visible
     marker message (e.g. `{ role: "user", content: "[mode switched:
     <old> -> <new>. Reason: <reason>]" }`) so the transcript is honest
     about when and why the switch happened. Your call on the exact
     message shape; just make sure it's genuinely visible in
     `this.state.messages`, not just in a log line.
   - Emit an event for observability: add a new `EventFeed` method (e.g.
     `modeSwitched(fields: { from: string; to: string; reason: string;
     autoApproved: boolean })`, following the existing method shapes in
     `src/engine/events.ts` — see `decisionBlocked`/`decisionAnswered` for
     the pattern) and call it via `this.emitEvent(...)`, non-fatal like
     every other event emission in this file.
   - Return a normal (non-error) tool result confirming the switch, e.g.
     `"Switched to mode 'code'. Reason acknowledged: <reason>"`.
7. `new_task` enforces "must be called alone" at the loop level because the
   vendored description mandates it and the handler can't see sibling
   calls in its own batch (`src/engine/loop.ts` ~line 1432, the
   `refusedNewTaskIds` mechanism). The vendored `switch_mode` schema does
   NOT state this constraint explicitly, but decide for yourself whether
   it should be enforced anyway to avoid two escalations (e.g. a
   `switch_mode` and an `ask_followup_question`) racing to write the same
   `.harness.needs-decision` marker in the same turn. Read how `calls` are
   executed (sequentially in a `for` loop, per the code around line 1482)
   to determine whether a genuine race is even possible here, and document
   your conclusion either way in your report — don't just silently assume.

## Scope boundary: read-only executors are untouched

`switch_mode` should remain a stub (not implemented) in the READ-ONLY
reviewer/QA executor (`src/tools/executor.ts` — search "READ-ONLY executor
for the reviewer mode"). Those executors exist specifically to prevent role
expansion (see that file's own comments on why `write_to_file` is absent
entirely there); a reviewer or QA session requesting a mode switch to gain
edit tools would be exactly the privilege escalation that executor is
designed to prevent. Confirm this stays stubbed there and say so explicitly
in your report — do not silently change it without flagging the decision.

## What NOT to do

- Do not conflate this with `new_task` — no new child session, no new
  process, no new worktree; this mutates the CURRENT session in place. If
  you find yourself wanting to construct a `HeadlessSession`, you've
  misread the design.
- Do not invent a new marker-file pair for the approval gate — reuse
  `.harness.needs-decision` / `.harness.decision-answer` and the existing
  poll/timeout/pause-clock plumbing (factored out, not duplicated).
- Do not silently auto-approve every switch by default — the fail-closed
  default and the explicit off-by-default opt-in flag are the actual point
  of this task, not optional hardening.
- Do not rewrite `messages[0]`'s content silently without also leaving a
  visible marker in the transcript — see the transcript-honesty
  requirement above.
- Do not touch `headlesscode orchestrate`, `spawn-parallel-worktrees.sh`,
  `watch.ts`'s own status-detection logic, or the dashboard UI — reusing
  the existing decision-escalation marker files means all of that already
  works unmodified; you should not need to touch any of those files at
  all. If you find yourself needing to, stop and reconsider the design
  first.
- Do not silently harden or change tool-execution enforcement for OTHER
  modes' restricted groups (e.g. making the executor reject calling
  `write_to_file` while nominally in `ask` mode) — that enforcement is
  currently soft (advertisement-only: a mode's `groups` control what's
  advertised to the model via `selectToolsForMode`, not what the executor
  will actually run if called anyway) for every mode already, not just a
  gap this task introduces. Note it in your report as a pre-existing,
  out-of-scope observation if you notice it; do not attempt to fix it here.

## Tests

New `src/engine/__tests__/switch-mode.test.ts` (mirror the structure and DI
patterns of `src/engine/__tests__/new-task.test.ts` — same `FakeLlmClient`
scripting approach):
- Happy path with `autoApproveModeSwitch: true`: a `switch_mode` call
  immediately switches `this.state.mode`/`this.state.tools`, the visible
  transcript marker message is present, the `modeSwitched` event fires with
  the right `from`/`to`/`reason`/`autoApproved: true`, and the NEXT LLM
  call in the same session is made with the new mode's tool list (assert
  on what `FakeLlmClient` actually received, not just internal state).
- Approval path: `autoApproveModeSwitch` unset (or `false`), a
  `.harness.decision-answer` of `"approve"` written during the wait results
  in the switch happening exactly like the auto-approve case, with
  `autoApproved: false` in the event.
- Denial path: an answer of `"deny"` (or anything not starting with
  approve/yes) results in a tool error, `this.state.mode`/`tools` UNCHANGED,
  and no transcript marker added.
- Timeout path: no answer file ever appears within a short test timeout
  (inject a short `decisionTimeoutMs`/poll interval like the existing
  `ask_followup_question` tests do) — same result as the denial path, plus
  confirm the marker files are cleaned up.
- Unknown `mode_slug`: immediate tool error, no marker file written at all,
  no escalation, no wait.
- Already-in-that-mode: immediate no-op tool error, no escalation.
- Max-switches cap: exceeding the configured limit is a normal tool error
  (recoverable — assert the session continues afterward), not a crash.
- Confirm the READ-ONLY reviewer/QA executor still returns "not
  implemented" for `switch_mode` (a one-line regression test is enough).
- Confirm `ask_followup_question`'s own existing tests still pass unchanged
  after your refactor of the shared escalation helper.

## Verification checklist

1. `npx tsc --noEmit` clean.
2. `npm test` — all suites green including new ones. Add the new test file
   to the `test` script in `package.json` (grep how the last few test files
   were added there for the exact format).
3. Every e2e suite under `scripts/e2e*/run.sh` still passes.
4. Manual: run a short local session (fake or real LLM, your choice) that
   calls `switch_mode`, write the answer file by hand via `scripts/
   headlesscode-answer.sh` while it's blocked, and confirm it unblocks and
   the mode actually changes for the rest of the run. If you have real
   OpenRouter access, a real end-to-end run is preferred; if not, say so
   plainly and describe what you verified instead (this mirrors the bar set
   in `plans/recursive-orchestrator-mode.md`'s own verification checklist).

## What to report back

- Files changed/added.
- Your reasoning for the fail-closed-on-timeout choice being implemented
  exactly as specified (this section is not a place to silently pick fail-
  open instead — if you think fail-open is actually right, say so
  explicitly and why, don't just implement it quietly).
- Your reasoning for the default `maxModeSwitches` cap.
- Where you put the `autoApproveModeSwitch` toggle (config field / CLI flag
  / env var) and how they interact if more than one is set.
- Confirmation that the shared escalation helper is genuinely shared (not
  duplicated) between `ask_followup_question` and `switch_mode`, and that
  `ask_followup_question`'s own tests still pass.
- Confirmation of tsc/test/e2e results (actual pass/fail counts).
- Whether the manual smoke test in the verification checklist was run
  against a real API or not, and why.
- Your conclusion on the "must switch_mode be called alone" question
  (point 7 under "What `handleSwitchMode` must actually do") and why.
- Explicit confirmation that read-only reviewer/QA executors still stub
  `switch_mode`.
- Any deviation from this spec, and why — especially if you found a reason
  the in-place-mutation design doesn't hold up for some case this document
  didn't anticipate; flag it rather than forcing a bad fit.
- Anything you noticed while doing this that looks like a related bug or
  gap, even if unfixed (e.g. the pre-existing soft tool-enforcement gap
  noted above, if you hit it).
