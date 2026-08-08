# Auto-index on session/round start — instructions for implementation

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI running a headless coding-agent loop.

Match this project's established style: no test framework (plain `tsx`-run
test files, hand-rolled `assert`, `All N tests passed` trailer); `npx tsc
--noEmit` and `npm test` must stay green; re-run every e2e suite under
`scripts/e2e*/run.sh`.

## The problem, observed live

`codebase_search` needs a pre-built index (`headlesscode index --workspace
<path>`) or it returns an actionable-but-useless error telling a human to go
build one. Nobody remembers to run that command routinely, so in practice:

1. A real round against `airunner` was found running with an index that was
   **3 days stale** (built 2026-08-04, repo at a 2026-08-07 commit) — and the
   commits in between touched exactly the database/migration code a worker
   was investigating. The worker tried `codebase_search` twice, got
   stale/unhelpful hits, and fell back to `grep`-via-`execute_command` for the
   rest of a 250-iteration session.
2. More commonly: a brand-new project has **no index at all**, so
   `codebase_search` is useless from iteration 1 and the blind-tree-walking
   guardrail (`src/engine/loop.ts`'s `hasCodebaseIndex` check) correctly
   suppresses its own nudge — but that just means the model never gets
   pointed at the tool in the first place.

This is a real, measured driver of the "why is the harness slow" investigation
(see git history / commit messages around the `isReadOnlyEquivalentShellCommand`
guardrail extension) — a worker that can't trust semantic search falls back to
dozens of exploratory shell commands instead.

**The index build is already incremental and safe to run often** — read
`src/codesearch/index.ts`'s header comment and `buildIndex` before touching
anything: every run walks the repo and re-hashes every file's chunks, but
only chunks whose content hash changed (or that are new, or were built with a
different embedding backend/model) actually get sent to the embedder;
unchanged chunks are copied over from the old index untouched. A no-op
refresh (nothing changed since last build) costs zero embedding calls — the
cost is bounded by the file-walk + hash pass, not by API spend. This is why
"just always run it automatically" is viable, not reckless.

## What "auto" means here — two trigger points, not one

1. **Orchestrator round start** (`src/orchestrator/cli.ts`'s `orchestrateMain`,
   near where the existing `--sync-*` git-sync check and the `--preflight`
   probe already run, BEFORE `splitIssues`/worker spawn): refresh the index
   for the round's repo ONCE, against the main checkout — not once per
   worktree. Read `src/project-store.ts`'s `resolveProjectIdentity` first:
   every git worktree of a repo already collapses onto the SAME project
   identity/data dir (`git rev-parse --git-common-dir`, resolved+parent'd),
   which is exactly why this must run ONCE centrally, not once per spawned
   worker — running it from inside `w1`'s worktree and `w2`'s worktree
   concurrently would have both processes racing to write the SAME
   `<dataRoot>/projects/<key>/codesearch/index.jsonl`, each walking whatever
   uncommitted state its OWN worktree happens to have. Do the refresh from
   the ORCHESTRATOR's own process, against `repo` (the main checkout path),
   BEFORE any worktree is created — that's committed-history state only,
   which is the right thing to index anyway (a worker's own not-yet-committed
   edits are transient and not worth indexing for its own benefit mid-session).
2. **Bare `headlesscode` CLI session start** (`src/cli.ts`, before
   `HeadlessSession.run()`): for the non-orchestrated, single-workspace case
   (a human or a script running `headlesscode --task-file ... --workspace
   <path>` directly, no orchestrator involved) — refresh the index for that
   one workspace before the loop starts. No concurrency concern here: one
   process, one workspace.

Continuation/rework re-spawns on an EXISTING worktree (mid-round) must NOT
re-trigger this — the round-start refresh already covered the round; a
continuation re-indexing mid-round reintroduces the exact race the design
above avoids, for no real benefit (the repo's committed state hasn't moved
since the round started).

## Non-fatal, throttled, and skippable — match the existing idiom

This codebase has a strong, consistent pattern for "auxiliary subsystem that
must never block or fail the thing it's helping" — checkpoints
(`src/checkpoints/service.ts`), context condensation (`src/engine/condense.ts`),
the cross-restart handoff summary (`src/engine/handoff.ts`). Follow it exactly:

- **Non-fatal**: any failure (no `HEADLESSCODE_OPENROUTER_API_KEY`, network
  error, embedder error) is caught, logged as a WARN with the real error
  message, and the round/session proceeds with whatever index exists (or
  none) — never abort startup because indexing failed.
- **Throttled**: store a last-refreshed timestamp (e.g. in the index's own
  `.meta.json`, or a sibling file) and skip the walk+hash pass entirely if it
  ran within the last `$HEADLESSCODE_AUTO_INDEX_MIN_INTERVAL_MS` (default:
  15 minutes) — a round-per-minute test loop must not re-walk a 50k-file repo
  every single time. Log the skip at INFO so it's visible, not silent.
- **Skippable**: `--skip-auto-index` flag on both `orchestrate` and the bare
  CLI, plus `$HEADLESSCODE_SKIP_AUTO_INDEX=1` — mirrors the existing
  `--no-preflight`/`--no-issue-size-check` convention in
  `src/orchestrator/cli.ts`. A CI/test environment with no API key configured
  must be able to turn this off cleanly instead of eating a warning every run.
- **Cost-visible, not cost-gated**: print the same cost summary line
  `headlesscode index` already prints (`src/codesearch/cli.ts`'s
  `estimateCost`/`priceFor` usage) so a human watching orchestrate's stdout
  sees exactly what got spent — but don't invent a new budget-approval gate
  for this; the existing `--skip-auto-index` opt-out is the cost control.

## A real duplication to clean up while you're in this code

Two modules independently reimplement "does an index exist / where is it":
`src/index-util.ts` (`indexFilePathFor`, `hasCodebaseIndex` — consumed by
`src/engine/loop.ts`'s blind-tree-walking guardrail) and `src/codesearch/index.ts`
(`indexFilePath`, `loadIndexMetadata` — consumed by `codebaseSearchHandler` in
`src/tools/executor.ts` and `src/codesearch/cli.ts`/`search.ts`). These
resolve to the same underlying path via two different code paths today (one
also checks a legacy pre-central-store location as a fallback). Consolidate
on ONE module — `src/codesearch/index.ts` is the more complete one (it also
has `loadIndexMetadata`) — and have `src/index-util.ts` either re-export from
it or be deleted with its one caller updated. Do this as part of adding the
auto-index trigger, since you'll be touching both call sites anyway; don't
leave two names for the same path lying around.

## Required verification (static/read-only per this repo's Testing Boundary)

- A fresh temp git repo with NO index: run the orchestrator dry-run path (or
  a small integration test) and confirm the auto-index step fires, an index
  gets built, and the round proceeds — never blocks on a missing index.
- The same repo run a second time within the throttle window: confirm the
  walk+hash pass is SKIPPED (log line present, no embedder calls made — this
  needs a fake/injectable embedder in the test, matching how
  `src/codesearch/__tests__/` already fakes the embedder for `buildIndex`
  tests).
- `HEADLESSCODE_SKIP_AUTO_INDEX=1` and `--skip-auto-index`: confirm no index
  build attempt happens at all (not even a stale-check).
- A failing embedder (bad/missing API key): confirm the round/session still
  starts and completes normally, with a WARN logged, not an abort.
- Two concurrent orchestrator invocations against the SAME repo (issue #15's
  scenario is directly relevant — this codebase already has patterns for
  "two orchestrate runs against one repo can coexist"): confirm the second
  one either skips (throttle window) or doesn't corrupt the index file (a
  lock or a last-writer-wins outcome is fine; a torn/invalid JSONL file is
  not — check `buildIndex`'s write path for atomicity, e.g. write-to-temp +
  rename, and add it if missing).

## Closing out

Once implemented and verified: `npx tsc --noEmit`, `npm test` (all files
green), re-run `scripts/e2e*/run.sh`. Open a PR against `master` with a real
before/after (index staleness before your change vs. an auto-refreshed index
after a round runs) and reference this plan file in the PR description.
