# Browser-only control plane — a real prompt box, no VS Code — instructions for implementation

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI that runs a headless coding-agent loop. It
already has an orchestrator (`headlesscode orchestrate`, split/spawn/watch/
review/rework against real GitHub issues) and a local dashboard
(`headlesscode dashboard --repo <path>`, `src/dashboard/`) that shows cost/
token/round status.

**This task has a hard dependency: do not start until both of these have
landed and you have re-read them in their final, actually-merged form (not
this document's summary of them, which may be stale by the time you read
this):**
- `plans/realtime-monitoring.md` — gives every session a live, structured
  event feed (`src/engine/events.ts`, `.headlesscode/events/<sessionId>.jsonl`)
  and a dashboard session detail view consuming it, plus pause/resume and
  the first `POST` routes on the dashboard server.
- `plans/mode-model-assignment.md` — per-mode model configuration
  (`.headlesscode/mode-models.json`) and a dashboard settings page, which
  also touches `src/dashboard/server.ts`'s POST routing.

If either hasn't landed, stop and say so in your report rather than
building around their absence — this task's whole point is composing
capabilities those two already built, not re-deriving them.

Match this project's established style: no test framework (plain `tsx`-run
test files, `All N tests passed` trailer); no new runtime dependencies
without a real reason (this project deliberately stays framework-free —
`src/dashboard/page.ts` is vanilla JS/HTML today, keep it that way); every
new write path non-fatal where established elsewhere (checkpoints, usage,
events); `npx tsc --noEmit` and `npm test` must stay green; re-run every e2e
suite under `scripts/e2e*/run.sh` afterward.

## The idea, in one paragraph

Today, starting an orchestration round requires a human sitting in VS Code
with Zoo Code, typing a prompt into the `multi-agent-orchestrator-headless`
mode's chat panel. But headlesscode can *already* run any `.roomodes` mode
headlessly — including that exact mode — via `headlesscode --task "<text>"
--mode multi-agent-orchestrator-headless --workspace <repo>`. Decoupling from
VS Code doesn't require a new agent loop: it requires (1) a way to *launch*
that exact call from a browser instead of a terminal, (2) the already-planned
live event feed to show what it's doing, and (3) a way to *answer* its
`ask_followup_question` escalations from the browser instead of from an
interactive Zoo Code session — the marker-file mechanism this already goes
through doesn't care who answers it.

## What to build

### 1. Launch a top-level session from the dashboard

**New endpoint** `POST /api/session/start` in `src/dashboard/server.ts`
(extend whatever POST-routing mechanism the realtime-monitoring work already
added — do not build a second one). Request body:
```json
{ "repo": "<path>", "task": "<the user's typed prompt>", "mode": "multi-agent-orchestrator-headless" }
```
- `repo` defaults to whatever `--repo` the dashboard itself was started
  with, if omitted (check how the server currently resolves the repo it's
  serving — likely a startup CLI flag threaded through to `aggregate.ts`,
  keep using that same resolution, don't invent a second config surface).
- `mode` defaults to `multi-agent-orchestrator-headless` — but let it be
  overridden, since this is also a reasonable way to kick off a plain
  `--mode code` single-task session for something that doesn't need the
  full orchestrator.
- Server-side, this should launch the session the SAME way
  `scripts/run-worker.sh` already launches a worker: a detached background
  process (`nohup`/`detached: true` + `unref()`, matching the pattern
  `src/tools/executor.ts`'s backgrounded `execute_command` already
  established for not blocking on a long-running child), running
  `npx tsx src/cli.ts --task '<task>' --mode '<mode>' --workspace '<repo>'`
  with `HEADLESSCODE_OPENROUTER_API_KEY` inherited from the dashboard process's own
  environment (so `.env` only needs to be sourced once, when the dashboard
  itself starts — document this clearly, since it's a change from every
  other entry point in this project, which each source `.env` themselves).
- Response: the new session's id (so the browser can immediately open its
  live event view — reuse the session id generation `HeadlessSession`
  already does internally; you may need to generate it dashboard-side and
  pass it through as an env var or flag the CLI accepts, since today the
  session id is generated inside `HeadlessSession` itself — check whether
  a `--session-id` override already exists; if not, decide whether adding
  one is cleaner than having the dashboard poll for "whatever session
  showed up in `.headlesscode/events/` after we launched" — the former is
  more deterministic, prefer it unless it turns out to be invasive).

### 2. A "start a session" UI

**New section** in `src/dashboard/page.ts`: a prompt textarea, a mode
selector (populated from `.roomodes` if you can read it easily from the
dashboard's existing aggregation layer, otherwise a plain text input
defaulting to `multi-agent-orchestrator-headless`), and a "Start" button
that `POST`s to the new endpoint and immediately navigates the page to that
session's live event view (from the realtime-monitoring work) — the whole
point is the user watches it start thinking within a second or two of
hitting submit, not that they have to go find it in a list.

### 3. Answering escalated questions from the browser

The decision-escalation mechanism (`ask_followup_question` writing
`.harness.needs-decision` and polling for `.harness.decision-answer`) already
works for ANY session, including a top-level orchestrator session started by
this new endpoint — it doesn't know or care whether the thing that eventually
answers it is a human at a terminal, an interactive Zoo Code session, or a
browser. So:

- **New endpoint** `POST /api/session/:id/answer` — resolves the session's
  workspace root (same worktree/repo-root resolution logic the events/usage
  endpoints from the realtime-monitoring work already use) and writes
  `.harness.decision-answer` there. This is functionally identical to what
  `scripts/headlesscode-answer.sh` already does — either shell out to that
  script or reimplement the one-line file write directly in TypeScript
  (simpler, no subprocess overhead for something this small); your call,
  but don't maintain two divergent implementations of the same write.
