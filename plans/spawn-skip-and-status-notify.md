# Spawn: fail on stale worktree dirs + `orchestrate status --wait` per-group terminal notifications

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI running a headless coding-agent loop, with a
multi-agent orchestrator (`headlesscode orchestrate`, `src/orchestrator/`)
that spawns worker sessions in separate git worktrees and tracks their
progress in `.worktrees/.orchestrator-state.json` (schema:
`src/orchestrator/state.ts`'s `OrchestratorState`/`OrchestratorGroup`).

## The real incident these fixes are for

Both surfaced by a real orchestrate round on 2026-08-04 against
`~/Projects/airunner` (`--issue 68 --issue 69 --issue 70 --issue 71`).

### Bug 1 — [scripts/spawn-parallel-worktrees.sh](scripts/spawn-parallel-worktrees.sh:186) silently drops a group when its worktree dir already exists

`.worktrees/w1` in the target repo was a leftover from a previous round
(never cleaned up — no automated purge exists). The spawn script printed:

```
Skipping w1 — /home/joe/Projects/airunner/.worktrees/w1 already exists.
```

and `continue`d to w2/w3/w4 — but w1 never got a worker spawned, was never
added to `.orchestrator-state.json`, and the script exited 0. From the
outside, a skipped-at-spawn group is indistinguishable from a round that
only ever asked for 3 groups. The person driving the round has no signal
that 25% of the requested work silently never happened.

### Bug 2 — `orchestrate status --wait` can't report a partial failure until the whole round is terminal

`--wait` blocks until every group reaches a terminal state
(done/failed/needs-human). In the same round, w2 and w3 both failed (exit 1)
within the first ~15 iterations, while w4 kept running for another ~800k
tokens before finishing. Anyone using `--wait` had no way to learn about the
two early failures until the whole round finished — there's no way to react
to a failed group early without hand-rolling a poll loop over
`.orchestrator-state.json` yourself (which the project's own docs currently
recommend `--wait` specifically to avoid).

## What to build

### 1. Pre-spawn collision check — fail up front, not silently skip

In [`src/orchestrator/cli.ts`](src/orchestrator/cli.ts:1335), in the `orchestrateMain` function,
after task files are written (step 1b, currently around line 1336) and
concurrency checks, but **before** the spawn command is built/executed (step 2,
around line 1357): iterate over all `specs`, resolve
`path.join(repo, ".worktrees", spec.name)`, and if ANY such path already
exists on disk (`fs.existsSync`), print a clear error listing every
colliding path (e.g. "Stale worktree(s) found: .worktrees/w1, .worktrees/w3.
Remove them first (`git worktree remove ...`) then retry.") and exit non-zero
**before spawning anything**. This forces the caller to clean up stale
worktrees — it's the safest default and matches the project's
fail-loudly-on-surprise convention.

**Defense in depth in the bash script:** In
[`scripts/spawn-parallel-worktrees.sh`](scripts/spawn-parallel-worktrees.sh:186), the
pre-existing `if [ -d "$wt_path" ]` block currently does:

```sh
echo "Skipping $name — $wt_path already exists."
continue
```

Change this to:

```sh
echo "ERROR: $name — $wt_path already exists. Remove it first (git worktree remove ...) then retry." >&2
exit 1
```

The orchestrator-level check above means this code path should never be hit
under normal usage — but if someone invokes the script directly without the
up-front check, it fails loudly instead of silently dropping groups. The
`exit 1` propagates to the orchestrator's `spawnSync` result check at
[`cli.ts:1369`](src/orchestrator/cli.ts:1369) which already handles non-zero exit.

### 2. `--on-group-terminal <cmd>` hook for `orchestrate status --wait`

Add a way to observe per-group state transitions as they happen during a
`--wait`, not just the final all-terminal barrier. The transition-detection
pattern already exists internally in
[`watchGroups`](src/orchestrator/watch.ts:488) (the `lastSeenStatus` Map +
`printStatusTransition` on genuine changes) — this is about exposing that
same information externally for callers using `--wait`.

#### 2a. Add `onGroupTerminal` to [`WaitForTerminalOptions`](src/orchestrator/status.ts:382)

In `src/orchestrator/status.ts`, add an optional callback to
`WaitForTerminalOptions`:

```ts
/**
 * Called immediately when a group transitions to a terminal status
 * (done/failed/needs-human/orphaned) during the wait — fires once per
 * group per transition. Does NOT fire for non-terminal transitions
 * (blocked, running, spawned). Never called for groups that were already
 * terminal before the wait started.
 */
onGroupTerminal?: (group: OrchestratorGroup) => void
```

#### 2b. Implement transition detection in `waitForTerminalState`

In the poll loop of [`waitForTerminalState`](src/orchestrator/status.ts:421), add a
`lastSeenStatus` Map (same pattern as `watchGroups` at
[`watch.ts:491`](src/orchestrator/watch.ts:491)):

- Seed it from the initial state's groups.
- On each successful poll, for each group, compare the current status to the
  previously-seen status.
- When a group transitions **into** a terminal status (and wasn't terminal
  before), call `onGroupTerminal(group)`.
- Update `lastSeenStatus` after checking.

Reconciliation runs BEFORE transition detection on each poll — a group that
gets reconciled from "running" to "failed" by `reconcileGroups` should NOT
trigger the callback (it was always terminal, just stale in the file). Detect
genuine transitions by comparing AFTER reconciliation against the
previously-seen (already-reconciled) status.

#### 2c. Wire `--on-group-terminal <cmd>` in `statusMain`

In [`src/orchestrator/cli.ts`](src/orchestrator/cli.ts:1055):

- Add `onGroupTerminal?: string` to the `StatusOptions` interface.
- Add `--on-group-terminal <cmd>` to `parseStatusArgs` (like `--timeout-ms`,
  consumes the next arg).
- In `statusMain`, when `--on-group-terminal` is set, pass an
  `onGroupTerminal` callback to `waitForTerminalState` that spawns `<cmd>`
  with two positional arguments: `<group-name>` and `<status>`.

  Use `child_process.spawn(cmd, [group.name, group.status], { stdio: 'inherit' })`
  and `await` the completion so terminal transitions are processed
  sequentially. Terminal transitions are rare events, and blocking the poll
  loop for the duration of the hook is fine.

  If the hook command fails (non-zero exit), log a warning to stderr but
  continue the wait — a broken hook should not abort the wait.

#### 2d. `--json` output when combined with `--on-group-terminal` + `--wait`

When `--wait` with `--on-group-terminal` is also passed `--json`, the final
JSON output (when all groups are terminal or timed out) is unchanged from the
existing `--wait --json` format. The hook's stdout is separate — it's the
hook command's own output, not part of `orchestrate status`'s stdout.

### 3. Update usage text

Update the usage string for `orchestrate status` (look for `STATUS_USAGE` in
`cli.ts`) to document the new `--on-group-terminal <cmd>` flag. Also confirm
the spawn script's error message for existing worktrees is self-documenting.

## What NOT to do

- Do NOT add a `--force` flag or automatic cleanup to the spawn script — the
  deliberate choice is to fail loudly and make the caller clean up stale
  worktrees explicitly. Automatic cleanup risks removing a worktree that's
  still in use by a running worker process.
- Do NOT add a `--skip-stale` or soft-skip-with-state-entry option — the
  `"skipped-stale-worktree"` status was considered but rejected because a
  stale worktree dir means the caller needs to make a deliberate decision
  about it (was the previous round done? did it fail?), and silently
  recording "skipped" in the state file hides that decision point.
- Do NOT change `--wait`'s default behavior (wait for full completion) —
  that's still the right default for unattended rounds. This is purely
  additive.
- Do NOT fire `onGroupTerminal` for groups that were already terminal before
  the wait started — only genuine transitions.
- Do NOT fire `onGroupTerminal` for groups whose status changed only because
  of reconciliation (stale state fixed by `reconcileGroups`) — the callback
  is for real, live transitions detected by the watcher or worker finishing.

## Tests

### For Bug 1 (pre-spawn collision check)

Extend `src/orchestrator/__tests__/cli.test.ts`:

- **Pre-spawn collision exits with error:** Create a temp repo, write task
  files, create a pre-existing `.worktrees/w1` directory, then call
  `orchestrateMain` with `--repo` pointing to it. Assert the exit code is
  non-zero and the error message names the colliding path.
- **No collision when all worktree dirs are clear:** Same setup without the
  pre-existing dir — assert the spawn command is built and invoked (or
  reaches the step that would invoke it — a dry-run equivalent is fine).

For the bash script change, extend or add to the existing spawn-model tests
(`src/orchestrator/__tests__/spawn-model.test.ts`):

- **Existing worktree dir causes non-zero exit:** Run the spawn script
  against a fixture that already has a worktree dir for the requested group.
  Assert the exit code is non-zero and stderr contains the error.
- **No existing worktree dir succeeds as before:** Existing passing tests
  should confirm this — verify they still pass.

### For Bug 2 (--on-group-terminal)

Extend `src/orchestrator/__tests__/status-cli.test.ts`:

- **Callback fires on genuine terminal transition:** Use the injectable
  `readState` to simulate a group transitioning from "running" to "failed"
  mid-wait. Pass an `onGroupTerminal` callback that records the call. Assert
  the callback was called exactly once with the correct group name and
  status.
- **Callback does NOT fire for already-terminal groups:** Start with a
  "done" group from the first poll — assert the callback is never called.
- **Callback does NOT fire for reconciliation-only changes:** Start with a
  group in "running" status, but the reconciliation step changes it to
  "failed" (simulate via `.harness.done` marker). Since the group was never
  genuinely "running" in this scenario, the callback should not fire.
- **CLI flag parsing:** `--on-group-terminal "echo"` is accepted;
  `--on-group-terminal` with no value produces a parse error.
- **CLI flag wired to spawn:** End-to-end: a temp repo with a state file
  that transitions from running to done mid-wait, `--on-group-terminal`
  pointing at a test script that records args. Assert the script was called
  with the correct arguments.

## Verification checklist

1. `npx tsc --noEmit` clean.
2. `npm test` — all suites green including new ones.
3. Every e2e suite under `scripts/e2e*/run.sh` still passes.
4. Manual reproduction for Bug 1:
   - In a scratch git repo with a `.worktrees/w1` dir from a prior
     `git worktree add`, run `headlesscode orchestrate --repo <path> --issue 1 --dry-run`.
   - Update: since `--dry-run` exits early (before the collision check would
     normally run), use the real orchestrate path or add the collision check
     BEFORE the dry-run early-exit so `--dry-run` also catches stale
     worktrees.
   - Actually, reconsider: the collision check belongs BEFORE the spawn
     command, and `--dry-run` exits at step 1c (after printing the plan).
     Move the collision check earlier — right after step 1b (task files
     written) but before 1c (model resolution) — so it catches stale
     worktrees even in `--dry-run` mode.
5. Manual reproduction for Bug 2:
   - Set up a temp state file with one "running" group. Run
     `orchestrate status --repo <tmp> --wait --timeout-ms 30000 --on-group-terminal "echo GOT:"`
     in the background. Manually update the state file to mark the group
     "done". Confirm `GOT: <name> done` appears on stdout before the wait
     returns.

## What to report back

- Files changed/added.
- Confirmation that the collision check runs even in `--dry-run` mode (step
  4 in verification).
- Confirmation the `onGroupTerminal` callback does not fire for
  reconciliation-only changes or already-terminal groups.
- Confirmation of tsc/test/e2e results.
- Updated `STATUS_USAGE` string showing the new `--on-group-terminal` flag.
- Any deviation from this spec, and why.
