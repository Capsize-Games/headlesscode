Project and mode-specific rules (from the central shared store and this project's own
.roo/rules*) are already spliced into your system prompt automatically — you do not
need to read any rules file yourself.

You are working autonomously in the SAME isolated git worktree as the previous attempt, on
the same branch. The automated adversarial reviewer found problems with that attempt. Read
this entire file before doing anything.

## Rework cycle 2 — address the review findings

Assigned issues: #116, #125, #126. The real title/body of each is inline below.

### Issue #116: BUG-17 [bug][MEDIUM] status --wait reconcile pre-empts the watcher and silently skips the review pass

## Severity
MEDIUM

## Audit area
bug

## Location
- `src/orchestrator/cli.ts:2005-2008` — the `status --wait` reconcile hook calls `reconcileGroups` and **persists** via `saveStateSync` whenever any group was reconciled.
- `src/orchestrator/status.ts:394-404` — `reconcileGroups` maps a worktree's `.harness.done` marker to `status: "done"` with the note `reconciled from .harness markers: worker completed cleanly (exit 0)`.
- `src/orchestrator/watch.ts:720-723` — the watcher's poll loop short-circuits any already-terminal group via `isTerminal(group)` → `recordCostIfSettled(group)` → `continue`, so `onGroupUpdate` (the log-analysis + review callback, `src/orchestrator/cli.ts:2842-2875`) never fires for a group another process already reconciled to done.

## Description
When `orchestrate status --wait` runs concurrently with an active orchestrate round, its read-side reconciliation (`cli.ts:2005`) patches non-terminal groups whose worktrees carry a `.harness.done` marker to `done` and persists that to the shared state file. The watcher's next poll then loads the group as already-terminal, hits the `isTerminal` continue at `watch.ts:720`, and never fires `onGroupUpdate` — so **log analysis and the automated review pass are silently skipped** for that group. The round still reports "Round complete: N/N groups terminal" while the group sits at `status: "done"` with `review_verdict` and `log_analysis` absent.

