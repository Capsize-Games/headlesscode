# Deterministic worktree cleanup after merge

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI that runs a headless coding-agent loop and
orchestrates parallel worker sessions, each in its own `git worktree` under
`<repo>/.worktrees/<name>`. Match the project's established conventions: no
test framework beyond hand-rolled `assert` + `tsx`-run test files, minimal new
dependencies, `npx tsc --noEmit` and `npm test` must stay green, re-run the
`scripts/e2e*/run.sh` suites afterward.

## The problem, confirmed by code audit

There is currently **no automated worktree cleanup anywhere in the
orchestrator's production lifecycle.** I checked every place `git worktree`
appears in `src/orchestrator/*.ts` and `src/cli.ts`:

- `src/orchestrator/cli.ts`'s pre-spawn check (`orchestrateMain`, around line
  1345) treats a leftover `.worktrees/<name>` directory from a previous round
  as a **hard failure** — it refuses to spawn and tells the human to run
  `git worktree remove <path>` manually before retrying.
- `scripts/spawn-parallel-worktrees.sh` has the identical guard (exits 1 on
  collision).
- The only place in the whole codebase that actually calls
  `git worktree remove` in a real (non-test) code path is
  `src/cloud/provider.ts:232`, and that's the **cloud/docker session
  provider's** local-worktree fallback teardown for a *single* session — it
  has nothing to do with the orchestrator's parallel-round worktrees, and it
  calls `remove --force` unconditionally (no dirty-worktree check).
- Every other `git worktree remove` in the repo is inside `scripts/e2e*/run.sh`
  test fixture teardown (trap-based, cleans up the test's own throwaway
  fixture repos) — irrelevant to real orchestration.

So today, cleanup after a round is **100% a manual human step**, and nothing
verifies it's actually safe to do — which matches your instinct that this
needs to be handled carefully rather than just bolted on.

## Why this is genuinely hard (the design problem, not just the missing code)

1. **"Merged" is not one thing.** There are at least two workflows this
   orchestrator supports, and they need *different* deterministic checks:
   - **Local merge**: someone runs `git merge <branch>` (or fast-forward)
     into the base branch directly in the main repo. This is checkable with
     total certainty: `git merge-base --is-ancestor <branchTip> <base>` — if
     the branch's tip commit is an ancestor of the base branch's tip, every
     commit on that branch is provably in history. No guessing.
   - **GitHub PR merge (squash or rebase)**: GitHub creates a *new* commit
     with a different hash than anything on the worker's branch. The
     ancestor check above will say "not merged" even though the PR is
     merged — it's simply the wrong tool for this case. The only correct
     check here is asking GitHub directly: `GET
     /repos/{owner}/{repo}/pulls/{number}` and trusting the `.merged`
     boolean field GitHub computes server-side.
   - A cleanup mechanism that only checks one of these will silently refuse
     to clean up half your real usage, or — worse — will guess wrong and
     delete something that wasn't actually merged. **Both checks need to
     exist, dispatched by which workflow produced the group**, not one
     heuristic trying to cover both.
   - Note: nothing in the current codebase actually records a PR number
     against a group today (`OrchestratorGroup.pr` in `src/orchestrator/
     state.ts` is documented as "seen in the live airunner state file" but
     no in-repo code path writes it — `push-pr` is a fully separate manual
     CLI command, never invoked automatically from the orchestrator round).
     So the local-merge ancestor check is the one that matters for the
     workflow actually in use right now; the PR check is worth building for
     completeness but shouldn't block shipping the first version.

2. **Deletion is irreversible.** A worktree can contain uncommitted work
   (a worker mid-edit when the round was aborted, or a human who poked
   around in the worktree afterward). `git worktree remove --force` deletes
   uncommitted changes with zero recovery. Cleanup must refuse — not force
   past — a dirty worktree, and say why.

3. **A worktree can still be "in use."** If a worker process is still
   running (`.harness.pid` alive, or no `.harness.done` marker yet), it is
   not safe to remove regardless of what the branch's merge status says.

4. **Idempotency and auditability.** Cleanup needs to be safe to run
   repeatedly (already-cleaned groups are a no-op, not an error) and it
   needs to leave a trail — the state file already accumulates a full
   history per group (`actions_taken`, `last_activity`); cleanup should add
   to that record, never silently vanish a group's history.

## Proposed design

### 1. A deterministic "is this group's work merged?" predicate

New module, e.g. `src/orchestrator/merge-check.ts`:

```ts
export type MergeCheckResult =
  | { merged: true; via: "local-ancestor" | "github-pr"; detail: string }
  | { merged: false; via: "local-ancestor" | "github-pr" | "unknown"; detail: string }

// Local-merge check — no network, fully deterministic.
export function checkMergedByAncestor(repo: string, branch: string, baseBranch: string): MergeCheckResult

// GitHub PR check — only attempted when group.pr?.number is present.
export async function checkMergedByGitHubPr(options: {
  owner: string; repo: string; prNumber: number
  getInstallationToken: () => Promise<string>
}): Promise<MergeCheckResult>
```

`checkMergedByAncestor` shells out to
`git -C <repo> merge-base --is-ancestor <branchTip> <baseBranch>` (exit code
0 = ancestor = merged; exit code 1 = not merged; anything else = throw, don't
guess). `checkMergedByGitHubPr` needs one new function in `src/github/pr.ts`
(there's currently `openPullRequest` and `getRepoDefaultBranch` but nothing
that reads PR status back) — add `getPullRequestStatus` following the same
`ghHeaders`/token-injection pattern already used there.

