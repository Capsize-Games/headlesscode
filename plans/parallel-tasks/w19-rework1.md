Project and mode-specific rules (from the central shared store and this project's own
.roo/rules*) are already spliced into your system prompt automatically — you do not
need to read any rules file yourself.

You are working autonomously in the SAME isolated git worktree as the previous attempt, on
the same branch. The automated adversarial reviewer found problems with that attempt. Read
this entire file before doing anything.

## Rework cycle 1 — address the review findings

Assigned issues: #121, #122. The real title/body of each is inline below.

### Issue #121: ENH-4 [enhancement][LOW] Reviewer checklist: add explicit 'verify CI-config changes on the real runner' item

## Severity
LOW

## Audit area
enhancement

## Location
- `src/orchestrator/reviewer.ts:37-38` — `DEFAULT_REVIEW_PROMPT_PATH = "plans/zoo-code-review-mode-prompt.md"` — the reviewer checklist used by every automated review session.

## Description
Round-2026-08-17 demonstrated the review gate's single most valuable catch: w13's worker passed the SIGINT test 5/5 locally (`process.emit("SIGINT")` never terminates Node, so the test was green locally) and only the independent reviewer caught that the new CI workflow **failed deterministically on the real GitHub runner** (exit 130, e2e step never ran). Issue #90 was reopened with run URLs and exact log lines; the rework fixed it (runner-safe subprocess SIGINT test + Playwright browser install) and only then was it re-closed.

That catch came from the reviewer's diligence in the moment, not from the checklist — nothing in the reviewer prompt tells it that **CI-config changes must be verified on the real runner** when local verification passes. This class of bug (works locally, fails on the runner) is invisible to worker self-verification and is exactly where the review gate is most valuable, so it should be a standing checklist item rather than luck.

## Impact
Without an explicit checklist item, a future reviewer can verify a CI change entirely locally (typecheck/tests/e2e against the mock server, all green) and pass a workflow that will fail for every real contributor the moment it merges — the exact near-miss this round's reviewer happened to catch.

## Remediation
Add one checklist line to `plans/zoo-code-review-mode-prompt.md`: "If the diff adds or changes CI configuration (`.github/workflows/*`, `scripts/e2e*`), verify it against the real runner (push/PR runs, `gh run watch --exit-status`), not only locally — a workflow green under the local mock is not evidence it runs."

## Repro
Create a PR that adds a workflow passing locally (e.g. the pre-fix state of #90's SIGINT test); run `orchestrate review` — the checklist (before this change) has no item directing the reviewer to check the real run.

### Issue #122: Add path guard to execute_command rejecting shell redirects outside the workspace

### Severity
MEDIUM

### Context
Repo rule `.roo/rules/rules.md:105-133` explicitly forbids writing to `/tmp`; `write_to_file`/`apply_diff`/`search_replace`/`edit_file` all hard-reject outside-workspace paths via `resolveWithinWorkspace`. `src/tools/executor.ts:353-357` is lexical-only and only enforced by the file tools. `src/permissions/commands.ts:834-844` runs `execute_command` as a command-string allow/deny list, not path-aware, so a shell redirect to `/tmp` succeeds there. The rules doc calls this inconsistency out in rules.md:123-127.

### Task
Extend the path guard to `execute_command`: reject shell commands that redirect to a path outside the workspace root. Parse for `>`/`>>`/`2>` targets before the allow/deny check; if the resolved target is outside the workspace, reject the command.

### Evidence
Observed live in round-2026-08-17: headless review sessions wrote scratch files to `/tmp` via `execute_command`, e.g. `cat > /tmp/prsummary.md`, `cat > /tmp/review62.md`, `cat > /tmp/review90.md`, `cat > /tmp/review98.md`, `cat > /tmp/review-pr113.md`, `cat > /tmp/hc-review-check/probe.ts`. Cleanup also ran `rm -rf` on `/tmp/hc-adversarial.ts`, `/tmp/hc-adv2.ts`, `/tmp/hc-adv3.ts`, `/tmp/hc-review-prefix`, `/tmp/hc-consumer`. Outside-workspace writes cannot be auto-approved in the interactive GUI, and file tools reject them outright in headless workers; `/tmp` is shared and attacker-writable, so scratch there is a confidentiality risk.

### Verification
Run a review session that needs scratch (e.g. `orchestrate review` against a branch). A command like `cat > /tmp/foo.md` executed via `execute_command` must be rejected, while a redirect to a path inside the workspace still succeeds. Confirm a `write_to_file` to `/tmp` still throws `PathTraversalError`.

## Review findings to fix (from the automated review)

1. FINDING — #122 guard is bypassable (functional gap) and false-positives legitimate commands.**
2. Bypass (the issue is not actually fixed).** `checkRedirectEscape`/the executor anchor relative redirect targets on the command's initial `cwd` (`src/tools/executor.ts:1369-1373`, `src/permissions/commands.ts:718-726`) and never account for `cd`/`pushd`/nested-shell directory changes inside the command. Verified at the executor level with a fresh tmp workspace and zero permissions config:
3. `cat > /tmp/x` → refused before spawn (works, nothing written)
4. `cd /tmp && cat > out.md` → **ran**, file written to `/tmp` (`isError: false`)
5. `cd /tmp; echo hi > x.txt` → **ran**, file written to `/tmp`
6. `pushd /tmp && echo > x.txt` → **ran**, file written to `/tmp`
7. `bash -c 'cd /tmp && echo > x.txt'` → **ran**, file written to `/tmp`
8. `echo hi 1> /tmp/x`, `2>`, `>>`, `&>`, `>|` variants → refused (caught)
9. The issue's own evidence pattern (`cat > /tmp/review62.md`) survives as `cd /tmp && cat > review62.md` with one prefix token — the outside-workspace write is live.
10. False positives.** `redirectTargets` matches `>` inside quotes and heredoc bodies as if they were redirects:
11. `echo 'status > /tmp/ok'` → refused (literal string, no write)
12. `echo "wrote file > /tmp/x"` → refused
13. `cat > notes.md <<'EOF'\nSee > /tmp/config for details.\nEOF` → refused (heredoc body is not a redirect; the real redirect `> notes.md` is inside the workspace)
14. Verified executor-level: `isError: true` for all three. This will break legitimate heredoc/quoting (e.g. writing a scratch file whose content mentions `> /tmp`).
15. Required change:** track in-command directory changes when resolving redirect targets (refuse or resolve relative redirects against the last `cd` target; conservative approach: refuse commands that `cd` to an outside dir before a relative redirect), and make target extraction quote/heredoc-aware.

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

Scope: #121, #122 only — rework cycle 1.