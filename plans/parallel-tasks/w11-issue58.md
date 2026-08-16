Project and mode-specific rules (from the central shared store and this project's own
.roo/rules*) are already spliced into your system prompt automatically — you do not
need to read any rules file yourself.

You are working autonomously in an isolated git worktree, on your own branch, with your own
isolated environment. No human is in the loop until you open a PR. Read this entire file before
doing anything.

## Your assignment

GitHub issues assigned to this worktree: #58. The real title/body of each is inline below.

### Issue #58: Auto-index the codebase on session/round start (codebase_search is inert without a manual 'headlesscode index' step)

## Problem

`codebase_search` needs a pre-built index (`headlesscode index --workspace <path>`), built manually. In practice nobody remembers to run it, so real rounds against `airunner` were found running with an index either **missing entirely** or **3 days stale** (built before commits that touched exactly the code a worker needed) — the worker fell back to `grep`-via-`execute_command` for the whole session as a result. This is a real, measured driver of harness slowness.

## What to do

Full architecture, rationale, and required verification are written out in `plans/auto-index-on-session-start.md` — **read it in full before doing anything, it is binding for this task.** Summary: index-building is already incremental and cheap when nothing changed (only changed chunks get re-embedded); add an automatic, throttled, non-fatal, skippable refresh at orchestrator round-start (once, against the main checkout — NOT once per worktree, to avoid a race on the shared central index) and at bare-CLI session start (the single-workspace case). Also fixes a real duplication (`src/index-util.ts` vs `src/codesearch/index.ts` both reimplementing "where is the index" resolution).

## Verification

Static/read-only per this repo's Testing Boundary — the plan file lists exactly what to test (throttle behavior, `--skip-auto-index`, non-fatal on embedder failure, no index-file corruption under concurrent orchestrate runs).

## Closing report

Use this repo's normal closing template: files changed, before/after (index staleness before vs. auto-refreshed after), `npx tsc --noEmit` + `npm test` output, boot check / e2e suite re-run, residual risk, PR link.

## Environment

Workspace root: this worktree (branch: current branch). All file/command tools are scoped to
this worktree. Commit per logical unit with the issue number in the message.

## Workflow

1. Read each assigned issue's inline body above and the relevant source files.
2. Implement the change following the project's own conventions and the rules files.
3. Verify for real (run the project's tests / boot check) and capture the output.
4. Commit with the issue number referenced, one logical change per commit.
5. Push the branch and open a PR (ready, not draft).
6. Post the closing comment below on each issue, then close it.

## Required comment template

Your issue-closing comment must use this exact structure (every section present; a section can
be 'N/A' with a reason, but a missing section is itself a review finding):
```
## Issue <n> — Closing Report

### Files changed
<one line per file>

### Baseline (before)
<real output>

### Baseline (after)
<real output>

### Boot check
<real output or exact reason it didn't apply>

### Residual risk / notes
<anything not 100% certain>

PR: <link>
```

## Closing out

Once every assigned issue is closed with the template above:
1. Finish with attempt_completion and a full summary of what you changed, the real baseline
   numbers, the boot check, and the PR link(s).
2. The harness records your completion automatically (exit code + .harness.done marker) —
   no separate phone-home step is needed.
3. Do not start on any issue not assigned to this worktree.

Scope: #58 only.