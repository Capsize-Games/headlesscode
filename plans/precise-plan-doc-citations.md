# Plan docs must ground findings in verified file:line citations

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository —
a standalone Node/TypeScript CLI running a headless coding-agent loop with a
planning-to-dispatch pipeline (`.roomodes`: 📐 Planning → 🏗️ Architect →
🧭 Multi-Agent Orchestrator (headless) → 🔍 Deepseek Reviewer). This task
edits the pipeline's OWN configuration (`.roomodes`, `.roo/rules/rules.md`),
not application code — there's no `tsc`/`npm test` gate for prose changes,
but still **commit your work before calling `attempt_completion`** (see
`plans/harness-tooling-efficiency-round2.md` item 4 for why this needs
saying explicitly right now — that gap isn't fixed yet as of this doc).

**Do not start this until the current in-flight round
(`plans/harness-tooling-efficiency-round2.md`) finishes** — queued
explicitly, same as that round was.

## The evidence

Two real, comparable headlesscode sessions were run back-to-back tonight
against this same repo, same model, same machine:

- **Round 1** (`plans/orchestrator-worktree-cleanup.md`): reached iteration
  20 in **4:03**, at a cost of **$0.0216**. That plan doc was written from a
  MORE exploratory discovery process — it named the relevant files
  (`src/orchestrator/state.ts`, `status.ts`, `watch.ts`, `cli.ts`) but
  described their roles narratively, without pinning exact line ranges for
  every specific mechanism being modified.
- **Round 2** (`plans/harness-tooling-efficiency-round2.md`): reached
  iteration 20 in **2:00**, at a cost of **$0.0169** — over 2x faster, on a
  comparable task (both are multi-file TypeScript feature work in the same
  repo, same model, same session setup). That plan doc was written
  IMMEDIATELY after directly reading the relevant code, and every finding
  cited a precise, verified location — e.g. "`src/tools/executor.ts:710-761`",
  "the notice at `src/tools/executor.ts:751-758`", "`src/codeintel/
  find-references.ts`" — rather than a general area to go look in.

No other variable plausibly explains the gap: condensation didn't fire in
either case this early, cache-hit rates were comparable (92-94% in both),
and round 2's repo checkout was if anything slightly LARGER (it forked
after round 1 merged in ~2,200 new lines). The difference tracks specificity
of the plan doc's citations, not anything else measured.

This matches an ALREADY-DOCUMENTED pattern in this exact repo — see
`.roo/rules/rules.md`'s "A new tool is not done until something tells a
model to reach for it" bullet, which describes the same shape of problem
for tool adoption (`outline`/`go_to_definition`/`find_references`/
`import_graph` went unused with zero rules-file mention despite having good
tool descriptions, until a short "prefer X over Y" section was added). This
is the plan-doc-writing equivalent: a capability (grounding findings in
exact, verified locations) that doesn't happen reliably just because it's
possible — it needs to be an explicit, checked requirement.

## What to build

This is a prompt/process change, not application code — the "build" is
editing `.roomodes` and `.roo/rules/rules.md`.

1. **Add an explicit requirement to `.roo/rules/rules.md`'s "Docs vs.
   plans" bullet** (or a new adjacent bullet, matching the existing compact
   format — see how the tool-adoption bullet right after it is written,
   short and scannable, not a long prose section): every specific
   instruction or finding in a `plans/*.md` doc that references existing
   code must cite a real file path and line number/range, VERIFIED by
   actually reading or grepping the file at plan-writing time — not
   recalled from memory or guessed from a plausible-sounding structure.
   State the actual measured evidence above as the justification (this
   repo's own convention, per the tool-adoption bullet, is to back rules
   like this with a real measurement, not just assert them).

2. **Reinforce it in the 🏗️ Architect mode's `customInstructions`**
   (`.roomodes`, the `architect` mode block) — its existing step 2 already
   says to ground the plan in "the real current state of the code, not
   assumption" via `codebase_search`/`outline`/`go_to_definition`/
   `read_file`; add a line making explicit that this means capturing the
   ACTUAL file:line locations those tools return, and citing them in the
   written plan doc, not just using those tools to inform a narrative
   description.

3. **Verify staleness handling.** A citation like `executor.ts:710-761` can
   go stale if the file changes between plan-writing and dispatch (a real
   risk in this multi-stage pipeline — Planning/Architect and the
   dispatched worker run at different times). Add a line to the same
   rules-file guidance: a worker encountering a citation that doesn't match
   current file content should treat it as "approximately here, verify
   before trusting the line numbers" rather than a hard contract — the
   VALUE of a citation is narrowing the search, not guaranteeing an exact
   match forever. Don't let this caveat become an excuse to skip citing
   real locations in the first place; it's guidance for the READER's
   trust level, not a downgrade of the WRITER's obligation.

## What NOT to build

- Don't build tooling to auto-validate that every citation in a plan doc is
  currently accurate (e.g. a linter that greps every `file.ts:N` reference
  and fails if line N doesn't match). That's real engineering effort for a
  problem a one-line rule addition + the existing review pipeline
  (🔍 Deepseek Reviewer already re-verifies claims) can catch more cheaply.
  Revisit only if citations turn out to be systematically unreliable even
  after this round's prompt changes — don't build it speculatively now.
- Don't rewrite Planning mode's own instructions — this is specifically an
  Architect-mode (plan-WRITING) concern; Planning mode's job is
  conversational discovery, not producing the citation-bearing document.

## How to verify this actually worked

Don't just assert it and move on — this repo's own convention (per the
tool-adoption bullet cited above) is to confirm a prompt/rules change
actually changes behavior in a real session, not just that the wording
looks right:

1. After making the changes, dispatch a small, real planning-to-plan-doc
   task (using 📐 Planning → 🏗️ Architect against this same repo, on some
   real, modest scope — doesn't need to be elaborate) and inspect the
   resulting `plans/*.md` file: does it contain real file:line citations
   for its findings, verified against the actual current file content
   (spot-check a few)?
2. If the generated plan doc is noticeably more citation-precise than
   round 1's (`orchestrator-worktree-cleanup.md`) was, the change worked.
   If not, the rules-file wording needs to be more concrete/directive
   (this repo's existing tool-adoption bullet is the bar to match — it's
   specific and short, not aspirational).
