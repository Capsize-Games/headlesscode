# Task-filing rules (issue #149)

Product direction, verbatim from the 2026-08-21 dogfooding session:
"there is absolutely nothing that the 14B cannot accomplish... all code
tasks can be decomposed to smaller and smaller complexity. At some
point, that complexity is within the model's capabilities to work
with. If it tries to work on a task and fails, it's not a sign that
we've reached the limits of its capabilities, it's a sign that the
task was not split up into small enough chunks."

Everything below is the concrete, checkable version of that principle,
calibrated against real evidence: dozens of live dispatches across
2026-08-21, both the ones that worked reliably and the ones that
didn't.

## 1. Size ceiling per issue

Reuse the existing heuristic — don't invent a second one.
`topLevelSectionCount()` (`src/orchestrator/split.ts`) counts top-level
numbered/bulleted list items and numbered headings in an issue body;
`ISSUE_SIZE_WARN_THRESHOLD = 3` already flags an issue reading like 3+
independent pieces of work. Today this only runs at orchestrate's
pre-flight dispatch check (`src/orchestrator/cli.ts:2438`) — apply the
SAME check before ever calling `gh issue create`, not just before
dispatching an already-filed issue. If a draft would trip this
threshold, split it into an umbrella + sub-issues (see below) before
filing, not after.

A second, complementary signal task-file authors (Claude, or a future
filing agent) should apply directly, since it's cheaper than running
code and catches a different failure shape: **count distinct FILES a
task asks to touch.** Every task that succeeded reliably on the first
try today touched exactly ONE file (or, for a coordinated multi-file
change, had each file's exact change fully spelled out with real
file:line locations already verified). The one task that touched 4
files across 2 files' worth of interface changes (issue #144's
implementation) failed on its first local-model dispatch — the model
got a malformed tool call cascading through real guardrails and gave
up at iteration 8, never finishing even one file. Rule of thumb: **a
single dispatched task should touch at most 1-2 files.** A change that
genuinely needs more should be filed as an umbrella issue with one
sub-issue per file/logical unit, each independently dispatchable.

## 2. Umbrella issue + sub-issue pattern

For work bigger than the size ceiling: file ONE umbrella issue
describing the overall goal, and N sub-issues, each:
- Independently completable without needing another sub-issue's
  in-progress state.
- Independently filed (its own issue number, not a checklist item
  buried in the umbrella's body).
- Linked back to the umbrella issue number in its own body.

Never file one big issue with an implicit "and also do these 5 other
things" scope creep in a single body.

## 3. Explicit numbered TODOs / exact locations, not vague prose

An issue (or a task file derived from one) that says "fix the X
problem in Y area" is worse than useless for a local-model dispatch —
it burns the model's own exploration budget rediscovering what a human
or Claude already knew when filing it. Every issue that led to a
same-session, first-try-successful fix today included, in the issue
body itself or the task file built from it:

- The REAL file:line location(s) already verified by reading the file
  (not recalled from memory, not guessed) — see
  `.roo/rules/rules.md`'s existing citation-verification rule for
  plan docs; this extends the same discipline to issues.
- The EXACT proposed change, not just the symptom — e.g. "add a
  `trackCost?: boolean` field to `BudgetTrackerOptions`, default true,
  early-return from `record()` when false" beats "stop tracking cost
  for local sessions" alone.
- A concrete, mechanical "what done looks like" — the exact
  verification commands to run, in order, and what output confirms
  success (not "make sure it works").

This is a REQUIRED section for any issue destined for local-model
dispatch, not an optional nicety. An issue missing it should get a
Claude/human scoping pass BEFORE being handed to a dispatch — the
reliable pattern all session has been "Claude scopes it with real
evidence, the local model implements the narrow, fully-specified
result," never "local model discovers AND implements in one session."

## 4. Pre-filing self-check

Before calling `gh issue create`, re-read the draft body against
section 1's heuristics:
- Does `topLevelSectionCount()` on this body return < 3? If not, split
  first (section 2).
- Does the body name real file:line locations for every concrete claim
  it makes? If it's making a claim about code without a citation,
  verify the citation via `read_file` before filing, don't file first
  and hope.
- If this issue will become a dispatch task, would the exact `git
  commit`/verification commands already be knowable from this body
  alone, or does the next reader still have to go figure out how to
  verify it?

This is mechanical and doesn't need a second model call — it's the
SAME check `issueSizeWarnings` already runs, just applied one step
earlier (before filing) instead of one step later (before dispatch).

## What NOT to do

Don't conflate this with issue #146 (no guardrail for a tool
repeatedly failing) — that's in-session recovery from a failing tool
call; this is about never handing the model an oversized or
underspecified task in the first place. Both matter, but they fix
different points in the pipeline.