The orchestrator tries `github-pr` first when `group.pr?.number` is set,
else falls back to `local-ancestor`. Never both silently merged with
disagreeing results without surfacing it — if both checks are available and
disagree, treat as **not merged** (fail closed) and log the discrepancy.

### 2. Safety gates before any deletion

For a group to be cleanup-eligible, ALL of the following must hold —
computed fresh each time, never cached from a prior round:

- `checkMergedByAncestor`/`checkMergedByGitHubPr` returns `merged: true`.
- `git -C <worktree> status --porcelain` is empty (no uncommitted changes).
- No live worker process: `<worktree>/.harness.pid` either absent or the
  PID is not running (reuse whatever liveness check `watch.ts` already uses
  for the stall guard — don't reinvent it).
- The group's orchestrator-state status is terminal (`done`, `failed`,
  `needs-human` — see `isTerminalStatus` in `src/orchestrator/status.ts`).
  A group still `spawned`/`running`/`blocked` is never touched.

Any gate failing → cleanup is a documented no-op for that group (report
*which* gate failed), not a silent skip.

### 3. An explicit, opt-in subcommand — not automatic

`headlesscode orchestrate cleanup --repo <path> [--base <branch>] [--dry-run] [--json]`

- **Default `--dry-run` behavior should be to print the plan (which groups
  are eligible, which are blocked and why) without touching anything** —
  matches this repo's existing convention for destructive/costly operations
  being explicit, separate steps (see `headlesscode index`'s own header
  comment: "a separate, EXPLICIT step — never auto-triggered"). Actually
  performing deletions requires a flag, e.g. `--yes` or `--apply`.
- For each eligible group, in fixed order (never reordered, so partial runs
  are resumable and idempotent):
  1. `git worktree remove <path>` (no `--force` — if this fails because the
     worktree is dirty, that means gate #2 above raced with something; abort
     that group's cleanup and report it, do NOT force).
  2. `git branch -d <branch>` (lowercase `-d`, which itself refuses to
     delete a branch not merged into the current HEAD — a second,
     independent safety net on top of the merge-check gate, basically free).
  3. Patch the group's state entry: add `cleaned_at: <ISO timestamp>` and
     append to `actions_taken` (e.g. `"worktree removed (merged via
     local-ancestor)"`). **Never delete the group entry itself** — the
     round's history stays queryable after cleanup, same philosophy as
     `orphaned` status in `status.ts`.
- Re-running cleanup on an already-cleaned group: worktree path no longer
  exists → treat as already-clean, no-op, no error (idempotent).
- A worktree that's merged but dirty, or merged but still has a live
  process for some reason: reported clearly as "merged but not safe to
  remove yet (<reason>)" — never force past it. If you eventually want a
  force option for genuinely stuck cases, it should be a distinct,
  loudly-labeled flag (e.g. `--force-remove <group-name>`, single-group
  only, never a blanket flag over the whole batch) — don't build this in
  the first version unless you hit a real case that needs it.

### 4. Visibility in `orchestrate status`

Extend the existing `orchestrate status` output (`src/orchestrator/
status.ts`) to show a cleanup-eligibility column/field per terminal group
(`cleanup: eligible | blocked (<reason>) | done`) computed via the same
gates above — read-only, no side effects — so a human can see at a glance
what a `cleanup --dry-run` would report, without running a separate command.

## What NOT to do

- Don't wire cleanup automatically into the watcher's terminal-status
  transition. Deletion is the one operation in this whole pipeline with no
  undo; keep it human-triggered (or at most a separately-scheduled
  `cleanup --apply` cron a human explicitly set up), consistent with how
  `headlesscode index` and the deploy gate are already kept as deliberate,
  separate, non-automatic steps in this codebase.
- Don't try to infer "merged" from commit message patterns, branch naming,
  or GitHub webhook events you're not already consuming. The two checks
  above (`merge-base --is-ancestor`, GitHub PR `.merged` field) are the only
  two sources of truth that can't lie to you; everything else is a heuristic
  with a false-positive failure mode that deletes real work.
- Don't make `git worktree remove` or `git branch -d` force-flagged by
  default. Their non-force refusal behavior IS the safety net; only bypass
  it per-group, explicitly, when a human has manually confirmed it's safe.

## Testing plan

- `checkMergedByAncestor`: unit test against a real throwaway git fixture
  (this repo's e2e fixtures already build disposable repos —
  `scripts/e2e-fixture/setup.sh` is the existing pattern) covering: branch
  fast-forward-merged → true; branch merged then base advanced further →
  still true (ancestor, not tip-equality); branch never merged → false;
  branch merged via squash (different hash) → correctly false (this is the
  documented limitation that motivates the GitHub-PR path).
- `checkMergedByGitHubPr`: unit test with a fake fetch (mirroring
  `src/github/__tests__/pr.test.ts`'s existing mock pattern) covering
  merged/unmerged/closed-not-merged/API-error cases.
- Cleanup command: dry-run never mutates (assert no `git worktree`/`branch`
  calls happen); safety-gate tests for each gate (dirty worktree, live
  process, non-terminal status, disagreement between the two merge checks)
  each independently proving that gate alone blocks cleanup; idempotency
  test (run `--apply` twice, second run is a clean no-op); partial-failure
  test (worktree removal fails → branch delete and state patch never run
  for that group).
- Re-run all `scripts/e2e*/run.sh` suites afterward since they create real
  worktrees and some already do their own manual cleanup in trap handlers —
  make sure the new subcommand doesn't collide with or duplicate that.
