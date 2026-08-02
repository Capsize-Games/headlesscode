Title: Real-time worker monitoring: live per-session event feed, dashboard detail view, pause/resume

## Context

You are implementing this against the `headlesscode` repository — a standalone
Node/TypeScript CLI that runs a headless coding-agent loop (ported from a VS
Code extension called Zoo Code). It has a Phase-6 dashboard already
(`headlesscode dashboard --repo <path>`, implemented in `src/dashboard/`) that
shows cost/token totals per session and per orchestrated round, polling a
`/api/summary` JSON endpoint every few seconds. It currently shows **only
aggregate numbers** — no visibility into what a worker is actually doing right
now (which tool it's calling, what it just read/wrote, what the model said),
unlike the VS Code extension's chat panel, which streams the model's reasoning
and shows each tool call as it happens.

Match this project's established style:

- No test framework — plain `tsx`-run test files, hand-rolled assertions, an
  `All N tests passed` trailer line (see `src/dashboard/__tests__/aggregate.test.ts`
  or `src/tools/__tests__/decision.test.ts` for the exact pattern). Add new
  test files to `package.json`'s `test` script the same way existing entries
  are chained with `&&`.
- No new runtime dependencies unless there's no reasonable way to avoid it —
  this project deliberately uses plain `node:fs`/`node:http`, no frameworks,
  no schema library for its JSON state (see `src/orchestrator/state.ts`'s own
  comments on this).
- Every new write path that isn't the actual coding session's own work must be
  **non-fatal** — wrapped in try/catch, logged as a warning, never allowed to
  abort or corrupt the real session. Grep for `non-fatal` across
  `src/engine/loop.ts` to see the established idiom (used for memory,
  checkpoints, usage/cost recording) and match it exactly for anything new.
- `npx tsc --noEmit` and `npm test` must stay green. Re-run every e2e suite
  under `scripts/e2e*/run.sh` afterward (six of them: `e2e`, `e2e-phase2`,
  `e2e-phase4`, `e2e-phase5`, `e2e-phase6`, `e2e-permissions`) — this work
  touches `loop.ts` and the dashboard, both of which several existing e2e
  suites exercise directly.

This task has three phases, in dependency order — do them in order, and verify
each phase fully (tsc/tests/e2e) before starting the next, since later phases
build on earlier ones.

---

## Phase 1 — a live, per-session event feed

### The problem

`src/engine/loop.ts` already logs plenty per iteration (`this.logger.info(...)`
calls for iteration start, tool results, checkpoints, etc.) but only to
**human-readable text** (`harness.log`, via `src/engine/logger.ts` — see its
own header comment: "readable lines... rather than raw JSON-lines"). There is
no structured, dashboard-consumable record of what happened during a session
while it's still running — the closest thing today is the live usage snapshot
(`src/engine/usage.ts`'s `writeLiveUsage`/`LiveUsageRecord`), but that only
carries cost/token *aggregates*, not the actual tool calls, arguments, or
results.

### What to build

**New module `src/engine/events.ts`**, mirroring `src/engine/usage.ts`'s exact
idiom (same append-only JSONL pattern, same `usageDir`-style path helper, same
loose-validation read function):

- Storage: `<workspaceRoot>/.headlesscode/events/<sessionId>.jsonl` —
  append-only, one JSON object per line, one file per session.
- `EventRecord` type: at minimum `{ ts: string, sessionId: string, type: string, ...fields }`.
  Event `type`s to emit (pick sensible field names per type, keep each one
  small — this feed will be polled frequently, so avoid dumping full file
  contents or huge tool arguments into it; truncate long strings, e.g. 500
  chars, with a `truncated: true` marker, matching the truncation ethos already
  used in `src/tools/executor.ts`'s `MAX_RESULT_CHARS`):
  - `session_start` — mode, model, workspaceRoot, task text (truncated)
  - `iteration_start` — iteration number, history message count
  - `llm_response` — iteration number, whether the response included tool_calls,
    a short preview of the assistant's text content if any (truncated), token
    usage for this call (including `cachedTokens` — see the caching work
    already landed in `src/llm/openrouter.ts`/`src/engine/loop.ts`)
  - `tool_call` — iteration number, tool name, a truncated summary of the
    arguments (e.g. the `path` for file tools, the `command` for
    execute_command — don't dump full file contents into this feed)
  - `tool_result` — iteration number, tool name, `isError`, a truncated result
    preview
  - `checkpoint_saved` — iteration number (baseline or per-iteration — reuse
    the existing hook points in `loop.ts` where checkpoints are already saved)
  - `decision_blocked` / `decision_answered` — mirrors the existing
    `.harness.needs-decision` marker lifecycle (see `askFollowupQuestionHandler`
    in `src/tools/executor.ts`) — emit an event at the same points, don't
    duplicate the marker-file mechanism itself, just also log it here
  - `session_end` — status, iterations, final cost/tokens

- **Wire into `src/engine/loop.ts`**: add an event-emission call at each of the
  lifecycle points above (search for the corresponding `this.logger.*` calls
  already at each of these points — add the structured event write right
  alongside, don't replace the existing human-readable logging). Non-fatal
  (same try/catch + `logger.warn` idiom as everywhere else in this file).
- **Cleanup**: unlike the live usage snapshot (which is deleted once the
  session completes, since the final `.jsonl` record supersedes it), the event
  feed's `.jsonl` file should be **kept** after the session ends — it's a
  history/replay log, not a live-only snapshot. Don't delete it in
  `recordUsage`/session teardown.

### Tests

New `src/engine/__tests__/events.test.ts` (mirror
`src/engine/__tests__/loop.test.ts`'s existing checkpoint/usage-snapshot tests
for the pattern): run a real session with a scripted fake `LlmClient` that
calls a tool once then completes, and assert the events file contains, in
order, at least `session_start`, `iteration_start`, `llm_response`,
`tool_call`, `tool_result`, `session_end` — and that long content is actually
truncated, not dumped in full.

---

## Phase 2 — a live session detail view in the dashboard

### What to build

- **New aggregation function** in `src/dashboard/aggregate.ts`:
  `readSessionEvents(workspaceRoot, sessionId, sinceOffset?)` — reads the
  events JSONL file, optionally starting from a byte offset (for incremental
  "give me only what's new since I last asked" polling, the same idea as
  `tail -f`), returning `{ events: EventRecord[], nextOffset: number }`. Pure,
  fs-only, no `node:http` — same separation of concerns the existing
  `buildSummary` already has from `src/dashboard/server.ts`.
- **New endpoint** `GET /api/session/:id/events?since=<offset>&repo=<path>` in
  `src/dashboard/server.ts` (follow the existing routing style — it's a small
  hand-rolled `if (url.pathname === ...)` chain, not a router framework).
  You'll need to search across the repo's own usage dir AND every
  `.worktrees/<name>/` dir for the matching session id's events file, the same
  way `buildSummary` already searches for usage files across both locations —
  reuse/extract that directory-searching logic rather than duplicating it.
- **Dashboard UI** (`src/dashboard/page.ts`): make each row in the existing
  sessions table clickable, opening a detail panel/section (simplest: an
  expanding row or a separate `<div>` shown below the table when a session id
  is selected — no client-side router needed, this is a single static page)
  showing a scrolling, auto-updating feed of that session's events (icon/label
  per event type, e.g. a tool call shows "🔧 execute_command: npm test", a
  checkpoint shows "📸 checkpoint saved"). Poll
  `/api/session/:id/events?since=<lastOffset>` every ~1-2s while a detail view
  is open (faster than the existing 4s summary poll — this is meant to feel
  live), append new events to the DOM rather than re-rendering the whole feed
  each time, and auto-scroll to the latest event unless the user has manually
  scrolled up (a live feed that yanks you back to the bottom while you're
  trying to read history above is bad UX — check for this).

### Tests

New `src/dashboard/__tests__/events.test.ts` covering `readSessionEvents`:
fixture JSONL file in, correct events + `nextOffset` out; a second call with
`sinceOffset` set to the previous `nextOffset` returns only newly-appended
events (write more lines to the fixture file between the two calls, proving
the offset mechanism actually works, not just that the function runs).

---

## Phase 3 — pause / resume from the dashboard

### The problem

There is currently no way to pause a running worker — a human/orchestrator
watching a live session (via Phase 1/2's new visibility) has no way to
intervene if something looks wrong, short of killing the process outright
(losing the session, unlike a real pause).

### What to build

**Worker side** (`src/engine/loop.ts`): mirror the existing decision-escalation
polling mechanism (`askFollowupQuestionHandler` in `src/tools/executor.ts`) —
it already establishes the pattern of "write a marker, poll for a response
marker, block with the budget clock paused." Reuse that pattern's spirit, not
its exact file names:

- Before each iteration's LLM call (the natural safe boundary — **never** pause
  mid-tool-call; only check between iterations, the same place
  `budgetTracker.tick()` already runs), check for
  `<workspaceRoot>/.harness.pause-requested`. If present:
  - Write `<workspaceRoot>/.harness.paused` (a status marker the dashboard can
    detect, distinct from "running") and emit a `paused` event to the Phase 1
    event feed.
  - Pause the budget clock (at the loop level this is
    `budgetTracker.pauseClock()`/`resumeClock()` directly, already used
    elsewhere in this file for the decision-escalation wait) so a paused
    session isn't penalized for wall-clock duration.
  - Poll for `.harness.pause-requested` to be REMOVED (resume = delete the
    marker — simplest primitive, mirrors how decision-escalation's answer
    marker works, but here presence/absence IS the signal, no answer content
    needed), same short poll interval as decision-escalation (~5s), up to a
    max pause duration (default: 2 hours, matching the orchestrator's existing
    stall-guard timeout in `src/orchestrator/watch.ts` — make it configurable
    via `--max-pause-ms`/`HEADLESSCODE_MAX_PAUSE_MS`). If the max is hit,
    resume automatically (don't hang a worker forever on a forgotten pause) and
    emit an event noting the auto-resume.
  - On resume: delete `.harness.paused`, emit a `resumed` event, resume the
    budget clock, continue the loop normally.

**Dashboard side** — this is the point where the dashboard stops being purely
read-only, which is a deliberate scope change from how it was built
(`src/dashboard/server.ts`'s own header comment currently says read-only) —
call this out explicitly in your report, don't silently change the project's
stated design without flagging it:

- New endpoints `POST /api/session/:id/pause` and `POST /api/session/:id/resume`
  (`repo` + worktree resolved the same way Phase 2's events endpoint does).
  Writes/removes `.harness.pause-requested` in the right worktree.
- `src/dashboard/server.ts` currently rejects all non-GET methods outright
  (search for where it checks `req.method`) — this needs to change to allow
  these two specific POST routes while still rejecting everything else.
- Keep it local-only, no-auth, same as today (the dashboard already binds to
  `127.0.0.1` only) — but note in your report that a control action (not just
  observability) now exists on this endpoint, so if this is ever exposed beyond
  localhost, that assumption needs revisiting; don't try to add auth yourself,
  just flag it.
- UI: a pause/resume button in the session detail view from Phase 2, showing
  the session's current state (running/paused) and disabled appropriately
  (don't show "pause" on an already-paused or already-completed session).

### Tests

New `src/engine/__tests__/pause.test.ts`: a scripted session that gets paused
mid-run (write the marker from the test between iterations 1 and 2 of a
scripted fake `LlmClient`), assert the loop actually blocks (doesn't reach
iteration 2 until the marker is removed), assert the budget-duration clock
excludes the paused time (mirror how the existing decision-escalation
budget-pause test does this — check `src/tools/__tests__/decision.test.ts` for
the fake-clock pattern), assert auto-resume fires after the configured max
pause duration (inject a short max for the test, don't actually wait 2 real
hours).

New coverage in `src/dashboard/__tests__/server.test.ts` (create this file if
it doesn't exist — check first) or extend an existing one: the pause/resume
endpoints actually write/remove the marker file, and non-GET/POST methods to
unrelated routes are still rejected.

---

## Deliberately NOT in scope for this round (flag, don't build)

**True token-level streaming ("thinking" visibility).** The VS Code extension's
chat panel shows the model's response streaming in token-by-token as it's
generated. `headlesscode`'s OpenRouter client (`src/llm/openrouter.ts`) makes a
single blocking (non-streaming) request today — there is no `stream: true`
support, no SSE parsing, and the tool-call parser (`src/engine/parser.ts`) is
written assuming a complete, non-streamed message. Building real token-level
streaming would mean: reworking the OpenRouter client to issue SSE requests
and reassemble deltas, reworking the parser to handle partial/incomplete
tool-call JSON mid-stream, and deciding how partial reasoning text gets
surfaced (a new event type, written incrementally rather than once per complete
response). That's a materially larger and riskier change than everything above
— it touches the core request/response contract this whole project is built on,
not just a new observability layer alongside it. Phases 1-3 above get most of
the real value (seeing what tool is running, what it did, live status,
pause/resume) without that risk. If real token streaming is wanted later, it
should be scoped as its own separate follow-up after Phases 1-3 have proven out
in real use — do not attempt it as part of this task.

## Verification checklist (after EACH phase, not just at the end)

1. `npx tsc --noEmit` clean.
2. `npm test` — all suites green, including new ones.
3. All six e2e suites under `scripts/e2e*/run.sh` still pass.
4. A real manual smoke test per phase:
   - Phase 1: run a real session (mock-LLM pattern from
     `scripts/e2e/mock-openrouter.mjs`), confirm the events `.jsonl` file has
     the right event sequence and that truncation actually happens on a long
     tool result.
   - Phase 2: start `headlesscode dashboard --repo <that workspace>` while a
     session is running, open the detail view, confirm events appear live
     (poll it twice a couple seconds apart, confirm new events showed up
     without a full page reload).
   - Phase 3: pause a running session via the new endpoint mid-session, confirm
     it actually stops making progress (no new iterations), confirm the
     budget-duration clock froze, resume it, confirm it continues.

## What to report back

For each phase separately (don't wait until all three are done to report if
you're working through this over multiple sessions — but if you complete all
three in one pass, one combined report covering all three is fine):

- Files changed/added.
- Confirmation of tsc/test/e2e results (actual pass/fail counts).
- The manual smoke test results, including what you actually observed.
- Any deviation from this spec, and why.
- Anything you noticed while doing this that looks like a related bug or gap,
  even if unfixed — flag it rather than ignoring it. In particular: flag
  clearly that the dashboard is no longer purely read-only once Phase 3 lands
  (per the note above) so this is visible in the review, not buried.
