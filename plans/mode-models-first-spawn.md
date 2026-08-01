# Fix: mode-models.json is silently ignored on a worker's FIRST spawn — instructions for implementation

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI that runs a headless coding-agent loop (ported
from a VS Code extension called Zoo Code, vendored under `src/vendor/zoo-code/`).

Match this project's established style: no test framework (plain `tsx`-run
test files, hand-rolled `assert`, `All N tests passed` trailer); `npx tsc
--noEmit` and `npm test` must stay green; re-run every e2e suite under
`scripts/e2e*/run.sh` afterward.

## The bug, confirmed by reading the actual code paths

`.headlesscode/mode-models.json` (`src/config/mode-models.ts`,
`resolveModelForMode`) was built so different modes/roles can use different
models (e.g. a cheap model for `code`, a reasoning model for
`deepseek-reviewer`). It works correctly for the reviewer, QA, and rework
re-spawn paths — but **not for a worker's own first spawn**, which is the
primary, most common path. Confirmed by reading the code, not assumed:

1. `src/orchestrator/cli.ts`'s `orchestrateMain` calls `resolveModelForMode`
   for `workerModel`/`reviewerModel`/`qaModel` at line ~809 — but this
   happens **after** step 2's `spawnSync("bash", ["-c", spawnCmd], ...)`
   call (line ~768), which is the actual initial worker spawn. `workerModel`
   is computed too late to affect it — grep the file for `workerModel` and
   confirm it's only read again later (~line 877), for the rework re-spawn
   path, never for the original spawn.
2. Worse: `scripts/spawn-parallel-worktrees.sh` (the actual shared spawn
   entry point — called both by `orchestrate`'s cli.ts above AND directly,
   standalone, by a human/orchestrator-mode agent for the pre-scoped
   task-file path used throughout this project's recent work) calls
   `scripts/run-worker.sh "$wt_path" "ORCHESTRATOR_TASK.md" --mode
   "$ORCH_MODE"` with **no `--model` flag at all** and has zero references
   to `mode-models.json` anywhere in the file (confirm with `grep -n
   "mode-models\|--model" scripts/spawn-parallel-worktrees.sh` — as of this
   writing it returns nothing). It relies entirely on whatever
   `OPENROUTER_MODEL` happens to be in the calling shell's environment,
   which is the RAW env var, not the resolved (mode-models.json-aware)
   value.

Net effect: a per-mode model mapping configured via the dashboard settings
page (or by hand-editing the JSON file) has **no effect whatsoever** on any
worker's actual first attempt — the exact case the feature exists for. It
only kicks in on a rework re-spawn, which most tasks never trigger. This is
silent — no error, no warning — so the config just looks like it's being
ignored for no visible reason.

## What to build

**The fix belongs at `scripts/spawn-parallel-worktrees.sh`, not (only) in
`orchestrate`'s cli.ts** — it's the one true common choke point both the
`orchestrate` path AND the direct/manual `spawn-parallel-worktrees.sh <name>:<offset>:<task-file>`
path (used constantly by the `multi-agent-orchestrator-headless` mode for
pre-scoped task files, per its own instructions in `.roomodes`) go through
before launching `run-worker.sh`. Fixing only `orchestrate/cli.ts` would
leave the direct path — the one actually used for most of this project's
recent task-file-driven work — still broken.

Concretely:
1. In `spawn-parallel-worktrees.sh`, before calling `run-worker.sh` for each
   worktree, resolve the model for that worktree's mode via
   `resolveModelForMode` — the cleanest way from bash is a small inline
   `node`/`npx tsx -e` call importing `resolveModelForMode` from
   `src/config/mode-models.ts` (built, compiled path may differ — check how
   other bash scripts in this project already shell out to run a bit of
   real TS logic, if any do; if none do, a tiny `npx tsx -e "..."` one-liner
   printing the resolved model id to stdout, captured into a bash variable,
   is fine and matches this project's "plain fs, no extra tooling" ethos).
   Pass `mode=$ORCH_MODE`, `workspaceRoot=$REPO_ROOT` (the real repo, not
   the worktree — `mode-models.json` should be read from wherever the
   project's config actually lives; check whether that should be
   `$REPO_ROOT` or `$wt_path` and justify your choice, since a fresh
   worktree may not have its own copy of `.headlesscode/mode-models.json`
   depending on what spawn already copies into it — read the worktree-setup
   section of this script to check).
2. Pass the resolved model explicitly to `run-worker.sh` via its existing
   `--model` flag (already supported, see `run-worker.sh`'s `MODEL`
   variable/`--model` argument handling — no new flag needed there).
3. `resolveModelForMode`'s own precedence must still hold: an explicit
   `--model` passed to `spawn-parallel-worktrees.sh` itself (if such a
   thing exists — check whether it currently accepts one; if not, decide
   whether adding that override is in scope or a separate concern) or an
   explicit `OPENROUTER_MODEL` env override at spawn time should still be
   respected as the top-priority override, matching the documented
   precedence in `src/config/mode-models.ts`'s header comment. Do not
   silently drop the ability to blanket-override every worker with one
   model, which is how this project's own task-file rounds have been run
   all along (`OPENROUTER_MODEL=deepseek/deepseek-v4-flash
   scripts/spawn-parallel-worktrees.sh ...`) — that pattern must keep
   working exactly as before when no mode-specific entry exists.
4. Separately, fix `src/orchestrator/cli.ts`'s ordering bug too (item 1
   above) even though the shell-script fix covers the direct path — move
   the `workerModel = resolveModelForMode(...)` computation for the
   worker's mode to BEFORE step 2's `spawnSync` call, and thread it into
   that call's env (it already builds an env object with `ORCHESTRATOR_MODE`
   etc. — add `OPENROUTER_MODEL: workerModel` there, matching how
   `HEADLESSCODE_PROJECT`/`HEADLESSCODE_MEMORY_DIR` are already
   conditionally added to that same env object). Both fixes are needed —
   they cover the two different call paths described above independently.

