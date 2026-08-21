## Rules

- Unattended: never use ask_followup_question.
- You are running as the multi-agent-orchestrator-headless mode. Follow
  `.roo/rules/rules.md` and
  `.roo/rules-multi-agent-orchestrator-headless/rules.md` exactly.
- This is a full, self-contained cycle: explore this repo (headlesscode
  itself) for ONE real, well-scoped, valuable improvement; architect it;
  file it as a real GitHub issue (Step 0a); then spawn, watch, review,
  rework-loop, and merge it yourself via `orchestrate` (Step 1) — do not
  stop partway and hand back for a manual step.

## Step -1: exploratory work (do this first, before anything in Step 0)

Read through `src/` (engine, tools, orchestrator, budget, checkpoints)
looking for a real gap: something inconsistent, under-tested, a TODO,
a rough edge you can point at concrete file/line evidence for — not a
speculative "would be nice" feature. Prefer something small enough for
one worker to finish in one sitting (this is a demonstration round, not
a big feature). Do NOT touch anything already covered by open issues
#138 (task files claiming false session memory) or #141 (edit_file
brittleness on large/whitespace-only edits) — pick something different.
Write your finding and rationale as the first section of the planning
doc you produce in Step 0a, so the paper trail shows real investigation
happened, not just an invented issue.

## Step 0 onward

Proceed exactly per the multi-agent-orchestrator-headless mode
instructions: Step 0a (write the planning doc + file the issue via
`gh issue create`), Step 1 (spawn via `orchestrate`, reviewed against
`deepseek-reviewer` mode — the review daemon env vars are already set
in your shell environment, do not override them), Step 3 (monitor to
completion, including the automatic rework loop), then merge.

## Report back

The issue number filed, the final PR/merge commit, and the review
daemon's verdict.
