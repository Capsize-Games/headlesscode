Before anything else: read `.roo/rules-code/rules.md` in full (or `.roo/rules/rules.md` if
rules-code is absent) and treat it as binding for this entire session, regardless of whether
it auto-loaded for whatever mode you're running in — don't assume it applied, read it yourself.

You are working autonomously in the SAME isolated git worktree as the previous attempt, on
the same branch. The automated adversarial reviewer found problems with that attempt. Read
this entire file before doing anything.

## Rework cycle 1 — address the review findings

Assigned issues: #29. Fetch each issue's real body yourself (do not rely on a stale
copy of any issue body):
```
gh issue view 29
```

## Review findings to fix (from the automated review)

1. None — no issues reopened. Review comments posted on issue #29 (stays closed) and PR #47.
2. Final baseline numbers personally confirmed: **`run-tests: all 106 file(s) passed` (exit 0)**; `tsc --noEmit` exit 0; page-script parse ok (88403 chars); live route serving 13 groups / 42 sessions at review time.

Your job: address EVERY finding above. Do not skip any. Do not claim a finding is fixed
without reproducing the fix for real.

## Workflow

1. Read each finding above and the relevant source files.
2. Fix every finding, following the project's own conventions and the rules files.
3. Re-verify for real (run the project's tests / boot check) and capture the output —
   output in a report is a claim, not evidence, until reproduced.
4. Commit with the issue number referenced, one logical change per commit.
5. Push the branch and update the PR (or open a new one if needed).
6. Post an UPDATED closing comment below on each issue using the required template, then
   re-close it (or leave it open with the updated report if it must stay open).

## Required comment template

Your issue-closing comment must use this exact structure (every section present; a section can
be 'N/A' with a reason, but a missing section is itself a review finding):
```
## Issue <n> — Closing Report (rework cycle 1)

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

Once every finding is addressed and every assigned issue is re-closed with fresh evidence:
1. Finish with attempt_completion and a full summary of what you changed, the real baseline
   numbers, the boot check, and the PR link(s).
2. The harness records your completion automatically (exit code + .harness.done marker) —
   no separate phone-home step is needed.
3. Do not start on any issue not assigned to this worktree.

Scope: #29 only — rework cycle 1.