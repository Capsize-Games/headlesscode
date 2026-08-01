## Relationship to workspace-wide rules

`.roo/rules/rules.md` applies here too — read it first. This file only
covers what's specific to coordinating parallel worker sessions within
this repo's own worktrees.

## This is self-hosted orchestration, not delegation

A sister project (`airunner`) has its own `multi-agent-orchestrator-headless`
mode that delegates to a *separate* `headlesscode` checkout via a wrapper
script (`scripts/headlesscode-orchestrate.sh` in that repo). That pattern
does not apply here — this repo IS headlesscode. There is no wrapper, no
`HEADLESSCODE_ROOT` override, no `--repo` flag needed: `scripts/spawn-
parallel-worktrees.sh` and `scripts/run-worker.sh` are called directly,
and `git rev-parse --show-toplevel` from inside this repo already resolves
correctly.

## No automatic review or rework loop

Unlike an issue-driven round, this mode does not invoke the
`deepseek-reviewer` mode automatically, and there is no automatic
rework-on-finding loop (`headlesscode orchestrate`'s rework behavior, if it
exists, is orchestrator-CLI-level and only applies to `orchestrate`'s own
GitHub-issue-driven flow — direct `spawn-parallel-worktrees.sh` calls don't
go through it). Review of each worker's result is a separate, deliberate
step — either the user reviews the diff directly, or the `deepseek-reviewer`
mode is invoked explicitly afterward. Don't assume "done" means "correct."

## Requirements

- `OPENROUTER_API_KEY` must be live — this repo's own `.env` (gitignored)
  has it. Since workers are launched as detached background processes that
  inherit whatever shell environment spawned them, make sure it's actually
  exported in *your* shell before calling the spawn script:
  ```
  set -a; source .env; set +a
  ```
  A worker started without the key exported will fail immediately with an
  OpenRouter auth error in its `harness.log` — check there first if a
  group goes straight to `"failed"`.
- Workers default to `--mode code` and the harness's own default model
  (`deepseek/deepseek-chat`) unless told otherwise per-worktree.

## Blocked groups — a worker needs a decision from YOU

When a worker calls its equivalent of `ask_followup_question`, it writes a
marker and blocks/polls for up to ~30 minutes (configurable) before giving
up and guessing. During that window, the group's status in
`.orchestrator-state.json` is `"blocked"` with the question attached
(`group.blocked.question`).

1. Read the question and the worker's `.worktrees/<name>/harness.log` for
   context — don't answer blind.
2. Decide it yourself if confident; ask the actual human via your own real
   `ask_followup_question` if genuinely ambiguous — you have that available
   even though the worker doesn't.
3. Unblock it:
   ```
   bash scripts/headlesscode-answer.sh .worktrees/<name> "<your answer text>"
   ```

Don't let a blocked group sit past its timeout unanswered if you're
actively monitoring the round.

## Checkpoints and cost

Every worker checkpoints its own worktree automatically (shadow git, not
this repo's real history) — see `docs/checkpoints.md`. If a worker's edits
go wrong, `checkpoints list`/`restore` against that worktree reverts real
files without needing to re-spawn.

Cost/token usage per session and per round is visible via
`npx tsx src/cli.ts dashboard --repo $(pwd)` — local-only, read-only, no
auth. Don't expose the port beyond localhost.

## Cleanup

Worktrees under `.worktrees/` are not automatically removed. Once a
group's work has been reviewed and either merged or abandoned, remove it
with `git worktree remove .worktrees/<name>` (or `--force` if it has
uncommitted changes you've deliberately decided to discard) rather than
leaving it around indefinitely.
