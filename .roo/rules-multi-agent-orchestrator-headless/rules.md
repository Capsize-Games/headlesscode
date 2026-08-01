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

## Two different pipelines live in one mode — know which one you're in

This mode has two entry points (see the mode's own "Step 0" instructions):
the **issue-driven path** (Step 0a splits/files issues, then Step 1 runs
`headlesscode orchestrate --issue ...`) and the **direct task-file path**
(Step 2 calls `scripts/spawn-parallel-worktrees.sh` directly against
existing `plans/*.md` files). They behave differently in one important way:

- **Issue-driven path**: `orchestrate` runs an automated review after each
  group finishes, and — per the rework-loop work already built — will
  automatically respawn a worker on the same worktree to address a
  `"finding"` verdict, up to `--max-rework-cycles` (default 3), before
  giving up and marking the group `"needs-human"`.
- **Direct task-file path**: no automated review, no rework loop.
  `spawn-parallel-worktrees.sh` calls don't go through `orchestrate`'s
  review/rework machinery at all. Review of each worker's result is a
  separate, deliberate step — the user reviews the diff directly, or the
  `deepseek-reviewer` mode is invoked explicitly afterward.

Either way, "done" is never the same as "correct" from this mode's own
perspective — even the issue-driven path's automated review is a separate
adversarial pass, not something you assert on the round's behalf.

## Drafting and filing issues (Step 0a)

- `gh` must be authenticated (`gh auth status`) — check before filing
  anything, don't discover an auth problem partway through a batch.
- `plans/issues/<NN>-<slug>.md` drafts + `plans/issues/INDEX.md` +
  `plans/issues/.filed.json` (the idempotency ledger) are working files
  for this pipeline, not permanent project docs — unlike `plans/*.md`
  work-order files, which are meant to be read by an external agent as a
  standalone spec, these are an internal handoff between your own Step 0a
  and Step 1. The ledger is NOT the source of truth for what's been filed
  — GitHub is. If the ledger looks stale (an issue number it records has
  since been closed/deleted), trust `gh issue view <n>` over the ledger,
  and tell the user what looked inconsistent rather than silently
  "fixing" it.
- Splitting issues into parallel groups is inherited from
  `src/orchestrator/split.ts`, not something to hand-tune by filing issues
  in a contrived order or trying to influence grouping some other way. If
  a `--dry-run` preview looks wrong, the fix is retitling/redrafting the
  issue (back in Step 0a), not working around the split logic.

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
