# `orchestrate status` must self-heal stale state, not just trust the file

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI running a headless coding-agent loop. This is
a direct follow-up to `plans/orchestrate-status-wait.md` (merged, live on
master as of this writing), fixing a real incident that happened the very
first time `--wait` was used for real.

## The real incident this task is fixing

`src/orchestrator/status.ts`'s own header comment states its design
assumption plainly: *"it never writes the file... the file is written by
`watch.ts`."* That assumption holds for the issue-driven `orchestrate` path
(which runs `watch.ts` internally, keeping `.orchestrator-state.json` live).
It does NOT hold for the direct task-file path
(`scripts/spawn-parallel-worktrees.sh`), which has no watcher at all —
historically, whoever was monitoring a direct-path round polled
`.harness.done`/`.harness.exit` marker files directly (the old bash loop
`orchestrate status --wait` was built to replace) and, if needed, hand-patched
the state file. Once `--wait` started trusting the state file exclusively,
it inherited this gap as a real bug.

**What actually happened (2026-08-02):** an interactive orchestrator agent
ran `orchestrate status --wait --timeout-ms 1800000` against this repo's own
`.orchestrator-state.json`. The call hung. Investigation found TWO distinct
causes, both worth fixing:

1. **A worker that had genuinely finished** (`ghpushpr` — exit 0,
   `.harness.done` present, process long dead) but whose group entry in the
   state file still said `"status": "running"` — nothing had ever updated
   it after `run-worker.sh` launched it.
2. **Eleven groups from far earlier rounds** (`cbsearch`, `ollamaemb`,
   `outsumm`, `mcp`, `browser`, `chatui`, `ckptui`, `fileperm`, `condense`,
   `stream`, `cscombo`) whose entries STILL said `"running"` even though
   every one of them was confirmed merged to master hours or days earlier
   (real merge commits exist for all 11, e.g. `6904082 Merge codebase_search
   activation`) — their worktrees were long since removed by
   `git worktree remove`, so there was no marker file left to check either.
   This is pure historical bookkeeping debt: nothing needed the `status`
   field to be accurate until `--wait` started trusting it.

Both had to be fixed by hand (a one-off `node -e` patch script) to unblock
the waiting caller. That's not sustainable — `orchestrate status` needs to
be trustworthy on its own.

## What to build

### 1. Reconcile against real markers before reporting or waiting

In `src/orchestrator/status.ts` (or a new small helper it calls — your
call on the cleanest split): before producing the one-shot summary, and on
EVERY poll iteration inside `--wait` (not just once at the start — a group
can finish mid-wait), for every group whose `status` is NOT already
terminal:

- If `group.worktree` (resolved relative to `--repo`) still exists on disk
  AND has a `.harness.done` marker: read `.harness.exit`, reconcile
  `status` to `"done"` (exit 0) or `"failed"` (non-zero), set `exit_code`,
  and persist the change back to `.orchestrator-state.json` via the
  existing `updateGroup`/`saveState` (`state.ts` — reuse, don't
  re-implement). This is the `ghpushpr` case: the ground truth exists,
  just wasn't propagated.
- If `group.worktree` no longer exists on disk at all (already removed —
  the `codeintel`/`localexplore`/etc. pattern of "merged; worktree
  removed") AND `status` is still non-terminal: this is genuinely
  ambiguous from the marker files alone (could mean cleanly merged-and-
  cleaned-up, could mean something went wrong before completion and the
  worktree was removed some other way). **Do not silently guess "done".**
  Introduce a new status value, e.g. `"orphaned"` (worktree gone, never
  reached a terminal status, no way to determine the real outcome from
  markers alone) — add it to `state.ts`'s `OrchestratorGroup.status` doc
  comment alongside the existing status values. Treat `"orphaned"` as
  terminal for `--wait`'s purposes (stop waiting — there's nothing further
  to wait FOR, the evidence is gone) but render it clearly and distinctly
  in both the one-shot and `--wait` summary output (not lumped in with
  `"done"`) so a human notices and can investigate via git history (as was
  done manually for this incident) rather than the status being silently
  misreported as an unremarkable success.
- If `group.worktree` still exists but has NEITHER `.harness.done` nor a
  live process at the recorded PID (check `group.last_activity`'s PID if
  present, or just the absence of `.harness.done` combined with the
  worktree still being present) — leave `status` as-is (still genuinely
  running or genuinely stalled; this task is not about second-guessing a
  worker that's actually still in progress). Do not mark it done/failed/
  orphaned just because you can't immediately prove it's still alive —
  only reconcile when you have positive evidence (`.harness.done` present,
  or the worktree being entirely gone).

### 2. `--json` output must include reconciliation info

If any group's status was changed by this reconciliation pass, note it in
the JSON output (e.g. a top-level `reconciled: string[]` listing group
names that were patched) so a caller can tell the state file was stale
before this call fixed it, not just silently trust the final numbers.

### 3. One-shot mode reconciles too, not just `--wait`

The one-shot form (`orchestrate status` without `--wait`) must run the same
reconciliation before printing — it's the more commonly used form and
should never print stale data either.

## What NOT to do

- Do not touch `watch.ts`'s own internal polling loop — this is a
  read-side reconciliation for EXTERNAL callers, same scope boundary
  `orchestrate-status-wait.md` already established.
- Do not try to reconstruct a group's real outcome from git history
  automatically (grepping merge commits, etc.) — that's what a human did
  manually for this incident, and it's too fuzzy/repo-specific to
  automate reliably. The `"orphaned"` status exists specifically so this
  case is surfaced honestly instead of guessed at.
- Do not mark a genuinely still-running group as done/failed/orphaned —
  only reconcile on positive evidence (a real marker file, or the
  worktree being entirely absent), never on absence-of-evidence alone.

## Tests

Extend `src/orchestrator/__tests__/status-cli.test.ts` (or add a sibling
file if cleaner):
- A group with `status: "running"` whose worktree has a real
  `.harness.done` + `.harness.exit` (0) gets reconciled to `"done"` before
  the summary is printed, and the state file on disk is actually updated
  (read it back after the call, assert the patch persisted).
- Same, with a non-zero exit code, reconciled to `"failed"`.
- A group with `status: "running"` whose worktree directory does not exist
  at all gets reconciled to `"orphaned"`, is treated as terminal for
  `--wait` purposes, and is rendered distinctly (not merged visually with
  real `"done"` groups) in both text and `--json` output.
- A group with `status: "running"` whose worktree EXISTS but has no
  `.harness.done` marker is left as `"running"` — reconciliation must not
  touch it.
- `--wait` against a state file with one stale-but-reconcilable group and
  no other non-terminal groups returns promptly (within one or two poll
  intervals) rather than waiting out the full timeout.

## Verification checklist

1. `npx tsc --noEmit` clean.
2. `npm test` — all suites green including new ones.
3. Every e2e suite under `scripts/e2e*/run.sh` still passes.
4. Manual: reproduce the actual incident. This repo's own
   `.worktrees/.orchestrator-state.json` currently has all 21 groups
   correctly marked `"done"` (hand-patched to unblock the live incident) —
   temporarily flip one back to `"running"` in a scratch copy of the file
   (do NOT modify the real repo state file), point the command at that
   scratch copy, confirm reconciliation fixes it, then discard the scratch
   copy.

## What to report back

- Files changed/added.
- Confirmation the new `"orphaned"` status is documented in `state.ts`'s
  doc comment and handled consistently in both text and `--json` output.
- Confirmation of tsc/test/e2e results.
- A description of the manual reproduction in item 4 above and its result.
- Any deviation from this spec, and why.