- **UI**: when a session's live event feed shows a `decision_blocked` event
  (from the realtime-monitoring work's event schema) and no matching
  `decision_answered` event yet, render an inline reply box right in the
  event feed at that point — not a separate page — with the question text
  and any `suggestions` array shown as quick-reply buttons alongside a free-
  text option. Submitting posts to the new endpoint.

### 4. Mode-text clarification (small, but don't skip it)

`.roomodes`'s `multi-agent-orchestrator-headless` mode currently has
language written assuming a human-interactive Zoo Code session is the one
running it (e.g. Step 3's "ask the actual human via your own real
`ask_followup_question`... you have that available even though the worker
doesn't"). That's no longer universally true once this mode can itself run
as a headless session launched from the browser — in that case IT is the one
without a "real" interactive question tool, and its own escalations go
through the exact same marker-file mechanism as a worker's. Add a short note
to the mode's `customInstructions` (and `.roo/rules-multi-agent-orchestrator-headless/rules.md`)
clarifying this: "if you are yourself running headlessly (no interactive
session, started from the browser), your own `ask_followup_question` calls
escalate the same way a worker's do — you do not have a special interactive
question tool in that case, don't assume you do." Do not rewrite the whole
mode file — this is a targeted clarification, not a redesign; the existing
worker-monitoring instructions (Steps 1-4) are unaffected and still correct.

### 5. Operational note to surface in the UI, not silently assume

- Permissions (`.headlesscode/permissions.json` from the earlier permissions-
  parity work) default-allow when unconfigured, so `gh`/`npx tsx ... orchestrate`
  should work out of the box for a top-level session — but if the repo owner
  has configured a deny-list, a browser-launched orchestrator session could
  fail in a confusing way (permission-refused rather than "didn't work").
  No code change needed for this, just make sure the event feed surfaces a
  permission refusal clearly (it should already, per the permissions-parity
  work's error messages) so it's diagnosable from the browser alone, since
  that's the whole point of this feature — don't let it silently require a
  terminal to debug.
- The dashboard is local-only, no-auth, by design (already true before this
  task). This endpoint makes it able to launch real, billed work and run
  arbitrary shell via `gh`/`orchestrate` from a form POST — flag this
  plainly in your report as a bigger step across that read-only-to-control
  line than pause/resume or settings-saving were individually. Do not build
  authentication yourself (explicitly out of scope for this round — this
  project's dashboard has stayed intentionally simple, and a real auth
  system is a separate decision the project owner should make deliberately,
  not something to bolt on as a side effect of this task). If you want to
  leave a low-effort hook for later (e.g. an optional bearer-token env var
  that, if set, is required on `/api/session/*` POST routes, defaulting to
  unset/disabled = today's behavior), that's fine to include, but keep it
  optional and off by default.

## What NOT to do

- Do not build multi-repo support — this stays scoped to the single `--repo`
  the dashboard was started against, matching every other dashboard feature
  today. Multi-repo is a real future extension, not this task.
- Do not build a new agent loop, a new prompt format, or a new tool set for
  "the browser orchestrator" — it is a completely normal `HeadlessSession`
  running an existing mode; the only genuinely new things are the launch
  endpoint, the answer endpoint, and the UI.
- Do not touch the interactive-VS-Code path (`multi-agent-orchestrator`,
  the GUI/xdotool mode) — this task is entirely about the headless path.

## Tests

- New `src/dashboard/__tests__/session-launch.test.ts`: `POST /api/session/start`
  actually spawns a detached process (use a fast, deterministic fake — e.g.
  point it at a tiny script instead of the real CLI for the test — and
  assert the process starts and the endpoint returns before the process
  finishes, proving it's genuinely detached/non-blocking); a malformed
  request body (missing `task`) is rejected clearly.
- New coverage for `POST /api/session/:id/answer`: writes the expected
  marker file content, matches what a real `ask_followup_question` call
  waiting on it would accept (reuse/extend the decision-escalation test
  fixtures from `src/tools/__tests__/decision.test.ts` if that makes the
  round-trip provable — write the answer via the new endpoint, then run
  the existing decision-escalation logic against it and confirm it
  unblocks, rather than only checking the file's raw bytes).
- A real manual smoke test end to end: via `curl`, `POST /api/session/start`
  with a task designed to trigger `ask_followup_question` quickly (reuse the
  pattern from `src/tools/__tests__/decision.test.ts`'s fake LLM client if
  you can point a real session at a similar mock — check
  `scripts/e2e/mock-openrouter.mjs` for a reusable scenario), watch the
  event feed show `decision_blocked`, `POST` an answer via the new
  endpoint, confirm the session resumes and the event feed shows
  `decision_answered` followed by the session continuing.

## Verification checklist

1. `npx tsc --noEmit` clean.
2. `npm test` — all suites green including new ones.
3. Every e2e suite under `scripts/e2e*/run.sh` still passes.
4. The manual smoke test above, actually run, with real observed output
   quoted in your report — not just described.

## What to report back

- Files changed/added.
- Confirmation of tsc/test/e2e results (actual pass/fail counts).
- The manual smoke test's real output.
- Whatever you decided for the session-id generation question in section 1
  (whether you added a `--session-id` override or solved it another way),
  and why.
- Any deviation from this spec, and why.
- Anything you noticed while doing this that looks like a related bug or
  gap, even if unfixed — flag it rather than ignoring it. In particular:
  restate clearly, in your own words, that this task moves the dashboard
  further from "observability tool" toward "the actual control plane" —
  don't let that be an implicit side effect buried in a diff.
