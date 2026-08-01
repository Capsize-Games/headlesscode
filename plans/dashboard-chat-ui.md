# Dashboard: real chat-thread UI for a live session — instructions for implementation

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI running a headless coding-agent loop. This is
a browser-parity item: the VS Code Zoo Code extension shows a conversational
chat thread (user/assistant turns, tool calls rendered inline); this
project's dashboard (`src/dashboard/page.ts`) currently renders a flat,
chronological EVENT LOG (see `renderEvent` in that file) — technically
complete information, but not a chat-like reading experience.

Match this project's established style: ZERO new UI/framework dependencies
(no React, no build step — this project's dashboard is deliberately a
single server-rendered HTML page with plain inline JS, see `page.ts`'s own
header comment); no test framework (plain `tsx`-run test files); `npx tsc
--noEmit` and `npm test` must stay green; re-run every e2e suite under
`scripts/e2e*/run.sh`.

## Note on concurrent work

`plans/dashboard-checkpoint-diff-ui.md` and
`plans/dashboard-file-browser-and-permissions-ui.md` may be running at the
same time — all three touch `src/dashboard/page.ts` and possibly
`server.ts`. Real conflict risk. If you hit one, re-read the other tasks'
actually-merged final state before resolving, and prefer additive changes
(new render functions, new routes) over restructuring shared code those
other tasks might also be touching.

## The problem

`src/dashboard/page.ts`'s `renderEvent` (~line 275) renders each event
(`tool_call`, `tool_result`, `llm_response`, etc.) as its own row in a
scrolling list — you can reconstruct what happened, but it doesn't read
like a conversation the way Zoo Code's chat panel does (assistant text,
tool calls shown inline within the turn that produced them, not as
separate flat rows).

## What to build

**A chat-thread rendering mode for a live/completed session's detail view**,
consuming the SAME event feed data already served by `GET
/api/session/:id/events` (`src/dashboard/server.ts` — do not add a new
backend data source, this is a rendering/grouping change on data that
already exists). Group consecutive events by iteration/turn (an assistant
"turn" = its `llm_response` event plus the `tool_call`/`tool_result` events
it produced, per the existing event ordering already established in
`src/engine/events.ts`) into a single chat-bubble-style block: the model's
text/reasoning (if `plans/streaming-and-reasoning.md` has landed — check its
merged state; if not, gracefully render without a reasoning section, don't
hard-depend on it) followed by its tool calls and their results, visually
distinct from the next turn.

Keep this as an ADDITIONAL view mode alongside the existing event-log view,
not a replacement — add a toggle/tab in the session detail view (existing
event-log rendering stays available; some users/debugging scenarios want
the flat log). Reuse the existing polling mechanism (`?since=<offset>`
incremental fetch, already implemented) rather than building a new one —
the grouping/rendering is client-side JS work on data already arriving the
same way.

Visually distinguish: user/task messages, assistant text, tool calls (name
+ key argument, matching the same summarization style
`summarizeToolArg` in `src/engine/loop.ts` already uses server-side for
`harness.log` — consider whether the event feed should carry a similar
short arg summary per tool_call event already, or whether you need to add
one; check current event fields before assuming), tool results
(success/error visually distinct), and system-level events (checkpoints,
pause/resume, decision-blocked) as smaller inline markers rather than full
chat bubbles.

## What NOT to do

- Do not add a UI framework or build step — plain HTML/CSS/vanilla JS only,
  matching the rest of `page.ts`.
- Do not change the event feed's data format/backend — this is a rendering
  change only.
- Do not remove the existing flat event-log view.
- Do not build real-time token-by-token rendering here unless
  `plans/streaming-and-reasoning.md` has already landed and you're
  extending its actual merged output — if it hasn't landed, render each
  turn as it completes (today's granularity), not token-by-token.

## Tests

- If you extract any grouping/formatting logic into a pure function (e.g.
  "group this flat event array into turns"), test it directly with fixture
  event arrays covering: a normal turn, a turn with multiple tool calls, an
  error tool result, a decision-blocked/answered pair, a pause/resume pair
  — assert the grouping is correct, not just that it doesn't crash.
- If page.ts doesn't already have any testable pure functions (it may be
  mostly a big template-string generator), check `src/dashboard/__tests__/`
  for the established pattern of testing this kind of rendering code before
  deciding whether to extract new pure functions or leave logic inline.

## Verification checklist

1. `npx tsc --noEmit` clean.
2. `npm test` — all suites green including new ones.
3. Every e2e suite under `scripts/e2e*/run.sh` still passes.
4. Manual verification: start the dashboard for real
   (`npx tsx src/cli.ts dashboard --repo <path with real session history>`),
   open it in an actual browser, confirm the new chat view renders
   correctly against real event data (screenshot or detailed description in
   your report, since this is a visual feature that automated tests can't
   fully validate).

## What to report back

- Files changed/added.
- Screenshot or detailed description of the new chat view against real
  data.
- Whether `plans/streaming-and-reasoning.md` had landed when you built
  this, and how you handled its absence/presence.
- Confirmation of tsc/test/e2e results.
- Any deviation from this spec, and why.
