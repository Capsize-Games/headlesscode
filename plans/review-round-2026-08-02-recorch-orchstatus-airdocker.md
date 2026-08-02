# Independent review — 2026-08-02 three-task direct-path batch (worktrees still live)

Follow `plans/review-mode-prompt.md`'s full operating procedure — this document
only adapts it for this specific round. **All three worktrees are still live
under `.worktrees/` and NOT yet merged** — review each against its checked-out
branch before any merge happens. The coordinator will not merge on
self-verification alone.

**Why this review exists:** this round used the direct task-file path
(`spawn-parallel-worktrees.sh`), which has no automated review/rework step by
design. One task (`recorch`) changes core loop semantics (`src/engine/loop.ts`),
the tool executor (`src/tools/executor.ts`), budget sharing, and checkpoints —
significant by definition per the round-level rules. The other two touch
orchestrator CLI surface and a separate repo (`~/Projects/airunner`). The
project owner explicitly asked for one independent adversarial pass over all
three together before trusting anything further. Approach with the same
"assume at least one overstated claim until personally confirmed" posture
`review-mode-prompt.md` describes.

## The three worktrees + their specs

1. **recorch** — `.worktrees/recorch` (branch `issues/recorch-2026-08-02`),
   spec `plans/recursive-orchestrator-mode.md`. Headless-native `new_task`
   implementation: recursion depth cap, shared budget tracker, child iteration
   containment, checkpoint lineage, event-feed lineage fields, the `new_task`
   handler + "must be called alone" enforcement, moved from stub to
   `IMPLEMENTED_TOOLS`. Worker's own report claims: 6-file diff (loop.ts +417,
   cli.ts +50, events.ts +21, prompt.ts +5, executor.ts +7, package.json), new
   `src/engine/__tests__/new-task.test.ts` (6 tests), 69 suites green, all 7
   e2e suites pass, real-API smoke NOT run (no key claimed).
2. **orchstatus** — `.worktrees/orchstatus` (branch `issues/orchstatus-2026-08-02`),
   spec `plans/orchestrate-status-wait.md`. New `headlesscode orchestrate status`
   subcommand: one-shot + `--wait` + `--json`, `src/orchestrator/status.ts`,
   `cli.ts` dispatch, docs, plus updating `~/Projects/airunner/.roomodes` and
   `.roo/rules-multi-agent-orchestrator-headless/rules.md` (done via
   `execute_command`/shell because file tools are worktree-scoped). Report
   claims 14 tests, tsc clean, full npm test, all 7 e2e suites.
3. **airdocker** — `.worktrees/airdocker` (branch `issues/airdocker-2026-08-02`),
   spec `plans/airunner-docker-packaging.md`. Docker packaging for headlesscode
   inside airunner's deployment: Dockerfile addition/stage, install strategy,
   `/data` volume workspace placement, Playwright decision, env wiring docs,
   `scripts/docker-smoke.sh`, and airunner-side changes
   (`extensions/docker/docker-compose.headlesscode.yml` — untracked in
   `~/Projects/airunner`). Report claims docker smoke 6/6 passed, image built,
   tsc clean, 68 suites green (per its own count — verify against actual), all
   7 e2e suites, `docker compose config` valid.

## Prioritized review items — read before anything else

**1. recorch — the genuinely dangerous class of work.** Verify personally, not
from the report:
- `npx tsc --noEmit` in the worktree; `npm test` in the worktree; compare the
  actual suite/pass counts to the claim (69 suites, new-task 6/6). The report
  claims "real-API smoke not run — no OpenRouter key available" — that is
  itself a suspicious claim (the coordinator DID export the key at spawn via
  `. ./.env`), so specifically check whether that's an honest limitation or a
  worker that gave up on the smoke step; either way it's a reportable fact, not
  a pass/fail on its own.
