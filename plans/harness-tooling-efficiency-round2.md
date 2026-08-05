# Harness tooling efficiency, round 2: test selection, safe rename, same-file multi-diff clarity, commit finalization

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository —
a standalone Node/TypeScript CLI running a headless coding-agent loop. Match
the project's established conventions: no test framework beyond hand-rolled
`assert` + `tsx`-run test files, minimal new dependencies, `npx tsc --noEmit`
and `npm test` must stay green, re-run `scripts/e2e*/run.sh` afterward.

**IMPORTANT — commit your work before calling `attempt_completion`.** This
is not optional politeness: the previous round
(`plans/orchestrator-worktree-cleanup.md`) implemented, tested, and verified
2,210 lines of real working code (28 new tests, `tsc` clean, full suite
green) and then called `attempt_completion` WITHOUT committing any of it —
it sat as uncommitted working-tree changes until a human noticed and
committed it by hand. Traced why: neither the base system prompt
(`src/engine/prompt.ts`) nor the orchestrator's task-building code
(`src/orchestrator/cli.ts`) contains ANY instruction to commit before
finishing — nothing in the harness guarantees it. That systemic gap is item
4 below; until it's fixed, every task file (including this one) needs the
explicit instruction spelled out, so: **run `git add` + `git commit` for
every file you touch as part of finishing this task, before calling
`attempt_completion`.** Use a real, descriptive commit message per logical
change, not one giant commit — match this repo's normal commit style
(`git log --oneline` for examples).

This doc has four independent items, found by watching real headlesscode
sessions run live (not by inspection alone). Each section is self-contained
and can be dispatched as its own worktree/round if that's more convenient
than doing all four together — they don't depend on each other.

## 1. Test selection instead of always running the full suite

### The evidence

