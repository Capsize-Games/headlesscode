# Contributing to headlesscode

Thanks for contributing! This file covers how this repository is set up, how
to run the verification bar, and what a merge-ready change looks like.

## What this project is

`headlesscode` is a standalone Node/TypeScript CLI that runs a headless
coding-agent loop, ported from a VS Code extension (vendored verbatim under
`src/vendor/zoo-code/`, Apache-2.0 — see `ATTRIBUTION.md`). There is **no
build step**: everything runs directly via `tsx`. Read the docs in `docs/`
before diving into a subsystem.

## Security first

This agent **executes arbitrary shell commands as the invoking user** — that
is its core function. Read [`SECURITY.md`](./SECURITY.md) before running it
unattended or pointing it at untrusted repositories, and never weaken the
permission layer without a very explicit reason. If you are adding a feature
that executes commands or reads secrets, think about the least-privilege
story as part of the design, not after.

## Setup

```bash
npm install          # tsx + typescript + deps; no build step needed
npm test             # full suite (see "Test conventions" below)
npm run typecheck    # npx tsc --noEmit
```

`node >= 18` is required (see `engines` in `package.json`).

**Optional: the `browser_action` tool's tests.** `src/tools/__tests__/browser-action.test.ts`
launches a real headless Chromium via Playwright. `npm install` only installs
the `playwright` npm package, not the browser binary itself — run
`npx playwright install chromium` once to enable those tests. Without it, the
suite detects the missing binary, prints a clear skip message, and exits 0
(this is treated as an environment gap, not a test failure — the rest of
`npm test` still runs and still gates your change).

## Test conventions

- **No test framework.** The project deliberately uses no jest/mocha/vitest.
  Tests are plain `.test.ts` files run directly via `tsx` with hand-rolled
  assertions, and the file ends with an `All N tests passed` trailer line.
  Look at any existing file under `src/*/__tests__/` for the exact style
  before writing a new one.
- **Discovery is automatic.** `npm test` runs `scripts/run-tests.mjs`, which
  globs every `*.test.ts` under `src/` (plus a short explicit list of
  non-test-suffixed check scripts) and runs them sequentially, fail-fast. A
  new test file needs **zero** edits outside the file itself — do not add it
  to `package.json` by hand.
- **Verification bar for any change to `src/`:**
  1. `npx tsc --noEmit` is clean (respect the strictness `tsconfig.json`
     actually configures — no `any`, `@ts-ignore`, or `!` escapes).
  2. `npm test` passes in full. A targeted run (`npm test -- <substring>` or
     `npx tsx <test-file>`) is fine while iterating, but the full suite is
     the gate.
- **Orchestrator / watcher / spawn / worker changes** also re-run the
  relevant suites under `scripts/e2e*/run.sh` — these exercise real
  spawn/watch/review flows against a local mock LLM server, not just
  unit-level logic.

## Repository conventions

- **No new runtime dependencies without a real reason.** The project
  deliberately avoids frameworks and schema libraries for its own
  state/JSON handling (plain `node:fs`/`node:http`, loose JSON validation).
  Prefer the smallest dependency footprint that does the job; ask in the
  issue/PR if you think a dependency is genuinely warranted.
- **Non-fatal failure pattern for auxiliary subsystems.** Memory recording,
  checkpoint saving, and usage/cost recording all follow the same idiom:
  wrap in try/catch, log a warning via the session's logger, and never let a
  failure in an auxiliary subsystem abort or corrupt the coding session.
  Match that pattern when adding a new auxiliary write path.
- **Vendoring convention.** Code ported from the upstream VS Code extension
  lives under `src/vendor/zoo-code/`, copied verbatim wherever practical,
  with a corresponding entry in `ATTRIBUTION.md`. VS Code API calls the
  vendored code makes are satisfied by no-op shims under
  `src/vendor/zoo-code/shim/`, wired via `tsconfig.json`'s `paths` — check
  there before assuming something needs a new shim.
- **Comments are minimal.** Only when the WHY is genuinely non-obvious.
- **Docs vs. plans.** `docs/*.md` describes how a shipped subsystem works.
  `plans/*.md` are standalone work orders for an external agent to execute —
  each must be fully self-contained and must not reference internal-only
  planning artifacts.
- **Plan docs cite verified locations.** Every code reference in a
  `plans/*.md` doc must include the real file path AND line
  number/range (e.g. `src/checkpoints/cli.ts:12-30`), verified by actually
  reading or grepping the file at writing time — never recalled from memory.

## Working with issues

- This repo is developed primarily through **headless workers in parallel git
  worktrees** (see `scripts/spawn-parallel-worktrees.sh`). If you're
  submitting a PR the normal way, the same conventions apply: one logical
  change per commit, reference the issue number in the commit message and PR
  body.
- **Commit before you're done.** Real, working changes should be committed in
  logical units; a PR is a series of reviewed, individually sensible commits,
  not one giant diff.

## Code of conduct

All contributors and maintainers are expected to follow our
[Code of Conduct](./CODE_OF_CONDUCT.md). Be respectful, be constructive, and
assume good faith — this project is small and every contribution matters.
