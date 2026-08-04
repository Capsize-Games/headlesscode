# Verification round: plan-doc citation precision (checkpoints list --limit)

## Who you are and what this session is testing

You are a headless verification worker acting as this repo's 🏗️ Architect
mode (`.roomodes`). This session exists to test a just-landed convention
change in this repo's own configuration:

- `.roo/rules/rules.md` now requires: every specific instruction or finding
  in a `plans/*.md` doc that references existing code must cite a real file
  path + line number/range, VERIFIED by actually reading or grepping the
  file at plan-writing time — never recalled from memory or guessed.
- The architect mode's `customInstructions` in `.roomodes` reinforce it:
  grounding means capturing the ACTUAL file:line locations the exploration
  tools return and citing them in the written plan doc, not just using the
  tools to inform a narrative description.

Read both files before starting so you write under the new requirement.

## Your deliverable

Write ONE complete, self-contained plan doc: `plans/checkpoints-list-limit.md`
in this worktree, using the `write_to_file` tool — the file must PHYSICALLY
EXIST in the worktree when you finish (a plan doc that exists only in your
reply text is a failure). Use this repo's existing plan-doc format (who it's
for / what to build / what NOT to do / tests / verification checklist / what
to report back — read a couple of recently-merged ones under `plans/` for
the shape). The doc plans a small, real feature: a `--limit <n>` option on
the `headlesscode checkpoints list` command.

## The task to plan (modest scope — do not expand it)

- `headlesscode checkpoints` is dispatched from `src/cli.ts` to
  `src/checkpoints/cli.ts`; the `list` subcommand's implementation and the
  arg parsing live there and in `src/checkpoints/service.ts`; tests live
  under `src/checkpoints/__tests__/`. Start from those files (verify where
  things actually are — don't trust this list blindly).
- Plan a `--limit <n>` flag for the `list` subcommand: parse it in the CLI
  arg handling, pass it into the list path, and cap the rendered entries to
  the first `n`.
- Keep it small: one flag, one command, no new dependencies, no changes to
  `restore`/`diff`. Do NOT expand scope (no filters, no pagination, no sort
  options, no config-file plumbing).

## Citation requirement — this is the point of the session

Every specific instruction or finding in your plan doc that references
existing code MUST cite a real file path and line number/range, verified by
ACTUALLY READING the file at writing time (check the real current line
numbers, don't trust memory). Do not write "the checkpoints CLI" where you
could write `src/checkpoints/cli.ts:NN-NN`. Narrative context is fine, but
every concrete code reference carries a verified location.

**Tool use is mandatory.** A plan doc written without a single tool call is
an automatic FAILURE of this session. Note: `codebase_search` may be
unavailable in this worktree — use `read_file`/`search_files` instead.

## Exact steps — follow them in order

1. `read_file` `src/checkpoints/cli.ts` (in full).
2. `read_file` `src/checkpoints/service.ts` (in full).
3. `read_file` `src/checkpoints/__tests__/service.test.ts` (in full).
4. Identify where the `list` subcommand parses its args and where the
   checkpoint entries are rendered. Note the REAL line numbers.
5. Write `plans/checkpoints-list-limit.md` with `write_to_file`, planning
   the `--limit <n>` flag. Every finding that references existing code must
   carry the real `path:line` from your reads (e.g.
   `src/checkpoints/cli.ts:12-30`) — a citation whose line numbers you did
   not personally verify is a hallucination; never write one.
6. SELF-CHECK: `read_file` the plan doc you just wrote and confirm it
   contains at least one `path:line` citation per code reference. If any
   code reference lacks one, fix the doc before finishing.

## Constraints — headless session, no user to ask

- You are running headless with NO interactive user. Do NOT call
  `switch_mode`, `new_task`, or `ask_followup_question` — make reasonable
  decisions yourself and write the doc. (The architect mode's normal
  "ask the user if the plan looks right" checkpoint and final mode-switch
  handoff are deliberately skipped in this verification session.)
- Write the plan doc, then finish with `attempt_completion` summarizing
  what you wrote and listing the file:line citations you verified.
