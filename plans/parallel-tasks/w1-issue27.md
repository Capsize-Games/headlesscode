Before anything else: read `.roo/rules-code/rules.md` in full and
treat it as binding for this entire session, regardless of whether it
auto-loaded for whatever mode you're running in — don't assume it
applied, read it yourself. It's this project's core conventions
(migration idempotency, host-system boundaries, security/logging
rules) and includes a real incident writeup worth internalizing.

You are working autonomously in an isolated git worktree, on your own
branch, with your own isolated Docker stack (own ports, own
COMPOSE_PROJECT_NAME, own empty database — this is intentional, not a
bug; you don't have the shared dev database's tenant data and don't
need it for this task). No human is in the loop until you open a PR.
Read this entire file before doing anything.

## Your assignment

GitHub issue **#27** in this repo (Capsize-Games/airunnerweb):
"Decompose the five 1,000+ line files into focused modules." Fetch the
full issue body yourself (`gh issue view 27`) for the file list and
line counts — don't rely on a stale copy.

These five files are on hot paths (tool execution, image generation,
GUI daemon, token accounting) — this is the highest-risk task in this
round precisely because of that. Treat it accordingly.

## Hard-won lessons from this project's history — read before touching
anything

A prior round of exactly this kind of work (a "#24 noqa cleanup") went
through **four rounds of rejected review** because a mechanical
"remove what looks unused" pass kept deleting names that were actually
load-bearing: a pytest fixture import (twice, in two different files),
a re-exported router attribute that crashed server startup, a deleted
re-export that broke an intentional dead-code guard. The common
thread every time: a name looked safe to delete by local inspection,
but something elsewhere referenced it — by direct import, by a
string-literal lookup (`getattr(module, "name")`, a dispatch table), or
implicitly (pytest fixture discovery, `__init__.py` re-export chains).

When you decompose these files into smaller modules:

1. **Never just delete the original file's public names.** If you move
   a class/function `Foo` from `big_file.py` to `big_file/foo_part.py`,
   add a re-export in the original location's `__init__.py` (or keep
   `big_file.py` itself as a thin re-export shim) so every existing
   importer keeps working, UNLESS you also update every single
   importer in the same commit — and if you do that, grep the *entire*
   codebase (not just `server/`, also `extensions/`, `projects/`,
   and test directories) for the old import path before deleting it.
2. **Grep for string-literal references too**, not just Python
   imports. This codebase has route/RPC dispatch tables that reference
   handler modules by string name (e.g. `server_routes.py`'s
   `_ROUTE_SPECS`), and test files that import a name purely for its
   side effect (pytest fixture discovery, import-time registration).
   `grep -rn` for the bare name across the whole repo, not just
   `import <name>`.
3. **After every file split, boot the server for real** — don't just
   run the test suite and call it done. Use:
   ```
   docker run --rm -v "$(pwd)/server:/app/server" -v "$(pwd)/extensions:/app/extensions" -v "$(pwd)/projects:/app/projects" --entrypoint python3 ghcr.io/capsize-games/airunnerweb/airunner:latest -c "
   import sys; sys.path.insert(0, '/app/server/src')
   from fastapi import FastAPI
   from airunner_services.api.server_routes import register_routes
   app = FastAPI(); register_routes(app)
   print('ROUTES:', len(app.routes))
   "
   ```
   A clean boot with no crash is a minimum bar, not a sufficient one —
   also run the actual test suites (see below), since a name can be
   broken in a way that doesn't crash startup but does break a code
   path a test exercises.
4. Do not do a giant single-commit rewrite of all 5 files. One file (or
   even one extracted module) per commit, so a bisect or revert is
   possible if the review round finds a problem in exactly one of them.

## Environment

Python/Node are not on the host — only inside Docker. Use
`docker compose exec server ...` for anything that needs the full app
stack running (migrations, DB-backed tests), or a throwaway
`docker run --rm -v ...` container (as shown above) for anything that
doesn't need a live DB connection, or does need one against the
containers YOUR docker compose stack in this worktree started (check
`docker compose ps` first — you should see containers with your
worktree's project name, not the main repo's).

