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

Two GitHub issues in this repo (Capsize-Games/airunnerweb), do them in
this order:

1. **#29** — "Split the 10 multi-class files into one-class-per-file."
2. **#36** — "Decompose remaining 25 files over 250 lines."

Fetch both full issue bodies yourself (`gh issue view 29`,
`gh issue view 36`) for the exact file lists — don't rely on a stale
copy. These are grouped together because they're the same kind of
work (splitting files apart) with the same risk profile.

## Hard-won lessons from this project's history — read before touching
anything

A prior round of mechanical file-level changes in this repo (a "#24
noqa cleanup") went through **four rounds of rejected review** because
it kept deleting names that were actually load-bearing: a pytest
fixture import (in two separate files, missed twice), a re-exported
router attribute whose deletion crashed server startup outright, and a
re-export that broke an intentional dead-code guard. Splitting files
into multiple modules is exactly the kind of change most likely to
reproduce this failure mode — every extraction creates a new import
surface, and it's easy to miss an existing importer.

Rules for every single file you split:

1. **Never just delete the original file's public names without
   checking who else imports them.** `grep -rn` the ENTIRE repo
   (`server/`, `extensions/`, `projects/`, and all test directories —
   not just the module's immediate neighbors) for every class/function
   name before moving it. If anything imports the old path, either
   keep a re-export shim at the old location or update every importer
   in the same commit.
2. **Watch for string-literal references**, not just Python imports —
   this codebase has dispatch tables and route registries that
   reference module/attribute names as strings
   (`getattr(module, "some_name")`). A plain import-grep will miss
   these; grep for the bare name as a string too.
3. **For #29 specifically (splitting multi-class files)**: some of the
   listed files may be deliberate type catalogues (the issue mentions
   `contracts.py`, `contract_enums.py` are flagged, but use your own
   judgment — a file of tightly-related enums or a Pydantic contract
   catalogue may be more readable as one file than ten). If you judge a
   file shouldn't be split, say so explicitly in your issue-closing
   comment with reasoning, don't force it.
4. **Boot the server after every batch of changes** (not just run
   tests):
   ```
   docker run --rm -v "$(pwd)/server:/app/server" -v "$(pwd)/extensions:/app/extensions" -v "$(pwd)/projects:/app/projects" --entrypoint python3 ghcr.io/capsize-games/airunnerweb/airunner:latest -c "
   import sys; sys.path.insert(0, '/app/server/src')
   from fastapi import FastAPI
   from airunner_services.api.server_routes import register_routes
   app = FastAPI(); register_routes(app)
   print('ROUTES:', len(app.routes))
   "
   ```
   This is a minimum bar, not sufficient by itself — also run both full
   test suites (below).
5. One file (or small batch of closely-related files) per commit —
   not one giant commit for all 35 files across both issues.

## Environment

Python/Node are not on the host — only inside Docker. Bring up your
isolated stack first: `docker compose up -d` (from this worktree's
root — `.env` already has unique ports/project name, don't change
them). Use `docker compose exec server ...` for anything needing the
live stack, or a throwaway `docker run --rm -v ...` container (as
above) for anything that doesn't need your running DB.

Check `scripts/` before reasoning through something by hand. Across 35
files in these two issues, you'll repeat the same boot-check/baseline
sequence a lot — that's worth turning into a script under `scripts/`
rather than re-deriving it every time (see `.roo/rules/rules.md`'s
scripting principle).

## Workflow (per issue, per file)

1. Read the whole file. Identify natural seams (the issue body
   suggests some, adjust based on actual code).
2. Extract into focused modules under 250 lines, following this
   project's conventions (type hints, docstrings, 79-char lines, one
   class per file where it makes sense).
3. Preserve every public interface per the re-export rules above.
4. Get a fresh baseline BEFORE touching anything (save the numbers),
   then re-run after each file and confirm neither suite regressed:
   ```
   docker compose exec server bash -c 'cd /app && python -m pytest server/tests -q --ignore=server/tests/test_stt_transcribe_functional.py'
   docker compose exec server bash -c 'cd /app && python -m pytest server/src/airunner_services/tests -q'
   ```
5. Run the boot check.
6. Commit, referencing the issue (e.g.
   `git commit -m "Refactor #29: split contract_enums.py by domain"`).
7. Next file.

## Required comment template

Each issue's closing comment must use this exact structure (a section
present-but-empty is fine if genuinely not applicable, but every
section must be there — a missing section is itself a review finding):

```
## Issue #<29 or 36> — Closing Report

### Files changed / skipped
<one line per file: what changed, or "skipped: <reason>">

### Baseline (before)
<paste real pytest output for both suites, not a summary>

### Baseline (after)
<paste real pytest output for both suites, not a summary>

### Boot check
<paste the real output of the boot-check command, or state exactly
why it wasn't applicable>

### Residual risk / notes
<anything you're not 100% sure about>

PR: <link>
```

## Closing out

After finishing #29 (all 10 files, or a documented reason to skip
specific ones) and #36 (all 25, or documented reasons to skip
specific ones), with both baselines clean:

1. Push your branch and open a PR against `master` via `gh pr create`
   (mark ready, not draft).
2. Comment on **each issue separately** (#29 and #36) using the exact
   template above, filled in with real output. Close each issue once
   its own comment is posted.
3. **Phone home immediately** — do not make the orchestrator find out
   by polling. The instant both issues are closed:
   ```
   scripts/phone-home.sh "<orchestrator-window-title>" \
     "Worktree w2 finished: issues #29, #36 closed. PR: <link>"
   ```
   (the orchestrator should have told you its window title; if you
   don't have it, check for a title containing the main repo/workspace
   name via `wmctrl -l`, not a worktree name). Do this again any time
   your status changes — see step 4.
4. **Do not just stop and hope someone re-invokes you.** A separate
   reviewer will check your work asynchronously and may reopen either
   issue with feedback at any point. Poll for that yourself: every 5
   minutes, check both with `gh issue view 29 --json state --jq .state`
   and `gh issue view 36 --json state --jq .state`. Keep polling for up
   to 4 hours after your initial close of both. If either reopens, read
   the feedback, treat it as new work: address it, re-verify to the
   same standard, comment again, re-close, and **phone home again**
   (step 3) — then resume polling. If you hit 3 rework cycles on the
   same issue without it sticking, stop, leave a comment flagging it
   needs human help, phone home with that stalled status, and do not
   continue looping on that one (keep polling the other if it's still
   fine). If the full 4-hour window elapses with both still closed,
   stop normally.

Do not start any other issue. This worktree is scoped to #29 and #36
only.
