# Recursive task decomposition (`new_task`) — a headless-native port, not a literal one — design + implementation instructions

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

**This task changes core loop semantics (`src/engine/loop.ts`). Read this
whole document before writing any code — the design section below is not
optional background, it's the actual spec.**

## Why this exists

Today, every headless worker (`--mode code`, spawned via `run-worker.sh` or
`headlesscode orchestrate`) is a flat executor: one task, one linear tool-call
loop, `attempt_completion` or bust. The project owner has asked for workers
to be able to decompose a task further themselves — mid-session, spin off a
focused sub-task (possibly in a different mode), get its result back, and
keep going — the way Zoo Code's interactive GUI supports via its `new_task`
tool and "Orchestrator" mode pattern (sometimes called "boomerang tasks").

The `new_task` tool's schema is already vendored verbatim
(`src/vendor/zoo-code/src/core/prompts/tools/native-tools/new_task.ts` —
`{mode, message, todos}`, `strict: true`, all three in `required`) and is
currently in the stub set in `src/tools/executor.ts` (`IMPLEMENTED_TOOLS`
does not include it — calling it returns "not implemented"). This task
replaces the stub with a real implementation.

## Do NOT literally port Zoo Code's GUI implementation — read why first

Before designing anything, read `zoo-code/src/core/tools/NewTaskTool.ts` and
`zoo-code/src/core/webview/ClineProvider.ts`'s `delegateParentAndOpenChild`
method (~line 3525) to see what the interactive extension actually does. It
is **not** a simple function call: it pauses and fully disposes the parent
task, persists a `historyItem.awaitingChildId` marker to disk, opens the
child as the webview's "sole active task" (a UI concept — VS Code shows one
task's chat view at a time), runs it there, and resumes the parent later via
a task-scheduler + rollback-on-failure mechanism, all coupled to
`vscode.ExtensionContext` persisted state and a webview provider. None of
that exists here, and porting it verbatim would mean re-inventing a
persisted-task-history subsystem and a scheduler this project has no other
use for. **This is a case where the right move is a headless-native
reimplementation of the same underlying idea (delegate a scoped sub-task,
get its result, resume), not a line-by-line port** — unlike, say,
`apply_diff`'s diff-matching engine, which WAS ported verbatim because it's
pure logic with no VS Code coupling. Say so explicitly in your report so
this deliberate deviation from this project's usual verbatim-port convention
is on record, not silently assumed.

## The headless-native design

`HeadlessSession.run()` (`src/engine/loop.ts:365`) is already a single
synchronous loop in one process — there is no "webview" to swap. That makes
the natural headless equivalent of "delegate to a child task, get the result
back" a **synchronous, in-process nested `HeadlessSession` call**: when the
model calls `new_task`, construct a new `HeadlessSession` for the child
task/mode, run it to completion (blocking — this is exactly like a recursive
function call, not a fork), and feed its outcome back as this tool call's
`tool` result content. The parent's own loop simply continues on its next
iteration once the child returns, with no separate process, no worktree, no
scheduler.

This is a genuinely different granularity from what `headlesscode
orchestrate` already does. Do not conflate them:
- **`orchestrate`** = separate OS processes, separate git worktrees, for
  independent, genuinely parallel units of work (e.g. different GitHub
  issues). Keep this as-is.
- **`new_task`** (this task) = in-process, sequential, same-worktree
  decomposition of ONE worker's own task into sub-steps it delegates to
  itself. No new process, no new worktree, no parallelism — the parent
  literally blocks on the child, same as a function call blocks on its
  return.

### What to build

