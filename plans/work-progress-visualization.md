# Dashboard: work-progress visualization (see the shape of a session, not just a log) — instructions for implementation

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI running a headless coding-agent loop. The
project owner has never been able to SEE what a session's own algorithm
actually looks like in shape — how much of it is exploration vs. writing vs.
testing, how iterations cluster, where condensation/pauses happened — despite
this project already capturing all of that as structured data. This task
turns existing data into a real visual timeline, directly serving the
project owner's stated long-term goal of the browser dashboard becoming the
primary way they work on any project, not a debugging afterthought.

Match this project's established style: ZERO new UI/framework dependencies
(plain HTML/CSS/vanilla JS, no build step, no charting library — see
`src/dashboard/page.ts`'s own header comment and existing render functions
for the established pattern); no test framework (plain `tsx`-run test
files); `npx tsc --noEmit` and `npm test` must stay green; re-run every e2e
suite under `scripts/e2e*/run.sh`.

## What already exists — this is a rendering task, not a data-collection task

Every session already writes a complete structured event trail
(`src/engine/events.ts`, `.headlesscode/events/<sessionId>.jsonl`):
`session_start`, `iteration_start`, `llm_response`, `tool_call`,
`tool_result`, `checkpoint_saved`, `decision_blocked`/`decision_answered`,
`paused`/`resumed`, `session_end` — already served via `GET
/api/session/:id/events` (`src/dashboard/server.ts`) and already consumed by
the existing chat-thread view (`src/dashboard/page.ts`'s `renderChat`/
`renderChatTurn`, landed today). **Do not add new event types or change the
event feed's data shape unless something genuinely required for this task
is missing** — read `events.ts` and the chat-thread rendering code fully
first; this is very likely pure additional rendering on data that already
exists.

## What to build

A new view mode in the session detail page (alongside the existing flat
event-log view and the chat-thread view — additive, not a replacement)
showing the session's shape over time:

- **A horizontal timeline, one entry per iteration**, showing what kind of
  work that iteration did — color-code or icon-code by dominant tool type
  (read-heavy: `read_file`/`list_files`/`codebase_search`; write-heavy:
  `write_to_file`/`apply_diff`/`search_replace`/`edit_file`; execution:
  `execute_command`; control events: checkpoints, condensation, pause/
  resume, decision-blocked). The goal is that someone can glance at the
  timeline and immediately see "this session spent its first 40 iterations
  exploring, then started editing around iteration 45."
- **Visual markers for structural events** distinct from normal iterations:
  condensation points (`[condense]` log events — check `loop.ts`/
  `condense.ts` for what's actually emitted to the event feed for this, add
  a `condensed` event if nothing currently captures it for the dashboard —
  this is the one place you might need a small, justified addition to the
  event shape, confirm it's actually missing before adding it), checkpoints,
  pauses.
- **A running tool-mix summary** (e.g. a simple bar or count breakdown: N
  reads, N writes, N commands, N searches) so the "read/write ratio" the
  project owner is specifically asking about is a real, visible number, not
  something they have to eyeball from a log.
- **Cost/token overlay** — since cost data is already tracked per-iteration
  (`[usage] running total` — check whether this is already in the event
  feed or only in `harness.log`; if only in the log, that's a real gap
  worth flagging, but this task's primary scope is the shape/timeline, not
  necessarily also building new cost-event capture unless it's cheap and
  directly useful here).

Keep it genuinely simple — plain HTML/CSS positioning or a lightweight
inline SVG/canvas rendering built by hand (no charting library dependency).
This project's whole dashboard ethos is "plain fs + JSON, no schema
library" carried through to the UI: no build step, no bundler, no npm
package for charts.

## Note on concurrent work

`plans/activate-update-todo-list.md` may be running at the same time. If it
lands first (or you notice it already landed), check whether it added a
`todo_updated` (or similarly-named) event to the feed — if so, consider
surfacing the CURRENT todo-list state alongside the timeline (e.g., a small
"currently: implementing core logic (3/5 steps)" indicator) as a natural
complement to the shape visualization. This is a nice-to-have connection,
not a hard requirement — do the core timeline first regardless of whether
that task has landed.

## What NOT to do

- Do not add a charting/visualization library dependency.
- Do not change the event feed's fundamental shape without confirming
  something is genuinely missing first.
- Do not remove or replace the existing flat event-log or chat-thread
  views — this is a third, additive view mode.

## Tests

- If you extract any pure grouping/bucketing logic (e.g. "classify this
  iteration's dominant tool type," "compute the read/write/exec counts"),
  test it directly against fixture event arrays covering a realistic mix
  (heavy exploration, heavy editing, a condensation point, a pause/resume
  pair) — assert exact expected classifications, not just "doesn't crash."
- If `page.ts` is mostly a template-string generator with limited testable
  pure logic (check `src/dashboard/__tests__/` for the established pattern
  first), follow whatever precedent already exists for testing this kind
  of rendering code.

## Verification checklist

1. `npx tsc --noEmit` clean.
2. `npm test` — all suites green including new ones.
3. Every e2e suite under `scripts/e2e*/run.sh` still passes.
4. Manual verification: start the dashboard for real against a workspace
   with real session history (this repo's own `.headlesscode/events/` has
   real data from today if any session directories still have their event
   files — check what's actually available, or generate fresh data with a
   short real/mock session), open it in an actual browser, confirm the
   timeline renders sensibly against real data. Screenshot or detailed
   description in your report — this is a visual feature automated tests
   can't fully validate.

## What to report back

- Files changed/added.
- Screenshot or detailed description of the new view against real data.
- Whether you found the event feed missing anything needed for this (e.g.
  condensation events) and what you added, with justification.
- Confirmation of tsc/test/e2e results.
- Any deviation from this spec, and why.
