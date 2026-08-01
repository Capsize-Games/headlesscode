# Automatic rework loop for `orchestrate` — instructions for implementation

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI that runs a headless coding-agent loop (ported
from a VS Code extension). `headlesscode orchestrate` (`src/orchestrator/cli.ts`)
splits GitHub issues across git worktrees, spawns a worker per group, watches
them to completion (`src/orchestrator/watch.ts`), then runs an automated
adversarial review (`src/orchestrator/reviewer.ts`) against each finished
group's worktree.

Match this project's established style:

- No test framework — plain `tsx`-run test files with hand-rolled assertions
  and an `All N tests passed` trailer (see `src/orchestrator/__tests__/*.test.ts`
  for the pattern). Add new test files to `package.json`'s `test` script the
  same way existing entries are chained with `&&`.
- Loose validation on the JSON state file — no schema library
  (`src/orchestrator/state.ts`'s own comments describe this ethos).
- `npx tsc --noEmit` and `npm test` (currently 22 suites) must stay green.
  Re-run all five e2e suites under `scripts/e2e*/run.sh` afterward — this
  work directly touches `e2e-phase2` and `e2e-phase4`'s territory (review +
  QA orchestration flow), so pay particular attention to those two.

## The problem

Today, `orchestrate`'s review step (`onGroupUpdate` in `src/orchestrator/cli.ts`,
around line 577) runs once per group: if the reviewer's verdict is `"finding"`
(not clean), the result is just recorded in `group.pending_review_findings`
and `group.review_verdict` — nothing acts on it. QA and the deploy gate are
skipped for that group (correctly — review must pass first), but the
underlying problem is never fixed. The round finishes with that group simply
left broken, and nothing in the harness tries again.

This harness is meant to run **unattended**, with no human watching in real
time (the interactive orchestrator agent, when present, only checks in
periodically). The original interactive design this project reimplements
(documented in the target repo's `.roomodes`, `multi-agent-orchestrator`
mode, "Step 4") explicitly loops: a review finding is treated as new work —
address it, re-verify, re-close — up to **3 rework cycles** per issue/group
before giving up and flagging it as needing a human. `orchestrate` currently
has no equivalent of this loop at all — it is a strict improvement gap versus
what this project is supposed to be at parity with, not a nice-to-have.

## What to build

Add an automatic rework loop to `orchestrate`'s watch/review flow:

1. **State schema** (`src/orchestrator/state.ts`, `OrchestratorGroup`): add a
   `reworkCount?: number` field (defaults to 0 when absent) tracking how many
   rework cycles a group has already gone through.

