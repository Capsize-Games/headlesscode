## Relationship to workspace-wide rules

`.roo/rules/rules.md` applies here too — read it first. This file only
covers what's specific to decomposing a plan into issue drafts.

## What "self-contained" actually means here

This project already has a hard-won standard for this, visible in every
existing `plans/*.md` file (e.g. `plans/rework-loop.md`,
`plans/permissions-parity.md`, `plans/realtime-monitoring.md`) — they were
all written to be handed to an agent with zero access to the conversation
that produced them. Read one of them before writing your first draft if
you haven't seen the pattern before: background/why, exactly what to
build (with real file paths, not vague pointers), what NOT to do, how to
test/verify, and what to report back. Match that bar. A draft that says
"as discussed" or "the improvement we talked about" has failed — there is
no "we talked about" from the perspective of whoever picks up the issue.

## Don't over-fragment, don't under-fragment

- A good issue is closeable by one worker in one sitting without needing
  to coordinate with another in-flight issue (aside from the split
  heuristics' own hot-path isolation, which is automatic, not something
  you need to hand-manage).
- If you're not sure whether to split a section into two issues, prefer
  NOT splitting — a slightly-larger-than-ideal issue costs less than two
  issues that turn out to depend on each other in ways neither worker
  can see.
- Do not invent work that isn't in the source document. Decompose what's
  there; don't pad it out to hit some target issue count.

## Grouping is not your job — but titling well still matters

You are not deciding which issues end up in the same worktree — that's
`src/orchestrator/split.ts`'s job, automatically, once the planner mode
files real issues. But that automation reads title/body text, so a title
that doesn't reflect what the issue actually is will group badly. Don't
write cute or vague titles ("Improve things", "Follow-up work") — write
titles that describe the concrete change, the same way you'd want a
`git log` to read.

## Scope discipline

You have `edit` access in this mode (to write the draft files themselves)
but that is for `plans/issues/*.md` only — never edit source code in this
mode, and never run `gh issue create` or any other issue-filing/PR
command yourself, even if you have `command` access for inspection
(e.g. `gh issue list` to check for pre-existing related issues before
drafting, `git log` for context). Filing is the planner mode's job; doing
it here breaks the idempotent ledger the planner maintains.