Caught live 2026-08-18 in round-2026-08-17: groups w13 (issues #62/#90/#98) and w14 (#63/#65) finished their workers but never received the automatic review because a concurrently-running `status --wait` had reconciled and persisted their done state first. They were only reviewed because the round operator noticed the missing `review_verdict` and ran `orchestrate review --group` manually — which is precisely what found the real CI bug in #90 (workflow red on the actual GitHub runner) that the skipped automatic review should have caught.

## Impact
Worker output can settle as `done` without ever passing the automated review gate, defeating the round's adversarial-review guarantee. Nothing fails loudly — the group simply has no `review_verdict` and no `log_analysis`, which is easy to miss when reading a "all groups terminal" summary.

## Remediation (any one)
1. `status --wait` should not persist reconciliation while a live watch loop owns the state (e.g. reconcile in-memory only for terminality checks, or detect a live round and skip persistence).
2. The watcher's terminality check should treat `done` with `review_verdict === undefined` as not-yet-settled and fire the review callback for groups that arrive already-reconciled.
3. At minimum, surface reconciled-without-review groups in status output (e.g. a "reconciled done, never reviewed" warning) so the gap is visible instead of silent.

## Repro
Start an orchestrate round; while workers run, invoke `orchestrate status --wait --json` from another terminal. When a worker finishes, the status call reconciles and persists `done`; the watcher then skips log analysis + review for that group. Verify via state: group `status: "done"`, `review_verdict` missing, `log_analysis` missing, `last_activity.note` = "reconciled from .harness markers: worker completed cleanly (exit 0)".

### Issue #125: ENH-3: Emit flagged higher-bound estimate for CI/config-changing groups in cost preflight

Severity: LOW (original issue #120).

### Problem
Cost preflight underestimates rounds containing CI/test-infrastructure work by 2-3x. Round-2026-08-17 preflight estimated ~$0.79; actual ~$2.09. Worst miss: w13 (issues #62/#90/#98, `test/hot`) estimated ~$0.05-$0.27, actual $1.03 (then $1.11 with review), because the diff added CI config and forced real GitHub-runner round-trips.

### Relevant code
- `src/orchestrator/cost-estimate.ts:37` — `MIN_SHAPE_SAMPLES = 3`
- `src/orchestrator/cost-estimate.ts:164` — `aggregateByShape` buckets recorded history by shape
- `src/orchestrator/cost-estimate.ts:187` — estimate relies on `byShape.length >= MIN_SHAPE_SAMPLES`

### Change
When a group's issues include a CI/config change (title or body matches `ci|workflow|actions|runner`), emit a flagged higher-bound estimate instead of the plain shape estimate. Wire this into the estimate generation path after `aggregateByShape` so the flag is visible to preflight callers.

### Verification
Run `orchestrate --dry-run` on a group whose issues include adding CI (`COV-1`-style). The output should show a flagged higher-bound estimate, and after the round completes that flagged estimate should be closer to the actual cost than the plain shape estimate was (previously 2-3x under-prediction).
### Issue #126: ENH-3: Surface unmatched-issue and no-history warnings prominently in preflight

Severity: LOW (original issue #120).

### Problem
Preflight output does not make it obvious when an estimate is built on thin or missing history. In round-2026-08-17, the w13 `test/hot` group produced a diagnostic of "2 issue(s) unmatched", and two groups (w15, w16) had "no history for this shape yet"; despite that, the total (~$0.79 preflight vs ~$2.09 actual) was presented without a prominent low-confidence flag.

### Relevant code
- `src/orchestrator/cost-estimate.ts:37` — `MIN_SHAPE_SAMPLES = 3`
- `src/orchestrator/cost-estimate.ts:164` — `aggregateByShape` buckets recorded history by shape
- `src/orchestrator/cost-estimate.ts:187` — estimate requires `byShape.length >= MIN_SHAPE_SAMPLES`

### Change
Surface "unmatched issue" and "no history for shape" warnings more prominently in preflight output. When a shape is under-sampled (`byShape.length < MIN_SHAPE_SAMPLES`) or issues are unmatched, mark that portion of the estimate as low-confidence so users can see the estimate is unreliable.

### Verification
Run `orchestrate --dry-run` on a group with a shape that has no history (w15/w16-style) and on a group with unmatched issues (w13-style). Confirm the warnings are displayed prominently and that the estimate is labeled low-confidence in both cases.

## Review findings to fix (from the automated review)

1. #116 (status --wait must not pre-empt the watcher) — REAL REGRESSION, reopened.**
2. The rework fix (be11a6d) reintroduces the exact pre-emption bug #116 was filed for, in the live-watcher + mid-wait-finish case:
3. `watchHeartbeat()` (`src/orchestrator/status.ts:575-585`, invoked at `status.ts:671` on every poll) unconditionally writes the wait's own PID into the **shared** `<statePath>.watcher` file — the same file the live watcher writes.
4. `liveWatcher()` (`status.ts:552-573`) requires a fresh heartbeat written by a **different** PID; from the second poll onward it reads the wait's own PID and returns `false`.
5. `reconcilePass` (`status.ts:593-604`) then persists the `done` reconcile to disk while a real watcher owns the round. The watcher's next poll (`watch.ts:742` `isTerminal(group)` short-circuit) sees the already-done group and silently skips log analysis + review — the exact #116 symptom.
6. Repro (fresh heartbeat PID 99999 simulating a live watcher, worker finishes mid-wait): HEAD `be11a6d` persists ON-DISK `done`; parent `425a12f` (first fix) correctly leaves ON-DISK `running`. The new tests miss it because the fresh-heartbeat test creates the markers before the wait's first poll (before the wait's own heartbeat clobbers the file), and the mid-wait test has no live watcher.
7. #125 (CI/config higher bound) — clean.** Verified real calls: keyword matching + false-positive rejection, higher-bound math (0.4×3 + 0.4 = $1.60) and rendering correct. 20/20 tests.
8. #126 (low-confidence flags) — clean.** Verified real calls: no-history → flagged, under-sampled direct match → flagged, solid estimate → no marker. 20/20 tests.
9. Baseline confirmed (re-run on HEAD be11a6d):** `tsc --noEmit` clean; status-cli 23/23, watch 22/22, cost-estimate 20/20; full suite 118 files, 1045 ok, sole failure `run-tests.test.ts` hostile-path — pre-existing (reproduced identically on parent 09ffd91); PR #130 CI green on both commits.

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
## Issue <n> — Closing Report (rework cycle 2)

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

Scope: #116, #125, #126 only — rework cycle 2.