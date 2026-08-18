Project and mode-specific rules (from the central shared store and this project's own
.roo/rules*) are already spliced into your system prompt automatically — you do not
need to read any rules file yourself.

You are working autonomously in the SAME isolated git worktree as the previous attempt, on
the same branch. The automated adversarial reviewer found problems with that attempt. Read
this entire file before doing anything.

## Rework cycle 1 — address the review findings

Assigned issues: #123, #124. The real title/body of each is inline below.

### Issue #123: Point reviewer/worker scratch to workspace .headlesscode/scratch and add no-/tmp checklist rule

### Severity
MEDIUM

### Context
`.roo/rules/rules.md:105-133` is explicit: never write to `/tmp`. Outside-workspace writes cannot be auto-approved in the interactive GUI and are rejected by the file tools in headless workers, but reviewers still used `execute_command` to write scratch to `/tmp` in round-2026-08-17: `cat > /tmp/prsummary.md`, `cat > /tmp/review62.md`, `cat > /tmp/review90.md`, `cat > /tmp/review98.md`, `cat > /tmp/review-pr113.md`, `cat > /tmp/hc-review-check/probe.ts`.

### Task
Update reviewer/worker prompts and documentation to designate a workspace-local scratch directory and explicitly forbid `/tmp`:
- Point prompts at `<workspace>/.headlesscode/scratch/` as the designated scratch location.
- Add this to the reviewer checklist in `plans/zoo-code-review-mode-prompt.md`.
- Add an explicit line to the reviewer checklist: no `/tmp`; use `.headlesscode/scratch/`.

### Why
Reviewers were the worst offenders this round. This prompt/checklist change makes sessions behave consistently with the workspace-containment convention and keeps potentially sensitive scratch out of a shared world-writable dir.

### Verification
Run a review session that needs scratch (e.g. `orchestrate review` against a branch). Scratch writes should use `<workspace>/.headlesscode/scratch/` and no `/tmp` paths should appear in the harness log. Inspect `plans/zoo-code-review-mode-prompt.md` to confirm the checklist includes the `no /tmp; use .headlesscode/scratch/` line.
### Issue #124: ENH-3: Add verification-intensity multiplier for test-shaped estimates in cost preflight

Severity: LOW (original issue #120).

### Problem
Cost preflight under-predicts verification-heavy test/CI shapes. Round-2026-08-17 preflight estimated ~$0.79; actual round cost was ~$2.09 (2.6x). Worst miss: w13 (issues #62/#90/#98, a `test/hot` shape group) estimated ~$0.05-$0.27, actual $1.03 (then $1.11 including review). The estimate's own diagnostic admitted "2 issue(s) unmatched" for that shape, and the shape model has no notion of a group whose work is verification-heavy (diff adds CI config, forcing real GitHub-runner round-trips, which dominated w13's cost).

### Relevant code
- `src/orchestrator/cost-estimate.ts:37` — `MIN_SHAPE_SAMPLES = 3`
- `src/orchestrator/cost-estimate.ts:164` — `aggregateByShape` buckets recorded history by shape
- `src/orchestrator/cost-estimate.ts:187` — estimate requires `byShape.length >= MIN_SHAPE_SAMPLES`

### Change
Add a verification-intensity multiplier for `test`-shaped issues (or issues whose remediation mentions CI/GitHub Actions). Scale the `test` shape estimate up until real samples accumulate. The exact multiplier is at maintainers' discretion; the current thin/missing samples for test/CI shapes should not be trusted as-is.

### Verification
Run `orchestrate --dry-run` on a group whose issues include adding CI (`COV-1`-style); compare its estimate to the actual recorded cost after the round completes. Before the fix, expect 2-3x under-prediction when the worker verifies on a real runner; after the fix, the `test`/CI-bearing estimate should be scaled up.

## Review findings to fix (from the automated review)

1. Issue #124 — REOPENED** (one real defect in the new code):
2. `verificationMultiplier()` exceeds its documented 2.5 cap below `MIN_SHAPE_SAMPLES`** — `src/orchestrator/cost-estimate.ts:258-260`. The JSDoc (lines 237-245) documents the multiplier as "taper[ing] linearly from TEST_SHAPE_VERIFICATION_MULTIPLIER at MIN_SHAPE_SAMPLES to 1," i.e. 2.5 is the cap. But the formula extrapolates below `MIN_SHAPE_SAMPLES=3` instead of clamping: with 1 sample it returns **3.5**, with 2 samples **3.0** (confirmed by direct execution of the exported function). 3.5 is 40% above the cap the issue explicitly set ("2.5 sits mid-band" of the 2-3x observed misses).
3. The dry-run line can print a multiplier that never scaled the displayed cost** — `cost-estimate.ts:278-285` records `verificationMultiplier` on shape-match estimates with `samples < MIN_SHAPE_SAMPLES` (the "insufficient data" branch, which has no usable cost), and `estimateGroup` (`:335-340`) takes `Math.max(...)` across all per-issue multipliers, which `buildEstimateSection` (`:398-400`) prints unconditionally. Reproduced real output:
4. ```
5. w1 (issues 1, 5 — split/test): expected ~$0.1000–$0.3000 · ~40–60 iterations · 3 sample(s) · 3.50x verification multiplier (1 issue(s) unmatched)
6. The "3.50x" is printed next to a cost that was scaled 1.0 — a false claim in the feature's primary user-facing output, exceeding the documented cap.
7. Evidence and a recommended fix (clamp `samples < MIN_SHAPE_SAMPLES` to the full multiplier; only surface the group multiplier when it actually scaled usable cost; add regression tests for samples=1 and samples=2) are posted in the reopened issue comment.
8. Issue #123 — CLEAN.** Every checkable claim reproduced: the model-facing review prompt and all five task-builder outputs contain `.headlesscode/scratch/` + "NEVER write to `/tmp`" (verified by actual prompt capture and direct builder invocation), `.gitignore:15` confirms `/.headlesscode/` is gitignored, docs updated, all new regression tests pass. Left closed with a verification comment.

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

Scope: #123, #124 only — rework cycle 1.