## What NOT to do

- Do not change `resolveModelForMode`'s precedence rules or signature —
  it's correct and already used correctly by reviewer/QA/rework; the bug is
  purely that the FIRST spawn never calls it (or, in the shell-script case,
  never even had a way to).
- Do not remove or weaken the existing "explicit override always wins"
  behavior that today's task-file rounds depend on.
- Do not add a new config file or duplicate `mode-models.json`'s logic in
  bash — call the real TypeScript resolution logic, don't reimplement it.

## Tests

- Extend or add to `src/orchestrator/__tests__/cli.test.ts` (or wherever the
  existing `orchestrate` spawn-env tests live — check current structure):
  prove that with a `mode-models.json` entry for the worker's mode, the
  `spawnSync` call's env actually carries the resolved model (inspect the
  captured env in the test, don't just check no error was thrown).
- A shell-level test or a `tsx`-run test that shells out to
  `spawn-parallel-worktrees.sh` against a fixture repo with a
  `mode-models.json` present, and asserts (via a fake/stub `run-worker.sh`
  captured invocation, or by checking the environment `run-worker.sh`
  actually received) that `--model` was passed with the resolved value —
  check `scripts/e2e*/` for existing examples of testing these bash scripts
  end-to-end and follow that pattern rather than inventing a new one.
- A regression test proving the "no mode-models.json present" case is
  unchanged (today's `OPENROUTER_MODEL=... spawn-parallel-worktrees.sh`
  blanket-override pattern still works exactly as before).

## Verification checklist

1. `npx tsc --noEmit` clean.
2. `npm test` — all suites green including new ones.
3. Every e2e suite under `scripts/e2e*/run.sh` still passes.
4. Manual proof, even without a real API key: create a scratch
   `mode-models.json` mapping `code` to some distinguishable fake model id,
   run `spawn-parallel-worktrees.sh` (or just the resolution step it now
   performs) against a fixture, and show in your report that the resolved
   value is what got passed to `run-worker.sh` — quote the actual command
   line or captured env, not just "it works."

## What to report back

- Files changed.
- Confirmation of tsc/test/e2e results (actual pass/fail counts).
- Where you put the model-resolution step in `spawn-parallel-worktrees.sh`
  and why (workspaceRoot choice, how the TS logic gets invoked from bash).
- Explicit confirmation that the existing blanket `OPENROUTER_MODEL=...`
  override pattern (used throughout this project's history) still works
  unchanged when no `mode-models.json` entry exists for a mode.
- Any deviation from this spec, and why.