**1. Recursion depth + a hard cap.** Add `parentSessionId?: string` and
`recursionDepth?: number` (default 0) to `HeadlessSessionConfig`
(`src/engine/loop.ts`). A new `--max-recursion-depth` CLI flag / config
field, default small (2 or 3 — pick one and justify it in your report; this
bounds worst-case cost, not just infinite loops). When a `new_task` handler
would create a child at `recursionDepth >= maxRecursionDepth`, refuse with a
clear tool error ("max recursion depth reached, cannot delegate further —
complete this step yourself") instead of recursing — this must be a normal
tool error (counts toward `consecutiveMistakes` like any other), never a
crash.

**2. Budget/cost containment — do not let recursion silently blow past a
budget.** Read `src/budget/budget.ts`'s `BudgetTracker` (`record()`,
`totalCostUsd`, `iterationCount`, the pause/resume clock hooks already used
by decision-escalation). A child session's LLM usage must count against the
**same** budget as its parent, not a separate untracked one — otherwise a
worker with a $0.50 cap could spawn children that each independently spend
up to $0.50, blowing the real total silently. The cleanest approach: thread
the SAME `BudgetTracker` instance down into the child `HeadlessSession`
(add an internal constructor path/option for this — don't expose it as a
new public config field if it's purely internal plumbing) rather than each
session creating its own from `config.budget`. Verify this with a test that
proves a shared budget cap trips from the child's own spending, not just the
parent's.

**3. Iteration containment.** Similarly, a child's `maxIterations` should be
bounded so recursive delegation can't let a child (or a grandchild, etc.) run
away independently of the parent's own iteration budget. A reasonable
default: a child's `maxIterations` defaults to some fraction of the parent's
remaining budget (your call — document the reasoning), overridable if the
model explicitly needs more room for a genuinely large sub-step, but never
unbounded-by-default.

**4. Checkpoints.** Read `src/checkpoints/service.ts`'s and
`HeadlessSession.initCheckpoints`/`saveIterationCheckpoint`
(`src/engine/loop.ts`, search "Checkpoints:"). A child session editing files
should still checkpoint — reuse the SAME shadow-git checkpoint service
instance/session lineage as the parent (checkpoints are keyed by
`workspaceRoot`, not by a specific session id being the "owner"), so a
child's edits are checkpointed into the same restorable history as the
parent's, not a disconnected one. Tag checkpoint commit messages with the
child's task id for traceability (`Task: <parentId>/<childId>, ...` or
similar — your call on the exact format, just make parent/child lineage
visible in `headlesscode checkpoints list`).

**5. Event feed integration.** `plans/realtime-monitoring.md` already landed
(`src/engine/events.ts`, `EventFeed`, `.headlesscode/events/<sessionId>.jsonl`
— re-read its final merged form, not this summary). Add `parentSessionId` and
`recursionDepth` fields to child sessions' events (extend `EventRecord`'s
optional fields, don't break the existing shape) so the dashboard can
eventually render parent/child nesting — you are not required to build that
UI in this task, just make sure the data is there and doesn't collide with
the parent's own event stream (children get their own
`.jsonl` file under their own session id, same as any session — just with
the new lineage fields populated).

**6. The `new_task` tool handler itself.** In `src/tools/executor.ts`:
- Resolve the target `mode` the same way top-level session mode resolution
  already works (`loadCustomModes`/`selectToolsForMode` in
  `src/engine/prompt.ts`) — an invalid mode slug is a normal tool error, not
  a crash.
