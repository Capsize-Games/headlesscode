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
- **Stack-specific rules.** Per-stack guidance for a target project (Python
  vs. C++ conventions, verification tooling, …) lives at
  `<workspaceRoot>/.roo/rules-stack-<stack>/rules.md`, with a machine-global
  set at `~/.local/share/headlesscode/shared/stacks/<stack>/rules.md`
  (additive, global first). Detection + splicing is automatic — see
  `src/engine/stacks.ts` and `docs/stack-rules.md`.
- **A new tool is not done until something tells a model to reach for it.**
  A tool's own schema description is not enough on its own — real usage
  data has shown tools with good descriptions but no rules-file mention
  going completely unused (the four code-intelligence tools, `outline`/
  `go_to_definition`/`find_references`/`import_graph`, landed with solid
  descriptions and got zero real adoption across multiple live sessions
  until a short "prefer X over Y" section was added to
  `.roo/rules-code/rules.md` — `codebase_search` got adopted specifically
  because its own task required this and `outline`'s sibling tools didn't).
  Any task that adds a tool intended for regular use must: (1) add a short,
  scannable "prefer this over Y for Z" entry to the relevant `.roo/rules-*/
  rules.md` file (follow the existing compact bullet-list format — do not
  write a long prose section per tool, that doesn't scale as more tools are
  added), and (2) verify in a real session that the guidance actually
  changes behavior, not just that the tool works when called directly. A
  tool that's genuinely meant to be optional/rare (used only when the model
  specifically decides it's needed, not as a general preference) can skip
  this — say so explicitly in the task file so it's a deliberate choice, not
  an oversight.

## Never write to `/tmp`

- Scratch/temporary files (throwaway test scripts, one-off data dumps,
  intermediate output you don't need to keep) must go under
  `<workspace_root>/.headlesscode/scratch/` (create it if it doesn't exist —
  `/.headlesscode/` is already gitignored, so nothing there needs its own
  ignore rule), never `/tmp` or any other path outside the workspace.
- This is not a style preference: `/tmp` is outside the workspace root, so
  any write there is an "outside-workspace" operation. In the interactive
  VS Code GUI (Zoo Code's chat panel, including the real windows the
  `multi-agent-orchestrator` mode spawns), outside-workspace writes cannot
  be auto-approved — there is no toggle for it — so every `/tmp` write
  blocks the session waiting for a human to click approve. A worker sitting
  idle on an unattended approval prompt is functionally the same as a
  crash. In headless workers, `write_to_file`/`apply_diff`/`search_replace`/
  `edit_file` all hard-reject any path outside the workspace root
  (`resolveWithinWorkspace` in `src/tools/executor.ts` throws
  `PathTraversalError` — `/tmp/...` is never workspace-relative, so this
  always fails). `execute_command` has no equivalent guard (it's a
  command-string allow/deny list, not path-aware — see
  `src/permissions/commands.ts`), so a shell redirect to `/tmp` currently
  succeeds there even though every other write path rejects it — that
  inconsistency is exactly how workers have been getting away with it.
  There is no context in this project where writing to `/tmp` is correct;
  don't rely on `execute_command` being the one path that happens to allow
  it.
- If you need a location that survives across your own multiple tool calls
  within one task, `.headlesscode/scratch/` still works the same way —
  it's just inside the workspace instead of outside it.

## Git worktrees

Parallel work happens in git worktrees under `.worktrees/<name>/`
(gitignored), each on its own branch, created via
`scripts/spawn-parallel-worktrees.sh` (see that script's own header
comment for the full contract). `.worktrees/.orchestrator-state.json` is
the durable source of truth for a round's status — treat it as
authoritative over your own memory of what happened, especially across
separate tasks/sessions.
