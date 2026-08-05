# Mid-session message injection (the one real gap for a live chat-UI frontend)

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository —
a standalone Node/TypeScript CLI running a headless coding-agent loop, with
a local dashboard (`src/dashboard/server.ts`) exposing an HTTP control
plane over running sessions. Match the project's established conventions:
no test framework beyond hand-rolled `assert` + `tsx`-run test files,
minimal new dependencies, `npx tsc --noEmit` and `npm test` must stay
green, re-run `scripts/e2e*/run.sh` afterward. **Commit your work
incrementally per logical change before calling `attempt_completion`.**

**Do not start this until the currently in-flight round finishes and is
merged** (`plans/central-project-store-and-shared-instructions.md`).

## Why this doc exists

The project owner wants to use headlesscode through UwUChat's browser chat
interface (`~/Projects/airunner`, dev client at `localhost:5173`, which
already has a chatbot UI and a code-mode toggle) with the SAME interaction
model they get from a Claude Code session: see the model's reasoning and
tool use live, run background terminal commands and get notified when they
finish, and — critically — send a new message WHILE the agent is still
working and have it actually shift the conversation, not just queue behind
whatever the agent was already going to do.

Three capabilities were checked against the real code, not assumed:

1. **Live reasoning + tool-use visibility — ALREADY BUILT, nothing to do.**
   `GET /api/session/:id/events?since=<offset>` (`src/dashboard/server.ts`)
   already gives incremental polling access to a session's full event feed,
   including the model's reasoning content (`assistant.reasoning` /
   `reasoningPreview`, `src/engine/loop.ts` around line 1963-1988) alongside
   every tool call/result. There's also an opt-in SSE-style streaming mode
   ("streaming-and-reasoning", `src/engine/loop.ts`) for token-level
   incremental updates instead of per-iteration polling. `src/dashboard/
   chat-thread.ts`'s `groupEventsIntoChat` already turns the raw event feed
   into chat-renderable blocks — this is literally UwUChat's rendering
   problem already solved on the headlesscode side. **No headlesscode work
   needed here** — this is a UwUChat frontend integration task (consume the
   existing API), not a headlesscode gap.
2. **Background terminal execution + waiting for results — ALREADY BUILT.**
   `execute_command` already supports backgrounding long-running commands
   and reaping them at session end (`src/engine/__tests__/loop.test.ts`:
   "execute_command: session end reaps backgrounded children"). This is a
   model-side tool capability, available in any session regardless of
   frontend. **No headlesscode work needed here either.**
3. **Mid-session free-form message injection — THE REAL GAP.** Checked
   every existing mechanism that touches a running session from outside:
   - `POST /api/session/:id/pause` / `/resume` (`src/dashboard/server.ts`,
     doc comment lines ~14-20) only controls iteration CADENCE (pause
     between iterations, resume continues) — it does not accept or inject
     any new content.
   - `POST /api/session/:id/answer` writes `.harness.decision-answer`,
     but that only unblocks a decision the MODEL explicitly escalated via
     `ask_followup_question` (`src/tools/executor.ts`'s `escalateDecision`)
     — it cannot deliver an unsolicited message the model never asked for.
   - There is NO existing mechanism for a human (or a chat frontend) to
     inject an arbitrary new `user`-role message into a RUNNING session's
     history, to be picked up on its next turn, independent of whether the
     model is waiting on anything. This is exactly the capability the
     project owner experiences constantly in this very conversation
     ("the user sent a new message while you were working") and wants
     for UwUChat too — and it doesn't exist yet.

## What to build

A new marker-file mechanism, following the EXACT existing pattern
`.harness.pause-requested`/`.harness.decision-answer` already establish —
don't invent a different shape:

1. **New marker**: `<workspaceRoot>/.harness.inject-message` (JSON:
   `{ text: string, injectedAt: ISO timestamp }`), written by a new
   dashboard endpoint `POST /api/session/:id/message` (body: `{ text }`) —
   add it in `src/dashboard/server.ts` alongside the existing
   `/pause`/`/resume`/`/answer` routes, same auth gate
   (`Authorization: Bearer <token>` when configured).
2. **Loop-side check**: hook into the SAME safe boundary
   `checkPauseRequested` already uses — "before each iteration's LLM call
   ... never mid-tool-call" (`src/engine/loop.ts` line ~1262-1271,
   called at lines 1808 and 2203). This boundary is safe for the SAME
   reason it's safe for pause: it's after any prior assistant `tool_calls`
   message has ALL its matching `tool` results already appended (never an
   orphaned tool_calls group) — inserting a plain `user`-role message here
   cannot violate the API's message-ordering requirements the way
   inserting one mid-tool-call-group would. Read a real existing session's
   message array structure at this exact point before writing the
   insertion logic, to confirm the ordering assumption holds for real
   sessions, not just in theory.
3. **Insertion semantics**: append a new `{ role: "user", content: text }`
   message to the session's live message array, emit an event (e.g.
   `message_injected`) to the event feed so the UI can render it inline
   (reuse `EventRecord`'s existing shape, `src/engine/events.ts`), delete
   the marker file (mirroring how pause/decision-answer clean up their own
   markers), and let the next iteration's LLM call proceed with the
   updated history — the model sees the new message as if the user had
   just said it in a normal back-and-forth, not as a tool result or a
   system interruption notice.
4. **Interaction with condensation and truncation**: an injected message is
   just a normal `user`-role history entry once appended — it participates
   in `truncateHistory`/condensation exactly like any other message, no
   special-casing needed there.
5. **Mode-agnostic**: this must work under ANY headlesscode mode (`code`,
   `architect`, `planning`, etc.) — the project owner explicitly wants it
   available in both UwUChat's regular chat mode and its code mode. Don't
   gate this capability by mode; it's a session-level mechanism, not a
   mode-specific one.

## What NOT to build

- Don't build a message QUEUE (multiple pending injections buffered up).
  One marker, one pending message — if a second injection arrives before
  the first is picked up, decide a simple, explicit policy (e.g.
  overwrite-with-latest, or concatenate) and document it; don't build a
  general pub/sub queueing system for this.
- Don't conflate this with `ask_followup_question`'s answer mechanism —
  they're deliberately different (answering a specific pending question
  vs. injecting an unprompted new message) and should stay as two distinct
  code paths, not merged into one.
- Don't build any UwUChat-side UI work here — that's out of scope for this
  repository. This doc is scoped to the headlesscode-side API gap only.

## Testing

- Unit test (mirror `src/engine/__tests__/loop.test.ts`'s pause tests):
  inject a message mid-session via the marker file, assert it appears in
  the message array at the correct position (after the prior turn's
  complete tool-call group, before the next LLM request) and that the
  model's next response is generated WITH that message in context (a fake
  `LlmClient` can assert on `request.messages` content).
- Test the marker is cleaned up after being picked up, and that a session
  with no injection marker present behaves byte-identical to today.
- Dashboard endpoint test: `POST /api/session/:id/message` writes the
  marker correctly, respects the same auth gate as `/pause`/`/answer`.
- Real-session check: start a real session, `curl -X POST .../message`
  mid-run, confirm the next iteration's log shows the injected content
  reaching the model.
