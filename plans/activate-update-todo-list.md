# Activate update_todo_list — a real structured-planning aid, honestly evaluated — instructions for implementation

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI running a headless coding-agent loop. The
harness currently runs a pure ReAct loop (reason/act, repeat) with no
structural aid beyond the model's own judgment about what to do next. Zoo
Code's real `update_todo_list` tool — a lightweight, model-maintained
markdown checklist, fully vendored in this project already
(`src/vendor/zoo-code/src/core/prompts/tools/native-tools/update_todo_list.ts`
— read its full description, it's the actual tool contract, don't
re-derive it) — is NOT currently in `code` mode's active tool set (confirmed
2026-08-02: `selectToolsForMode("code", [])` returns 10 tools, this isn't
one of them). This task activates it and, critically, evaluates honestly
whether it actually helps — same rigor as every other experimental change
in this project (`local-output-summarization`, `local-explore-phase-experiment`):
build it, measure it for real, report honestly even if the honest answer is
"didn't clearly help."

Match this project's established style: no test framework (plain `tsx`-run
test files, hand-rolled `assert`, `All N tests passed` trailer); `npx tsc
--noEmit` and `npm test` must stay green; re-run every e2e suite under
`scripts/e2e*/run.sh`.

## What to build

### 1. A handler for `update_todo_list`

In `src/tools/executor.ts`: a handler that accepts the `todos` markdown
checklist string (per the vendored tool's exact schema — `{todos: string}`,
`strict: true`, required), stores the current todo state for the session
(in-memory on the executor/session, not written to disk as a real file —
this is conversational state, not a workspace artifact), and returns a
simple confirmation (echo the parsed checklist back, or a short
acknowledgment — check whether the vendored tool's own description implies
a specific expected result shape, and match it if so). Move `update_todo_list`
from the stub set into `IMPLEMENTED_TOOLS` and register it for `code` mode
(check `createHeadlessExecutor`'s current structure for where to add it,
following the precedent of every other tool added to this set recently).

### 2. Surface the current todo state for observability

Emit an event (e.g. `todo_updated`, with the parsed checklist and/or a
simple done/in-progress/pending count) to the session's event feed
(`src/engine/events.ts`) each time the tool is called, following the exact
pattern already established for `tool_call`/`checkpoint_saved` events. This
is what makes the feature's actual effect visible/measurable, not just a
tool the model can call into a void — and it's a natural complement to
`plans/work-progress-visualization.md` if that task is running concurrently
(see note below), though this task's own scope does NOT include building
dashboard UI for it — event emission only.

### 3. System-prompt/mode guidance on when to use it

The vendored tool's own description already states clear "when to use /
when NOT to use" guidance (multi-step complex tasks vs. trivial
single-step ones) — confirm this description is what actually reaches the
model (it should be, since tool descriptions are sent as part of the
`tools` schema automatically) and that nothing in `.roo/rules-code/rules.md`
or elsewhere contradicts or duplicates it confusingly. Do not write a
NEW competing set of instructions — the vendored description is
already the real contract, this task activates it, doesn't rewrite it.

## Note on concurrent work

`plans/work-progress-visualization.md` may be running at the same time —
it touches `src/dashboard/page.ts`/`server.ts` primarily, this task touches
`src/tools/executor.ts`/`src/engine/events.ts` primarily. Low file-overlap
risk. If that task lands first and you're still working, check whether it
expects a specific `todo_updated` event shape and try to match it; if you
land first, your event shape is the one it should adapt to — either way,
don't block on the other task, just be aware it exists.

## The honest evaluation — the actual point of this task

Pick 2-3 realistic multi-step tasks (the kind the tool's own "when to use"
guidance describes — NOT trivial one-step tasks, where the guidance itself
says not to use it). Run each twice, identical task text: once with
`update_todo_list` available (and, ideally, some encouragement in the task
text or a light system nudge to actually use it — check whether the model
reaches for it on its own first, since that's itself informative), once
without it (today's baseline). Compare, with real numbers:

- **Iteration count to completion** — does having an explicit todo list
  measurably reduce wandering/re-exploration/backtracking, or is it neutral?
- **Token cost** — the tool itself costs some tokens to maintain (the
  checklist gets echoed back into history each update) — does that overhead
  net out against any iteration-count savings, or add up to a net cost?
- **Final output quality/completeness** — does the structured tracking
  measurably reduce the model losing track of a sub-task partway through a
  complex multi-step job (a real failure mode a todo list is specifically
  meant to prevent)? If you can construct or find a task complex enough to
  show this difference, that's the most valuable evidence this evaluation
  could produce.

Be willing to report a null or negative result — "activated, evaluated, no
clear iteration/cost benefit observed on the tasks tested" is a legitimate,
useful outcome, not a failure to deliver, exactly per this project's
established pattern for honest experiments.

## What NOT to do

- Do not rewrite the vendored tool's own description/guidance — activate
  it as-is.
- Do not persist todo state to a workspace file — it's conversational/
  session state, not a project artifact.
- Do not force every task through it — the tool's own guidance already
  says trivial tasks shouldn't use it; don't override that with a system
  prompt that makes it mandatory.
- Do not skip the honest evaluation — that's the actual point of this task,
  not an optional nice-to-have at the end.

## Tests

- `src/tools/__tests__/` (new or extended): the handler accepts a valid
  checklist, rejects/handles a malformed one sensibly, updates session
  state correctly across multiple calls (mark items done, add new items,
  per the tool's own example behavior in its description).
- A test proving the `todo_updated` event is emitted with the right shape.
- A test proving `update_todo_list` is genuinely registered/available in
  `code` mode's tool set (not just that the handler function exists).

## Verification checklist

1. `npx tsc --noEmit` clean.
2. `npm test` — all suites green including new ones.
3. Every e2e suite under `scripts/e2e*/run.sh` still passes.
4. The honest evaluation above, run for real if you have API access, with
   real iteration/cost numbers for both conditions on each task. If you do
   NOT have real API access, say so plainly and describe what you verified
   instead (unit tests, a scripted mock-LLM session proving the tool
   round-trips correctly) — do not claim the evaluation ran if it didn't.

## What to report back

- Files changed/added.
- The full honest evaluation: iteration counts, token/cost numbers, and
  quality/completeness observations for both conditions, on each task
  tested.
- Your honest verdict: does this measurably help, and under what
  conditions (if any) — not just "it works," but "it works AND here's
  whether it's actually worth using."
- Confirmation of tsc/test/e2e results.
- Any deviation from this spec, and why.