- Construct and run the child `HeadlessSession` synchronously (see design
  above), passing through: same `workspaceRoot`, same `llmClient`, same
  `permissions`, shared budget tracker (per #2), bumped `recursionDepth`,
  `parentSessionId` set to the calling session's id, `taskText` = the
  model's `message` arg, `maxIterations` per #3.
- On child success (`attempt_completion`): return the child's result text as
  this tool call's result content (`isError: false`).
- On child failure (bounded failure, budget, max-recursion-depth refused
  one level down, etc.): return a clear, honest error result — do not
  pretend a failed child succeeded, and do not silently swallow the failure
  reason. The parent model needs the real outcome to decide what to do next.
- Enforce the vendored tool description's own constraint — "This tool MUST
  be called alone. Do NOT call this tool alongside other tools in the same
  message turn." If the model calls `new_task` alongside other tool calls in
  one assistant turn, do not silently execute all of them: return a tool
  error for `new_task` specifically (and let the other calls in that turn
  execute normally) telling the model to call it alone next time. Decide
  exactly where this check belongs (the handler itself, since it has access
  to what else was in the batch — check how `calls`/`parseToolCalls` flow
  through `src/engine/loop.ts` around line 809 to see if the handler can see
  its sibling calls, or if this needs a small loop-level check instead) and
  document your choice.
- Move `new_task` from the stub set into `IMPLEMENTED_TOOLS` in
  `createHeadlessExecutor` (check this file's current structure — don't
  assume where to add it, `read_file_cache`/`codebase_search` were both
  added to this same set recently, follow that precedent).

## What NOT to do

- Do not touch `headlesscode orchestrate`, `spawn-parallel-worktrees.sh`, or
  anything process/worktree-level — genuinely separate concern, see the
  granularity distinction above.
- Do not implement a "pause the parent, child becomes sole active session"
  UI concept — there is no UI here; the synchronous nested-call design above
  IS the headless equivalent, already complete on its own.
- Do not build cross-session state persistence (Zoo Code's
  `historyItem.awaitingChildId` disk-persisted resume mechanism) — a
  synchronous call doesn't need it; the parent's call stack IS the resume
  state.
- Do not let a child's budget/iterations be unbounded-by-default — #2 and
  #3 above are not optional hardening, they're the actual point of this
  task; an ungoverned recursive delegation tool is a real way to
  accidentally spend a lot of money fast.

## Tests

New `src/engine/__tests__/new-task.test.ts` (or extend the existing loop
test suite if that fits better — check current structure first):
- A `new_task` call spawns a child session (inject a `FakeLlmClient` scripted
  for both parent and child turns, same DI pattern every other loop test
  uses), the child completes via `attempt_completion`, and its result text
  shows up as the `new_task` tool's result in the parent's history.
- Recursion depth: a child that itself calls `new_task` at the configured
  max depth gets refused with a clear tool error, not a crash — assert the
  parent's session still continues normally afterward (the refusal is a
  recoverable mistake, not fatal).
- Budget sharing: construct a session with a small cost cap, script the
  child to spend enough (via fake usage) to trip it — assert the budget
  error surfaces correctly and reflects TOTAL (parent + child) spend, not
  just the parent's.
- `new_task` called alongside another tool call in the same turn: assert it
  is refused with the "must be called alone" error while the other call in
  that turn still executes.
- Checkpoints: a child session's file edit produces a checkpoint visible in
  the same shadow-git history as the parent's (list checkpoints after, prove
  the child's commit is there, tagged with its lineage).
- Child session failure (bounded failure): parent receives an honest error
  result, not a fabricated success.

## Verification checklist

1. `npx tsc --noEmit` clean.
2. `npm test` — all suites green including new ones.
3. Every e2e suite under `scripts/e2e*/run.sh` still passes.
4. If you have real OpenRouter API access: run one real short session where
   the task explicitly asks the model to delegate a sub-step via `new_task`,
   and confirm in `harness.log`/the event feed that a child session actually
   ran and its result flowed back. If you do NOT have real API access, say
   so plainly and describe what you verified instead.

## What to report back

- Files changed/added.
- Your reasoning for the default `--max-recursion-depth` and the child
  iteration-budget fraction (#1 and #3) — these are real judgment calls
  this spec deliberately left to you, explain them.
- Confirmation of tsc/test/e2e results (actual pass/fail counts).
- Whether the manual smoke test was run against a real API or not, and why.
- Explicit confirmation that budget sharing actually works (quote the test
  proving it, not just "I implemented it").
- Any deviation from this spec, and why — especially if you found a reason
  the synchronous-nested-call design doesn't hold up for some case this
  document didn't anticipate; flag it rather than forcing a bad fit.
- Anything you noticed while doing this that looks like a related bug or
  gap, even if unfixed.