2. **On a `"finding"` verdict** (in the `onGroupUpdate` callback in
   `src/orchestrator/cli.ts`, right where `review_verdict`/
   `pending_review_findings` are currently just recorded):
   - If `group.reworkCount` (defaulting to 0) is **below** a cap (default 3,
     make it a new `--max-rework-cycles <n>` CLI option), automatically:
     a. Write a new task file for that group instructing the worker to fix
        the specific findings — reuse `buildTaskFileContent`'s existing
        structure/conventions (read it, it's in `src/orchestrator/cli.ts`)
        but produce a rework variant: include the original issue numbers,
        the literal `pending_review_findings` list, and clear instructions
        to address every finding, re-verify, and re-close/re-comment per
        the existing closing-report template. Write it to
        `plans/parallel-tasks/<name>-rework<n>.md` (n = new rework count) so
        prior task files aren't overwritten and stay inspectable.
     b. Re-launch a worker for that SAME worktree/group (reuse
        `scripts/run-worker.sh` the same way the initial spawn does — check
        how the initial spawn invokes it, likely via
        `scripts/spawn-parallel-worktrees.sh` or a direct call; a rework
        cycle does NOT need a new worktree/branch, it reuses the existing
        one, so it should call the worker-launch step directly rather than
        the full spawn script which also does worktree/branch/`.env` setup).
     c. Update the group's state: increment `reworkCount`, reset `status`
        back to `"running"`, clear `review_verdict`/`pending_review_findings`/
        `qa` (a fresh cycle needs a fresh review; don't leave stale QA
        results from before the rework), record `last_activity` noting the
        rework attempt number.
     d. The existing `watchGroups` polling loop should then naturally pick
        this group back up as `"running"` → `"done"` → re-reviewed, same as
        any other group — verify this actually works by tracing through
        `watchGroups`/`inspectGroup` rather than assuming.
   - If `group.reworkCount` has **reached** the cap: do NOT spawn again. Set
     a terminal state that clearly distinguishes "gave up after N rework
     attempts" from every other status — check `OrchestratorGroup`'s
     existing status values (`spawned`/`running`/`done`/`failed`/`blocked`)
     and decide whether to add a new status (e.g. `"needs-human"`) or reuse
     `"failed"` with a distinguishing field (your call — but it must be
     possible for something reading the state file, or the dashboard from
     the prior monitoring work, to tell "exhausted rework attempts, a human
     must look at this" apart from every other failure reason). Also print a
     clear line to stderr/stdout the moment this happens (mirror the style
     of the `BLOCKED:`-style lines added in the live-monitoring work, if
     that work has already landed — check `src/orchestrator/watch.ts` and
     `src/orchestrator/cli.ts` for whether transition-announcement lines
     already exist before adding your own separate mechanism; reuse it if
     so).

3. **Orchestrate's own exit behavior**: currently, at the end of a round, the
   CLI likely reports success/failure based on whether every group is
   `review_verdict === "clean"` (search `cli.ts` for `anyUnreviewed` — it
   already exists). Make sure a group that exhausted its rework attempts is
   correctly reflected in the final exit code/summary (it should NOT be
   silently treated the same as a group still mid-review — it's a distinct,
   final "needs a human" outcome).

4. **Do not change** how a group reaches `"blocked"` (the decision-escalation
   work from a separate task) — a blocked group is waiting on an answer, not
   in a rework cycle; these are two independent concepts. Don't conflate
   them.

## What NOT to do

- Do not change anything about how the FIRST attempt is spawned/reviewed —
  only add behavior for what happens after a `"finding"` verdict.
- Do not add rework logic to the standalone `headlesscode watch` (Phase 5
  GitHub issue watcher, `src/watcher/`) — this task is scoped to
  `orchestrate` only. If you think the watcher needs the same treatment,
  note it in your report rather than building it.
- Do not touch `~/Projects/airunner` — this work is entirely inside the
  `headlesscode` repository.

## Tests

- Extend `src/orchestrator/__tests__/cli.test.ts` (or wherever `orchestrate`'s
  own logic is tested — check for the right file first) with cases: a
  `"finding"` verdict below the cap triggers a rework spawn and resets state
  correctly; a `"finding"` verdict at the cap does NOT spawn again and
  reaches the terminal gave-up state instead; a clean verdict never touches
  `reworkCount` at all; multiple groups rework independently (one group's
  cycles don't affect another's).
- Re-run `scripts/e2e-phase2/run.sh` and `scripts/e2e-phase4/run.sh` — if
  either has a fixture reviewer that can be made to return a `"finding"`
  verdict, extend it to prove a real rework spawn happens end-to-end (not
  just at the unit level) — check how those e2e scripts fake the reviewer
  today (likely a mock LLM server, similar to `scripts/e2e/mock-openrouter.mjs`)
  before deciding whether adding a full e2e rework scenario is practical
  within existing fixtures, or whether unit coverage is sufficient — your
  call, but justify it in your report either way.

## What to report back

- Files changed/added.
- Confirmation `tsc`, `npm test`, and all five e2e suites pass (paste actual
  pass/fail counts).
- Whatever terminal-state design you chose (new status vs. reusing `"failed"`
  with a field) and why.
- Any deviation from this spec, and why.
- Anything you noticed while doing this that looks like a related bug or gap,
  even if unfixed — flag it rather than ignoring it.
