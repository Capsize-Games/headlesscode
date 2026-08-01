## What this repo is

`headlesscode` is a standalone Node/TypeScript CLI that runs a headless
coding-agent loop, ported from a VS Code extension (vendored verbatim under
`src/vendor/zoo-code/`, Apache-2.0, see `ATTRIBUTION.md`). It has no build
step to run — everything runs directly via `tsx`.

## Verification bar

Before considering any change to `src/` done:

- `npx tsc --noEmit` must be clean.
- `npm test` must pass in full — this project does NOT use a test
  framework (no jest/mocha/vitest). Tests are plain `.test.ts` files run
  directly via `tsx`, with hand-rolled assertions and an `All N tests
  passed` trailer line. Look at any existing `src/*/__tests__/*.test.ts`
  file for the exact style before writing a new one. New test files must be
  added to the `test` script in `package.json` (chained with `&&`).
- If the change touches the orchestrator, watcher, or spawn/worker
  scripts (`src/orchestrator/`, `src/watcher/`, `scripts/*.sh`), also
  re-run the relevant suites under `scripts/e2e*/run.sh` — these exercise
  real spawn/watch/review flows against a local mock LLM server, not just
  unit-level logic.

## Established conventions

- **No new runtime dependencies without a real reason.** This project
  deliberately avoids frameworks and schema libraries for its own
  state/JSON handling (plain `node:fs`/`node:http`, loose JSON validation
  — see `src/orchestrator/state.ts`'s own comments). Prefer the smallest
  dependency footprint that does the job.
- **Non-fatal failure pattern for auxiliary subsystems.** Memory
  recording, checkpoint saving, and usage/cost recording all follow the
  same idiom: wrap the operation in try/catch, log a warning via the
  session's logger, and never let a failure in one of these subsystems
  abort or corrupt the actual coding session. Grep for `non-fatal` in
  `src/engine/loop.ts` to see the exact pattern before adding a new
  auxiliary write path — match it.
- **Vendoring convention.** Code ported from the upstream VS Code
  extension lives under `src/vendor/zoo-code/`, copied verbatim wherever
  practical, with a corresponding entry added to `ATTRIBUTION.md`. VS
  Code API calls the vendored code still makes are satisfied by no-op
  shims under `src/vendor/zoo-code/shim/`, wired via `tsconfig.json`'s
  `paths` (not real npm packages) — check there before assuming something
  needs a new shim.
- **Comments.** Minimal. Only when the WHY is genuinely non-obvious (a
  hidden constraint, a workaround for a specific upstream bug, something
  that would surprise a reader) — not restating what the code already
  says.
- **Docs vs. plans.** `docs/*.md` describes how a shipped subsystem works
  (for a human maintaining this repo later). `plans/*.md` are standalone
  work orders for an external agent to execute — each one must be fully
  self-contained (the agent reading it has no access to this
  conversation or any other planning context), and must not reference
  internal-only planning artifacts.

## Git worktrees

Parallel work happens in git worktrees under `.worktrees/<name>/`
(gitignored), each on its own branch, created via
`scripts/spawn-parallel-worktrees.sh` (see that script's own header
comment for the full contract). `.worktrees/.orchestrator-state.json` is
the durable source of truth for a round's status — treat it as
authoritative over your own memory of what happened, especially across
separate tasks/sessions.
