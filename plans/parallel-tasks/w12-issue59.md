Project and mode-specific rules (from the central shared store and this project's own
.roo/rules*) are already spliced into your system prompt automatically — you do not
need to read any rules file yourself.

You are working autonomously in an isolated git worktree, on your own branch, with your own
isolated environment. No human is in the loop until you open a PR. Read this entire file before
doing anything.

## Your assignment

GitHub issues assigned to this worktree: #59. The real title/body of each is inline below.

### Issue #59: Multi-language code intelligence: generic LSP backend so find_references/go_to_definition/outline/import_graph/rename_symbol work for any language, not just TypeScript

## Problem

`src/codeintel/` (`outline`, `go_to_definition`, `find_references`, `import_graph`, `rename_symbol`) is fully built and works well, but is hard-wired to TypeScript — every analyzer takes a concrete `ts.Program`/`ts.LanguageService` struct with no abstraction seam, and `src/tools/executor.ts` only registers these six tools at all when the workspace is detected as a TypeScript project. **A Python-only (or Rust/Go/anything-else) workspace gets none of them — not hidden, actually absent.**

Confirmed live on `airunner` (mixed Python-server / TypeScript-client repo): a worker doing Python server-side work had zero code-intel tools usable for the `.py` files it actually needed, and fell back to `grep`-via-`execute_command` for every symbol lookup — the same "trial and error" pattern that's been measured elsewhere as a real harness-slowness driver.

## What to do

Full architecture, rationale, and required verification are written out in `plans/multi-language-code-intel.md` — **read it in full before doing anything, it is binding for this task.** Summary: extract a language-neutral `CodeIntelBackend` interface, wrap the existing TypeScript implementation behind it unchanged (mechanical, low-risk first step), then build a generic LSP-client backend (spawns a real language server, speaks LSP over stdio) that can drive ANY LSP-compliant server — bundle `pyright` so Python support works out of the box, with per-file-extension backend dispatch so a mixed-language repo gets the right backend for each file in the same session.

This is a real, substantial build — the plan explicitly recommends sequencing it as multiple commits (interface + TS wrap, then LSP client + lifecycle, then Python wiring, then executor/prompt integration).

## Verification

Static/read-only per this repo's Testing Boundary — the plan file lists exactly what to test, including a REAL Python fixture (not mocked) proving `find_references`/`go_to_definition` work via the pyright-backed path, and a mixed-language workspace proving per-file dispatch.

## Closing report

Use this repo's normal closing template: files changed, before/after (a Python `find_references` call failing with "tool not available" before, succeeding with real results after), `npx tsc --noEmit` + `npm test` output, boot check / e2e suite re-run, residual risk, PR link.

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

Scope: #59 only.