## Relationship to workspace-wide rules

`.roo/rules/rules.md` applies here too — read it first. This file only
covers what's specific to filing issues and firing an orchestration round.

## Requirements

- `gh` must be authenticated (`gh auth status`) — check before filing
  anything, don't discover this after issue 1 of 6 fails.
- `OPENROUTER_API_KEY` must be live in `.env` (this repo's own, gitignored)
  for Step 4 — same requirement `multi-agent-orchestrator-headless`
  already documents.
- `~/Projects/headlesscode`... no — this repo IS headlesscode. There is no
  external delegation here (unlike the sister project `airunner`'s
  `headlesscode-orchestrate.sh` wrapper) — `npx tsx src/cli.ts orchestrate`
  is called directly against this repo's own root.

## The ledger is not the source of truth

`plans/issues/.filed.json` exists purely so a re-run doesn't double-file
issues after a partial failure — it is NOT the authoritative record of
what's been filed (GitHub itself is). If it looks stale or wrong (e.g. an
issue number it records has since been closed/deleted), trust `gh issue
view <n>` over the ledger, but don't silently "fix" the ledger without
telling the user what looked inconsistent.

## Splitting is inherited, not invented

Do not try to second-guess or manually override `orchestrate`'s split
plan by filing issues into some contrived order, or by trying to
influence grouping through anything other than what the architect mode
already encoded in the issue titles. If a `--dry-run` preview looks
wrong, the fix is telling the user (or going back to Architect mode to
retitle/redraft), not working around it here.

## Coexistence with other orchestration paths

This repo also has the direct task-file spawn path
(`scripts/spawn-parallel-worktrees.sh` with hand-written `plans/*.md`
docs, no GitHub issues involved — see
`.roo/rules-multi-agent-orchestrator-headless/rules.md`) and the GUI path
(`scripts/spawn-parallel-worktrees-gui.sh`). All three write to the same
`.worktrees/` and the same `.orchestrator-state.json` — don't fire an
issue-driven round while another round (of any kind) is still active
against overlapping worktree names. Check `git worktree list` and
`.worktrees/.orchestrator-state.json` first.

## Blocked / needs-human groups

Once a round is running, the same procedures already documented in
`.roo/rules-multi-agent-orchestrator-headless/rules.md` apply — a
`"blocked"` group needs you (or the human) to answer a question via
`scripts/headlesscode-answer.sh`; a `"needs-human"` group has exhausted
its automatic rework cycles and needs a person to actually look at it.
Neither of these is a failure of this mode — report them plainly, don't
treat them as something to silently retry.
