Before anything else: read `.roo/rules-code/rules.md` in full and
treat it as binding for this entire session, regardless of whether it
auto-loaded for whatever mode you're running in — don't assume it
applied, read it yourself. It's this project's core conventions
(migration idempotency, host-system boundaries, security/logging
rules) and includes a real incident writeup worth internalizing.

You are working autonomously in an isolated git worktree, on your own
branch, with your own isolated Docker stack (own ports, own
COMPOSE_PROJECT_NAME, own empty database — this is intentional, not a
bug). No human is in the loop until you open a PR. Read this entire
file before doing anything.

## Your assignment

Two GitHub issues in this repo (Capsize-Games/airunnerweb):

1. **#30** — "Add test coverage for world/ module (19 files, ~1,150+
   statements, currently 0%)."
2. **#38** — "Add test coverage for utils/ 0% coverage modules."

Fetch both full issue bodies yourself (`gh issue view 30`,
`gh issue view 38`) for the exact file/priority lists. These are
grouped because both are additive test-coverage work — lower risk than
the file-splitting work happening in parallel in other worktrees, since
you're not modifying production code paths, just adding tests around
them. Do not modify the production code these tests cover unless you
find and need to fix an actual bug the tests surface (see below) — if
you do, treat that as a separate, clearly-flagged change, not part of
routine test-writing.

## Priorities

Issue #30 (world/) is higher priority than #38 (utils/) — start there.
Within #30, start with `room_engine.py`, `temporal_query.py`, and
`world_state.py` (per the issue body) before the rest, since those feed
directly into LLM context/chat behavior. Within #38, `job_tracker.py`
is the highest-value target (153 statements, 0% coverage, "silent job
loss is a difficult bug to diagnose without test coverage" per the
issue) — do it first.

## Test-writing philosophy for this task

- Favor tests that would catch a real bug over tests that just execute
  a line for coverage-percentage's sake. A test asserting a function
  merely "doesn't throw" on a happy path is weak; test the actual
  behavior (edge cases, error paths, boundary conditions) a reviewer
  would care about.
- If while writing tests you discover the code under test has an
  actual bug (not a hypothetical — something demonstrably wrong), do
  not silently "write a test that matches the buggy behavior." Flag it
  clearly in your issue-closing comment, write the test to assert
  CORRECT behavior, and fix the bug in a separate, clearly-labeled
  commit (e.g. `git commit -m "Fix #30: <bug> found while adding coverage to room_engine.py"`)
  so it's easy to review and revert independently of the test-adding
  commits.
- Don't let this balloon in scope. The issue's own verification
  criteria (below) are the bar — hit them, don't chase 100%.

## Environment

Python/Node are not on the host — only inside Docker. Bring up your
isolated stack first: `docker compose up -d` (from this worktree's
root — `.env` already has unique ports/project name, don't change
them). Use `docker compose exec server ...` for anything needing the
live stack.

Check `scripts/` before reasoning through something by hand — if you
find yourself repeating the same coverage-check sequence across
several files, that's worth a script under `scripts/` instead of
re-deriving it each time (see `.roo/rules/rules.md`'s scripting
principle).

## Workflow

For each target file:

1. Read the file and understand what it actually does — don't guess
   from the name.
2. Check for any existing partial test coverage first
   (`grep -rl "<module_name>" server/tests server/src/airunner_services/tests`)
   so you build on what's there instead of duplicating it.
3. Write tests covering the real behavior, error paths, and edge cases.
4. Get a baseline before you start (save the numbers), and confirm
   neither suite regresses after each file:
   ```
   docker compose exec server bash -c 'cd /app && python -m pytest server/tests -q --ignore=server/tests/test_stt_transcribe_functional.py'
   docker compose exec server bash -c 'cd /app && python -m pytest server/src/airunner_services/tests -q'
   ```
5. Run coverage specifically for the file you just covered to confirm
   you actually moved the needle (`pytest --cov=<module_path> --cov-report=term-missing`).
6. Commit, referencing the issue (e.g.
   `git commit -m "Add coverage for #30: world/room_engine.py"`).
7. Next file.

## Required comment template

Each issue's closing comment must use this exact structure (a section
present-but-empty is fine if genuinely not applicable, but every
section must be there — a missing section is itself a review finding):

```
## Issue #<30 or 38> — Closing Report

### Files covered
<one line per file: what was added>

### Coverage achieved
<real --cov-report output, not a summary, per file>

### Bugs found/fixed while adding coverage
<none, or: bug + separate commit reference, per the philosophy above>

### Baseline (before)
<paste real pytest output for both suites, not a summary>

### Baseline (after)
<paste real pytest output for both suites, not a summary>

### Residual risk / notes
<anything you're not 100% sure about>

PR: <link>
```

## Closing out

Once #30's verification criteria and #38's verification criteria (per
each issue's own "Verification" section — fetch and check the exact
wording yourself) are met, with both baselines clean:

1. Push your branch and open a PR against `master` via `gh pr create`
   (mark ready, not draft).
2. Comment on **each issue separately** (#30 and #38) using the exact
   template above, filled in with real output. Close each issue once
   its own comment is posted.
3. **Phone home immediately** — do not make the orchestrator find out
   by polling. The instant both issues are closed:
   ```
   scripts/phone-home.sh "<orchestrator-window-title>" \
     "Worktree w3 finished: issues #30, #38 closed. PR: <link>"
   ```
   (the orchestrator should have told you its window title; if you
   don't have it, check for a title containing the main repo/workspace
   name via `wmctrl -l`, not a worktree name). Do this again any time
   your status changes — see step 4.
4. **Do not just stop and hope someone re-invokes you.** A separate
   reviewer will check your work asynchronously and may reopen either
   issue with feedback at any point. Poll for that yourself: every 5
   minutes, check both with `gh issue view 30 --json state --jq .state`
   and `gh issue view 38 --json state --jq .state`. Keep polling for up
   to 4 hours after your initial close of both. If either reopens, read
   the feedback, treat it as new work: address it, re-verify to the
   same standard, comment again, re-close, and **phone home again**
   (step 3) — then resume polling. If you hit 3 rework cycles on the
   same issue without it sticking, stop, leave a comment flagging it
   needs human help, phone home with that stalled status, and do not
   continue looping on that one (keep polling the other if it's still
   fine). If the full 4-hour window elapses with both still closed,
   stop normally.

Do not start any other issue. This worktree is scoped to #30 and #38
only.