- **Budget sharing (#2 in spec)**: read the diff to `src/engine/loop.ts`
  around the child-session construction and the shared `BudgetTracker` threading.
  Verify the new-task test really proves a child-only spend trips the shared
  cap (run the test; read what it asserts). This is the single most
  cost-relevant claim in the round.
- **Recursion depth cap (#1)**: confirm the refusal is a normal tool error
  (counts toward `consecutiveMistakes`), never a crash, and the parent session
  continues after it.
- **"Must be called alone" enforcement**: the report says it's a loop-level
  check in `runIterations` (`src/engine/loop.ts:1386`) computing
  `refusedNewTaskIds` from the whole `calls` batch. Verify the sibling calls in
  the same turn still execute while `new_task` is refused. Also read the
  **flagged pre-existing gap**: `attempt_completion` + `new_task` in one turn
  short-circuits at loop.ts:1396 and silently completes without delegating —
  the worker says this predates it and left it unfixed. Judge whether that
  claim is accurate and whether it's acceptable, and report it either way.
- **Checkpoint lineage (#4)**: verify a child edit actually produces a
  checkpoint in the same shadow-git history as the parent with the lineage tag
  (`Task: <parentId>/<childId>`), per the test the worker wrote.
- **Event-feed lineage (#5)**: verify `parentSessionId`/`recursionDepth` are
  added as optional fields without breaking the existing `EventRecord` shape,
  and that children write their own `.jsonl` under their own session id.
- **What NOT to do**: confirm the worker did NOT touch `orchestrate` /
  `spawn-parallel-worktrees.sh` / process-worktree machinery, and did not
  implement any paused-parent UI concept or cross-session disk persistence.
- **Loop-risk scan**: read the whole `src/engine/loop.ts` diff for silent
  behavior changes to existing functions (the 417-line addition is large;
  prioritize anything that alters existing control flow, e.g. where the child
  call blocks the parent loop, budget clock pause/resume, or error handling).

**2. orchstatus — read-side CLI + cross-repo instructions update.**
- Run `npx tsc --noEmit` and `npm test` in the worktree; verify the 14-test
  count and the `--wait` semantics (blocks until all terminal; `blocked` is
  NOT terminal; `--timeout-ms` bounds it; exit code reflects outcome). Run the
  new command against the REAL live `.worktrees/.orchestrator-state.json` (it
  has 20 groups, several stale "running") and confirm output is sane.
- **Item 3 — the airunner instructions update**: the worker claims it edited
  `~/Projects/airunner/.roomodes` and
  `~/Projects/airunner/.roo/rules-multi-agent-orchestrator-headless/rules.md`
  via a shell/Python replace script. Verify those files ACTUALLY changed and
  the old grep-based polling loop is gone, and that the YAML still parses. This
  was the "actual point" of the task's why-section — silently skipping it is a
  real finding.
- **What NOT to do**: confirm `src/orchestrator/watch.ts`'s internal polling
  loop is untouched, `.orchestrator-state.json` schema unchanged, and no
  general-purpose file watcher was built.

**3. airdocker — Docker packaging + separate-repo changes.**
- Run `bash scripts/docker-smoke.sh` in the worktree (or the exact smoke
  command the report quotes) and confirm the 6/6 claim with real output. Verify
  the image actually builds.
- Run `npx tsc --noEmit` + `npm test` in the worktree; compare suite counts to
  the report's claim (it says "68 suites"; orchstatus/recorch rounds said 69 —
  the baseline moved, so verify against reality, and note whether the count
  delta is explained by new tests in OTHER worktrees, which is expected since
  all three branches diverged from the same master).
- **Airunner side**: verify `~/Projects/airunner/extensions/docker/
  docker-compose.headlesscode.yml` exists and is additive/opt-in (new
  service/profile, does NOT change the existing `server` service behavior);
  run `docker compose config` on the merged file(s) if practical. Confirm no
  `/var/run/docker.sock` mount or `docker` CLI install was added (the report
  claims zero hits — reproduce the grep).
- **Option (a) vs (b) decision**: the report claims a sidecar-service choice
  (option b). Verify the Dockerfile/compose actually implement a sidecar (or
  whatever the report claims) and that the reasoning in the report matches what
  the files do.
- **Cross-repo interference**: orchstatus and airdocker BOTH wrote into
  `~/Projects/airunner` (different files: `.roomodes`/rules vs
  `docker-compose.headlesscode.yml`). Confirm they did not clobber each other
  and the airunner repo's own committed state is intact (`git -C
  ~/Projects/airunner status --short` should show only the expected untracked/
  modified files, plus whatever was already there before this round — the
  repo had pre-existing untracked files like `plans/parallel-tasks/*` and
  `scripts/headlesscode-orchestrate.sh` before this round started).

## What to report back

Follow `review-mode-prompt.md`'s verdict format exactly: pass/fail per task
(not just an overall verdict), with real command output as evidence for
anything you confirm, and file:line-precise, actionable findings for anything
you don't. Lead with recorch's budget-sharing and loop-risk findings, then the
airunner-repo verification for orchstatus and airdocker, since those are the
classes of bug self-verification is weakest against.