`package.json`'s `test` script runs 70+ separate `tsx`-invoked test files
sequentially, unconditionally — there is no glob, no dependency awareness,
no way to run a subset. Measured live: a single `npm test` call during a
real session (`.worktrees/speedeff`, 2026-08-04) took **111 seconds**
(16:34:19 → 16:36:10 in that run's `harness.log`) for a change scoped to a
handful of files. Every time a worker wants to verify "did I break
anything," it pays that full cost — this is the same shape of problem as
the airunner docker-per-test-invocation cost flagged in
`plans/speed-and-context-efficiency.md`'s root-cause analysis, recurring one
level down in headlesscode's own dev loop.

### What to build

A test-selection mechanism, exposed as a new tool (e.g. `run_tests`) rather
than requiring the model to hand-construct the right `tsx` invocation via
`execute_command` (it already can today, but nothing nudges or helps it do
this reliably — see "prompting" below):

- **Input**: one or more changed file paths (or infer from
  `git diff --name-only` against the session's baseline checkpoint if no
  explicit input is given — the checkpoint mechanism in `src/checkpoints/`
  already tracks a baseline per task).
- **Selection heuristic** (keep it simple — this doesn't need to be
  perfect, just much better than "always run everything"):
  1. Direct match: `src/foo/bar.ts` changed → run
     `src/foo/__tests__/bar.test.ts` if it exists.
  2. Reverse-dependency match: use the EXISTING import-graph tooling
     (`src/codeintel/import-graph.ts`, already built for the `import_graph`
     tool) to find which test files import the changed file (directly or
     transitively, capped at a shallow depth — don't build a full
     whole-program reachability solver for this, a 1-2 hop lookup catches
     the common case). This reuses real, already-correct import resolution
     instead of a new heuristic parser.
  3. If neither yields anything (e.g. a change to `package.json`, a script,
     or something with no direct test), fail safe: report "no specific
     tests matched — consider running the full suite" rather than silently
     running nothing.
- **Output**: run the matched test file(s) via the same `tsx` invocation
  `npm test` already uses per-file, and return pass/fail + relevant output,
  same shape as the existing `execute_command` tool result.
- The FULL suite is still what actually gates a merge/PR — this tool is for
  the **iterative edit-check-edit loop**, not a replacement for running
  `npm test` once for real confidence before calling `attempt_completion`.
  Make this expectation explicit in the tool's description so the model
  doesn't treat a passing selective run as equivalent to full-suite green.

### Prompting

Even without a new tool, cheaply nudge current behavior: add a line to the
system prompt (`src/engine/prompt.ts`) suggesting the model run the specific
test file(s) for what it just changed during iterative work, and reserve
the full `npm test` for before `attempt_completion`. This is worth doing
regardless of whether the new tool ships, and ships faster.

### Testing

- Unit tests for the selection heuristic against this repo's own real
  `import_graph` output (fixture: a small file that imports another, assert
  the importing test file gets selected).
- A test proving the "no match" fail-safe path reports honestly rather than
  silently running zero tests and claiming success.

## 2. Safe rename-across-references tool

### The evidence

`src/codeintel/` already has `find-references.ts`, `go-to-definition.ts`,
`import-graph.ts`, `outline.ts` — real, working structural code
intelligence, already wired into the tool list (confirmed live: a worker
used `outline` proactively during exploration in this session, before
falling back to `read_file`). But the EDIT side of a rename still goes
through generic `apply_diff`/`search_replace`, one file at a time — meaning
renaming a symbol used across N files costs N separate read+diff round
trips today, even though the tool needed to find every call site
(`findReferences`) already exists.

### What to build

A new tool (e.g. `rename_symbol`) in `src/codeintel/` (matching the existing
module layout — `rename-symbol.ts` alongside `find-references.ts`), wired
into `src/tools/executor.ts` the same way the other codeintel tools are:

- Input: file + position (or symbol name, matching however
  `go_to_definition`/`find_references` already identify a symbol — reuse
  that identification logic, don't reinvent it) + new name.
- Use `findReferences` (already built) to enumerate every call site across
  the workspace.
- Apply the rename at every site as a single atomic operation: either all
  sites update, or none do (partial rename leaving the codebase
  inconsistent is worse than the N-round-trip status quo it replaces) — on
  any single-site failure, roll back every edit already applied and return
  a clear error naming which site failed.
- Respect the same `ctx.workspaceRoot`/path-safety conventions the other
  tools use (`safeTarget` in `src/tools/executor.ts`).

### Scope guard

This is a TypeScript-project tool riding on the existing `ts.Program`-based
code-intel infra (`src/codeintel/program.ts`) — don't try to generalize it
to every language this project nominally indexes for `codebase_search`.
Scope it to what `find-references.ts`/`go-to-definition.ts` already support
today, whatever that boundary is; check `program.ts` for exactly which file
types it resolves before writing the rename logic.

### Testing

Mirror `src/codeintel/__tests__/find-references.test.ts`'s fixture pattern:
a small multi-file TS fixture where a symbol is used in 2-3 places, rename
it, assert every site updated and nothing else changed. Also test the
atomic-rollback path (force a failure on one site, assert no partial edits
survive).

## 3. Same-file multi-diff-in-one-turn failure clarity

### The evidence (confirmed precisely, not assumed)

Watched live in this session's cleanup-worktree test: two `apply_diff`
calls in the SAME assistant turn, both targeting
`src/github/__tests__/pr.test.ts` — the first succeeded, the second failed
immediately after.

Traced the actual mechanism in `applyDiffHandler`
(`src/tools/executor.ts:710-761`): it already does a FRESH
`fsp.readFile` on every single call (line 719) — there is no executor-side
staleness bug, each call correctly sees the current on-disk state. The
failure is a **model-composition** issue: the model planned both diffs
against ONE read of the file, then submitted them as two SEPARATE tool
calls instead of two SEARCH/REPLACE blocks within a SINGLE `apply_diff`
call. By the time the second call ran, the first had already changed the
file, so the second's SEARCH text no longer existed. The handler ALREADY
has a notice nudging toward single-call batching
(`src/tools/executor.ts:751-758`, "Making multiple related changes in a
single apply_diff is more efficient...") — but it only fires reactively,
AFTER a successful single-block diff, not before the mistake happens, and
it doesn't specifically address the same-file-multiple-calls-in-one-turn
case at all.

### What to build

Two complementary, additive changes (no executor staleness fix needed —
there isn't one; don't build a fix for a bug that isn't there):

1. **Detect the pattern at execution time and say so plainly.** When the
   loop executes multiple tool calls from one assistant turn
   (`src/engine/loop.ts`'s tool-execution path — find where it iterates
   `assistant.tool_calls`), track which file paths `apply_diff`/
   `search_replace`/`edit_file` calls in THIS batch have already touched.
   If a LATER call in the same batch fails against a path that an EARLIER
   call in the same batch already successfully modified, append a specific,
   actionable note to that failure's error message: something like "this
   file was already edited by an earlier tool call in this same turn —
   your SEARCH text may have been composed against the file's content
   BEFORE that edit; re-read the file to get its current state, or next
   time include both changes as separate SEARCH/REPLACE blocks in ONE
   apply_diff call." This turns a generic "diff didn't match" error (which
   the model has to reason its way out of) into a diagnosis pointing
   straight at the fix.
2. **Make the existing single-block notice fire proactively, not just
   reactively.** Consider surfacing the "batch related changes into one
   call" guidance in the system prompt itself
   (`src/engine/prompt.ts`) — a one-line mention alongside wherever
   `apply_diff` is already documented — rather than relying entirely on
   the model encountering the reactive notice after the fact.

### Testing

- A test driving two sequential `apply_diff` calls to the same file within
  one simulated turn (mirror how `src/tools/__tests__/apply_diff.test.ts`
  is structured) where the second's SEARCH text matches the PRE-first-edit
  content: assert the failure message contains the new same-file-in-batch
  diagnosis, not just the generic mismatch error.
- Confirm the notice change doesn't fire for the (common, correct) case of
  two calls to DIFFERENT files in one batch — only same-file collisions.

## 4. Systemic fix: nothing guarantees a worker commits its work

### The evidence

Confirmed directly: grepped `src/engine/prompt.ts` (the base system prompt)
and `src/orchestrator/cli.ts` (the orchestrator's task-file construction)
for any commit-related instruction — zero matches in either. A worker can
do real, correct, fully-tested work and call `attempt_completion` having
never run `git add`/`git commit`, and nothing in the harness notices or
corrects this. Confirmed live: exactly this happened with the
`orchestrator-worktree-cleanup` round.

### What to build

Bake a "commit before finishing" expectation into the harness itself rather
than relying on every task file to spell it out by hand (the workaround
this doc's own header uses, which doesn't scale):

- Add a line to the base system prompt (`src/engine/prompt.ts`) for `code`
  mode (and any other mode that edits files) stating that real, working
  changes must be committed via `git commit` before calling
  `attempt_completion` — matching whatever this repo's normal commit
  message conventions already are (point at real examples via `git log`,
  the same way this doc does).
- Consider a cheaper, structural backstop in addition to the prompt change:
  before accepting an `attempt_completion` call in `code`-family modes,
  check `git status --short` in the workspace — if there are uncommitted
  tracked-file changes, inject a corrective note back to the model instead
  of accepting completion silently (non-fatal, one retry nudge, not a hard
  block — a model with a genuine reason to leave something uncommitted,
  e.g. a read-only investigation task, shouldn't be forced to commit
  nothing). This is a real safety net independent of whether the prompt
  change alone is followed reliably.

### Testing

- A session-level test (mirror the pattern in
  `src/engine/__tests__/loop.test.ts`) asserting that a `code`-mode session
  ending with uncommitted tracked changes present gets the corrective nudge
  described above, and that a session with everything committed (or
  nothing to commit) does not.
- Don't apply the structural check to read-only or non-code modes — verify
  it's scoped correctly (check how mode capabilities are already
  distinguished elsewhere, e.g. `src/config/mode-models.ts` or the mode
  definitions, rather than inventing a new classification).
