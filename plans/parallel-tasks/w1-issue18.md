Before anything else: read `.roo/rules-code/rules.md` in full (or `.roo/rules/rules.md` if
rules-code is absent) and treat it as binding for this entire session, regardless of whether
it auto-loaded for whatever mode you're running in — don't assume it applied, read it yourself.

You are working autonomously in an isolated git worktree, on your own branch, with your own
isolated environment. No human is in the loop until you open a PR. Read this entire file before
doing anything.

## Your assignment

GitHub issues assigned to this worktree: #18. Fetch each issue's real body yourself:
```
gh issue view 18
```
Do not rely on a stale copy of any issue body.

## Hard-won lessons

- Never delete a public name without grepping the ENTIRE codebase for every importer — including
  string-literal references (dispatch tables, getattr-by-name) and test files that import for
  side effects (pytest fixtures, registration).
- If you split a module into submodules, verify EVERY public name the original module exposed is
  still re-exported from the package's __init__.py (or equivalent) before closing — a missed
  re-export is a common, easy-to-miss defect a reviewer WILL catch, costing a full rework cycle.
  If the project has a re-export-checking script (e.g. scripts/check_re_exports.py), run it now,
  not just after a reviewer flags the miss.
- Re-run real checks (tests, boot) after every change and paste the real output in your report —
  output in a report is a claim, not evidence, until reproduced.
- If you find yourself repeating the same check across issues, script it under scripts/.
- A `git worktree add <path> <ref>` ALWAYS checks out the committed state of <ref> — it never sees
  uncommitted changes sitting in another checkout's working tree, even though worktrees share the
  same .git. If you spin up a throwaway worktree to verify a fix you just made, either commit the
  fix first or manually copy the modified file(s) into the fresh worktree — otherwise you'll be
  testing the OLD code and get a confusing failure that looks like the fix didn't work.

## Environment

Workspace root: this worktree (branch: current branch). All file/command tools are scoped to
this worktree. Commit per logical unit with the issue number in the message.

## Workflow

1. Read each assigned issue body via `gh issue view <n>` and the relevant source files.
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

Scope: #18 only.