Check `scripts/` before reasoning through something by hand — if a
tool for what you need already exists, use it. If you find yourself
running the same boot-check/baseline-test sequence across all 5 files
in this issue, that's worth turning into a script under `scripts/`
rather than re-deriving it each time (see `.roo/rules/rules.md`'s
scripting principle).

Bring your isolated stack up before starting any DB-backed work:
`docker compose up -d` (from this worktree's root — the `.env` here
already has unique ports/project name baked in, don't touch those).

## Workflow

For each of the 5 files:

1. Read the whole file. Identify the natural seams (the issue body has
   suggested splits per file — use them as a starting point, adjust if
   the actual code suggests a better boundary).
2. Extract into focused modules under 250 lines each, one class/concern
   per file where sensible, following this project's existing
   conventions (type hints, docstrings, 79-char lines).
3. Preserve every public interface exactly, per the re-export rules
   above.
4. Run the relevant existing tests for that file/module (find them via
   `grep -rl "<module_name>" server/tests server/src/airunner_services/tests`)
   plus the two full baseline suites:
   ```
   docker compose exec server bash -c 'cd /app && python -m pytest server/tests -q --ignore=server/tests/test_stt_transcribe_functional.py'
   docker compose exec server bash -c 'cd /app && python -m pytest server/src/airunner_services/tests -q'
   ```
   Get a baseline from these BEFORE you start touching anything, save
   the numbers, and re-run after each file — neither suite may get
   worse.
5. Run the boot check from above.
6. Only once 1-5 all check out for that file, commit it, referencing
   the issue (e.g. `git commit -m "Refactor #27: split sd_worker.py into pipeline stages"`).
7. Move to the next file.

## Required comment template

Your issue-closing comment must use this exact structure (a section
present-but-empty is fine if genuinely not applicable — e.g. "N/A, no
files skipped" — but every section must be there; a missing section is
itself a review finding, not just a content gap):

```
## Issue #27 — Closing Report

### Files changed
<one line per file: original -> new modules>

### Baseline (before)
<paste real pytest output for both suites, not a summary>

### Baseline (after)
<paste real pytest output for both suites, not a summary>

### Boot check
<paste the real output of the boot-check command, or state exactly
why it wasn't applicable>

### Residual risk / notes
<anything you're not 100% sure about, anything you deliberately chose
not to do and why>

PR: <link>
```

## Closing out

Once all 5 files are done and both baselines are confirmed clean:

1. Push your branch and open a PR against `master` via `gh pr create`
   (mark it ready, not draft).
2. Comment on issue #27 using the exact template above, filled in with
   real output. Then close the issue.
3. **Phone home immediately** — do not make the orchestrator find out
   by polling. The instant you've closed #27:
   ```
   scripts/phone-home.sh "<orchestrator-window-title>" \
     "Worktree w1 finished: issue #27 closed. PR: <link>"
   ```
   (the orchestrator should have told you its window title; if you
   don't have it, check for a title containing the main repo/workspace
   name via `wmctrl -l`, not a worktree name). Do this again any time
   your status changes — see step 4.
4. **Do not just stop and hope someone re-invokes you.** A separate
   reviewer (human and/or another agent) will check your work
   asynchronously, and may reopen #27 with feedback at any point after
   you close it. Poll for that yourself: every 5 minutes, run
   `gh issue view 27 --json state --jq .state` and check if it's back
   to `OPEN`. Keep polling for up to 4 hours after your initial close.
   If it reopens, read the new comment, treat the feedback as new work:
   address it, re-verify per the same standard above (fresh baselines,
   boot check), comment again, re-close, and **phone home again**
   (step 3) — then resume polling from there. If you hit 3 rework
   cycles on the same issue without it sticking, stop, leave a comment
   explicitly flagging that it needs human help, phone home with that
   stalled status, and do not continue looping. If the full 4-hour
   window elapses with the issue still closed, stop normally — the
   work is considered stable.

Do not start on any other issue. This worktree is scoped to #27 only.
