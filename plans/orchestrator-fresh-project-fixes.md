# Orchestrator fixes for fresh/new-project dispatch: rules-file mistakes, gh re-fetch failures, and auto-filed issues

## Who you are working on this for

You are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI running a headless coding-agent loop. Match
the project's established conventions: no test framework beyond hand-rolled
`assert` + `tsx`-run test files, minimal new dependencies, `npx tsc --noEmit`
and `npm test` must stay green. This plan doc is fully self-contained — you
have no access to any prior conversation about it.

**Commit your work incrementally per logical change before calling
`attempt_completion`.**

## The problem, in the project owner's own words

Running `headlesscode orchestrate` against a freshly-registered project
(`~/Projects/rts_cpp`, just set up via `headlesscode init` —
`plans/project-init-registration.md`) failed before real work started. The
owner's own diagnosis, reading the worker's failure:

> The failures aren't about my task content — the worker kept trying to
> read `.roo/rules-code/rules.md` (a convention from the harness's default
> mode-loading setup) which doesn't exist in this repo, and tried `gh issue
> view 101` against real GitHub (there's no such issue there, since I used
> a local synthetic issues-json). Those tool errors tripped the harness's
> 3-consecutive-mistake circuit breaker before real work started.

And, on where default rules content should live:

> i don't want you to add the roocode file there [`~/Projects/rts_cpp`] -
> it belongs in the appropriate sub folder in `~/.local/share/headlesscode`

And, on a second problem surfaced by a live session's `ask_followup_question`
dialog ("The orchestrator's worker template expects a real GitHub issue... my
synthetic local issue number was causing it to fail immediately. Should I
create a real GitHub issue...?"):

> the planner / orchestrator should be filing its own github issues

Three fixes, in this priority order (each independently valuable, do them
in order, verify+commit after each before starting the next).

## Fix 1 — stop instructing workers to `read_file` a rules path that may not exist, and ship default `rules-code` content centrally

### Root cause

Every generated task file starts with a hardcoded literal instruction
telling the model to go read a specific project-local file — NOT a
description of what's already in its system prompt, an explicit
`read_file`-triggering instruction:

```
"Before anything else: read `.roo/rules-code/rules.md` in full (or `.roo/rules/rules.md` if",
"rules-code is absent) and treat it as binding for this entire session, regardless of whether",
"it auto-loaded for whatever mode you're running in — don't assume it applied, read it yourself.",
```

This exact three-line block is duplicated verbatim across FIVE task-builder
functions in `src/orchestrator/cli.ts`:

- `buildTaskFileContent` — `src/orchestrator/cli.ts:534-536`
- `buildPlanFirstTaskFileContent` — `src/orchestrator/cli.ts:635-637`
- `buildReworkTaskFileContent` — `src/orchestrator/cli.ts:716-718`
- `buildQaReworkTaskFileContent` — `src/orchestrator/cli.ts:816-818`
- `buildContinuationTaskFileContent` — `src/orchestrator/cli.ts:910-912`

But this instruction is REDUNDANT with, and actively worse than, a
mechanism that already exists and already runs automatically for every
session with zero extra instruction needed: `getRooDirectoriesForCwd()`
(`src/vendor/zoo-code/src/services/roo-config/index.ts:271-280`) returns
`[getGlobalRooDirectory(), <project>/.roo]`, and `getGlobalRooDirectory()`
(`src/vendor/zoo-code/src/services/roo-config/index.ts:22-24`) already
resolves to `~/.local/share/headlesscode/shared` — headlesscode's OWN
central-store relocation of the upstream `~/.roo`, done specifically so
mode-specific rules can be shared across every project without per-project
setup (see that function's own doc comment). `addCustomInstructions()`
(`src/vendor/zoo-code/src/core/prompts/sections/custom-instructions.ts:413-450`)
scans `<each rooDir>/rules-${mode}/` and splices whatever it finds
DIRECTLY into the system prompt before the model's first turn — no tool
call, no chance of an ENOENT, and (per the ENOENT/EISDIR handling at
`custom-instructions.ts:27`) a missing directory is silently skipped, not
an error.

So: on a project with a central `rules-code/rules.md` but no project-local
`.roo/rules-code/rules.md` (like `rts_cpp` after this plan), the content IS
already in the model's system prompt automatically — the hardcoded
"go read it yourself" instruction is telling the model to manually
duplicate work the harness already did for it, and when NEITHER tier has
content yet (today's state — verify by checking `ls
~/.local/share/headlesscode/shared/` on the dev machine, or in this repo's
own `shared/` tree, which currently only ships `stacks/`, no `rules/` or
`rules-code/`), the explicit read fails outright and burns one of the
session's 3 allowed consecutive mistakes before real work starts.

### What to build

1. **Ship default central `rules-code` content** (mirrors the existing
   `shared/stacks/<stack>/rules.md` shipping mechanism exactly — see
   `docs/stack-rules.md`'s "Shipping the central content" section and
   `scripts/sync-stack-rules.sh`):
   - New file in THIS repo at `shared/rules-code/rules.md` — generic,
     stack-agnostic "hard-won lessons" content useful for ANY project's
     code-mode sessions. Good starting content: the existing "Hard-won
     lessons" bullet list already hardcoded into every generated task file
     today (`src/orchestrator/cli.ts:551-560`, e.g. "Never delete a public
     name without grepping the ENTIRE codebase for every importer...",
     "If you split a module into submodules, verify EVERY public name...",
     "A `git worktree add <path> <ref>` ALWAYS checks out the committed
     state..."). This content is currently duplicated into every single
     generated task file across every orchestrated round of every project —
     moving it to a central rules tier means it's spliced automatically
     instead, so pulling it OUT of the task-file builders in Fix 1 step 2
     below and INTO this shared file is a straight relocation, not new
     writing. Keep it generic (no headlesscode-repo-specific content) since
     it will now apply to every target project's code-mode sessions, not
     just headlesscode's own.
   - Add a `sync-rules.sh`-equivalent step: either extend
     `scripts/sync-stack-rules.sh` to also sync a `shared/rules-*/` tree
     (rename/generalize if that reads cleaner), or add a small parallel
     script — whichever keeps `scripts/install-cli.sh`'s single invocation
     working (it currently calls `sync-stack-rules.sh` — see
     `scripts/install-cli.sh`'s relevant section). Must resolve the
     destination via `getGlobalRooDirectory()`'s equivalent path
     (`~/.local/share/headlesscode/shared/rules-code/`, honoring
     `$HEADLESSCODE_DATA_DIR` the same way `sync-stack-rules.sh` already
     does) — verify both sides agree, same caveat `docs/stack-rules.md`
     already documents for the stacks tier ("An install/seed step that used
     a DIFFERENT resolution... silently ships to the wrong place").
   - Also seed it in the Docker image path (`docker/Dockerfile` +
     `docker/entrypoint.sh`, same as `shared/stacks/` — check how those
     currently COPY/seed `shared/` and extend identically; do not special-case
     `rules-code` differently from how `stacks` is already handled if the
     seeding is already tree-wide).

2. **Remove the hardcoded explicit-read instruction from all five
   task-builder functions**, replacing the three-line block with something
   like:

   ```
   "Project and code-mode conventions (from central + project-local .roo/rules*)",
   "are already spliced into your system prompt automatically — you do not",
   "need to read any rules file yourself.",
   ```

   (Adjust wording to fit each function's surrounding tone — the five
   occurrences currently have byte-identical wording, so a shared local
   constant string in `src/orchestrator/cli.ts` used by all five call sites
   is cleaner than five independent edits; introduce one if it reduces
   duplication without over-engineering.)

3. Search the rest of the repo for other copies of this same instruction
   pattern before considering this fix done — `grep -rn "rules-code/rules.md"
   src/` to confirm all occurrences were found and fixed (the five above are
   what was verified at plan-writing time from `src/orchestrator/cli.ts`
   only; a targeted re-grep is required since line numbers shift after
   edits and other files were not exhaustively checked here).

## Fix 2 — embed already-known issue title/body instead of re-fetching via `gh issue view` at runtime

### Root cause

`loadIssues()` (`src/orchestrator/cli.ts:500-521`) already has the full
`{number, title, body}` for every issue in hand — whether fetched for real
via `fetchIssueWithGh()` (`src/orchestrator/cli.ts:490-497`, real `gh issue
view --json ...` call) or supplied directly via `--issues-json` (parsed at
`src/orchestrator/cli.ts:502-514`, straight from the JSON file — no GitHub
API call at all, by design, for exactly the local/offline/synthetic-testing
case `docs/`... `README.md`'s own `--issues-json` doc entry describes:
"used when `gh` is unavailable, or for tests").

But every task-builder function THROWS THAT AWAY and instead embeds a
literal `gh issue view <n>` shell command for the model to run itself at
session start (`ghLines` built via `.map((n) => \`gh issue view ${n}\`)` at
`src/orchestrator/cli.ts:532`, `633`, `713`, `805`, `908`, each followed by
"Fetch each issue's real body yourself" wording). For a `--issues-json`
round with synthetic/placeholder numbers (no matching real GitHub issue),
this ALWAYS fails — there is nothing for `gh issue view <n>` to find. This
is what produced the `gh issue view 101` failure.

### What to build

For the two builders where the fetched `SplitIssue[]` (with real bodies)
is already in scope at the call site:

- **`buildTaskFileContent(spec, issues)`** — `issues: SplitIssue[]` is
  already a parameter (`src/orchestrator/cli.ts:530`). Instead of building
  `ghLines` and telling the model to run `gh issue view <n>`, look up each
  assigned issue's `{title, body}` from `issues` (match `spec.issues`
  against `issues[].number`) and embed the real title + body TEXT directly
  in the generated task file, inside a clearly delimited block per issue
  (e.g. `### Issue #<n>: <title>\n\n<body>`). Drop the "Fetch each issue's
  real body yourself" instruction entirely — there is nothing left to
  fetch, it's already inline. Update the "## Workflow" step 1 wording
  (`src/orchestrator/cli.ts:576`, currently "Read each assigned issue body
  via `gh issue view <n>`...") to match — the issue bodies are already
  above in this file; step 1 becomes exploring source files, not fetching.

- **`buildPlanFirstTaskFileContent(group)`** — currently only takes
  `group: {name, issues?: number[]}` (`src/orchestrator/cli.ts:631`), no
  access to bodies. Its sole caller, `writeTaskFiles()`
  (`src/orchestrator/cli.ts:670-696`), DOES already have `issues:
  SplitIssue[]` as a parameter (`src/orchestrator/cli.ts:674`) — thread it
  through: change the signature to
  `buildPlanFirstTaskFileContent(group, issues: SplitIssue[])` and pass
  `issues` from the existing call site (`src/orchestrator/cli.ts:691`).
  Same embed-instead-of-fetch treatment as above.

For the three builders that only ever see `group: {name, issues?:
number[]}` reconstructed from PERSISTED STATE at rework/continuation time
(bodies are not currently persisted anywhere) — `buildReworkTaskFileContent`,
`buildQaReworkTaskFileContent`, `buildContinuationTaskFileContent` — the
fix requires persisting issue bodies at dispatch time, following the EXACT
precedent already established for per-issue "shape" data
(`src/orchestrator/cli.ts:2385-2399`, the "Issue #16" comment block: "stamp
every group with its per-issue shape... the only moment the issue titles/
bodies are in hand... captured here and persisted in the state file"):

- Add an `issueBodies?: Record<string, { title: string; body?: string }>`
  field to `OrchestratorGroup` (`src/orchestrator/state.ts:40`-ish — check
  the exact interface body near the existing `issues?: number[]` field at
  `src/orchestrator/state.ts:44`), keyed by issue number as a string (JSON
  object keys are always strings).
- At the same dispatch-time point that already computes `shapeByNumber`
  (`src/orchestrator/cli.ts:2385-2392`), also build an issue-number →
  `{title, body}` map from `issues` and persist it into each group via
  `updateGroup(state, spec.name, { shapes, issueBodies })` (extending the
  existing call at `src/orchestrator/cli.ts:2394-2396`, not a new one).
- Update the three rework/continuation builder functions to accept the
  persisted `issueBodies` (threaded from `group.issueBodies` at their call
  sites — `src/orchestrator/cli.ts:1035`, `1119`, `1283`) and embed title/
  body the same way as Fix 2's first two builders, instead of building
  `ghLines`.
- If `group.issueBodies` is absent for a given issue number (e.g. state
  written before this change, or a real `--issue <n>` round where — decide
  at implementation time whether real-`gh` rounds should ALSO persist
  bodies the same way, which is simpler and more consistent than only
  persisting for the `--issues-json` path; prefer persisting always), fall
  back to the OLD `gh issue view <n>` instruction wording for that specific
  issue only — never silently produce an empty assignment section.

### Tests

Extend the existing task-file-builder tests (find them via `grep -rln
"buildTaskFileContent\|buildPlanFirstTaskFileContent" src/orchestrator/__tests__/`)
to assert: (a) the generated content contains the real issue title/body
text, not a `gh issue view` line, when a body is available; (b) the
rules-file instruction block from Fix 1 is gone from all five builders'
output; (c) for the three state-persisted builders, a synthetic
`OrchestratorGroup` with `issueBodies` populated produces embedded text,
and one WITHOUT `issueBodies` falls back to the old `gh issue view`
wording (regression guard for the fallback path, not just the happy path).

## Fix 3 — orchestrator auto-files real GitHub issues instead of leaving synthetic numbers to fail mid-run

### Root cause / design

Today, `--issues-json` is documented (`README.md`) as an offline/local/test
convenience — its entries never touch real GitHub. That's fine as long as
nothing downstream assumes a real issue exists. Fix 2 removes the runtime
`gh issue view` dependency, which already resolves the IMMEDIATE crash. But
the owner also flagged the workflow gap that led to the mid-session
`ask_followup_question` dialog in the first place: closing a group's work
still wants to comment-and-close a REAL GitHub issue and open a REAL PR
against it (see the "Required comment template" / "Post the closing
comment... then close it" step in every task builder, e.g.
`src/orchestrator/cli.ts:588-593`) — a purely synthetic issue number can
never satisfy that. Leaving a worker to decide interactively, mid-session,
whether to create one is the wrong layer: a headless worker has no
reliable way to weigh that decision, and it burns a live session on a
question the ORCHESTRATOR (or the human invoking it) should settle before
any worker ever spawns.

### What to build

Add a `--file-issues` flag to `headlesscode orchestrate` (wire into
`parseOrchestrateArgs`, near the existing `--issues-json` case handling —
`src/orchestrator/cli.ts:318-324` area). Behavior, inserted right after
`loadIssues()` returns (`src/orchestrator/cli.ts:2124-2130`), before
anything else touches `issues`:

- For every entry in `issues` whose `number` is NOT a real, pre-existing
  GitHub issue (heuristic: `--issues-json` entries are the ONLY source that
  can produce this — real `--issue <n>` / `gh issue list`-sourced entries
  always carry a real number already, so gate this entirely on "were these
  issues loaded via `--issues-json`", not on inspecting the number itself),
  call `gh issue create --repo <owner>/<repo> --title <title> --body
  <body>` (via `execFileSync`, mirroring the exact pattern
  `fetchIssueWithGh` already uses at `src/orchestrator/cli.ts:490-497` for
  consistency — same error handling shape, same `cwd`/`timeout` idiom).
  Capture the real issue number `gh issue create` returns (it prints the
  new issue's URL; parse the trailing number, or use `--json number` if
  `gh issue create` supports it — verify via `gh issue create --help`
  before assuming the flag exists).
  - Determine `<owner>/<repo>` from the target repo's `origin` remote
    (there is very likely an existing helper for this somewhere in
    `src/github/` given `push-pr` already pushes to a repo the App
    installation can access — check `src/github/cli.ts` and reuse rather
    than re-deriving remote-parsing logic).
- Replace each such entry's synthetic `number` with the real one returned,
  so every downstream step (worktree/branch naming, task-file generation,
  Fix 2's embedded title/body, state persistence, PR-closing comments) uses
  the real number transparently — no other code needs to know issues were
  just filed.
- Print a clear one-line confirmation per created issue (`filed issue #<n>:
  <title> -> <url>`) so a human watching the dispatch output sees exactly
  what got created — this is a real, visible-to-GitHub side effect and
  should never happen silently.
- `--file-issues` without `--issues-json` is a usage error (nothing to
  file) — match the existing usage-error exit-2 convention.
- Without `--file-issues`, behavior is COMPLETELY unchanged (an
  `--issues-json` round with synthetic numbers still runs exactly as
  before, minus Fix 1/Fix 2's crash — filing issues is opt-in, never
  automatic, since it's a real write to a real GitHub repo and must be a
  deliberate choice).

### Tests

New test(s) covering the number-substitution logic in isolation (pure
function, no real `gh` call — inject/mock the issue-creation call the same
way existing tests mock `fetchIssueWithGh`-adjacent logic; grep
`src/orchestrator/__tests__/` for the existing mocking pattern for `gh`
calls and match it) verifying: entries needing filing get replaced with
the returned real number, entries that already look like they came from
real `--issue`/`gh` are left untouched, and the flag combination validation
(`--file-issues` without `--issues-json` → usage error) is enforced.

### Docs

Add `--file-issues` to `ORCHESTRATE_USAGE`'s options block (wherever that
constant is defined in `src/orchestrator/cli.ts`) and to `README.md`'s
orchestrate options list (`README.md:143`-ish, alongside `--issues-json`).

## Verification bar for this whole plan

- `npx tsc --noEmit` clean.
- `npm test` full suite green (register any new test files in
  `package.json`'s `test` script).
- Re-run `scripts/e2e-phase2/run.sh` (this plan touches
  `src/orchestrator/`, which `.roo/rules/rules.md`'s verification bar
  explicitly calls out as requiring the e2e suite, not just unit tests).
- Manual smoke check worth doing if time allows (not required to close):
  confirm `scripts/sync-stack-rules.sh` (or its generalized replacement)
  actually lands `rules-code/rules.md` at
  `~/.local/share/headlesscode/shared/rules-code/rules.md` after
  `./scripts/install-cli.sh`, the same "verify both sides agree" check
  `docs/stack-rules.md` already recommends for the stacks tier.

## Out of scope

- No change to the stack-rules mechanism itself (`src/engine/stacks.ts`) —
  it already works correctly; Fix 1 only adds a NEW central tier
  (`rules-code`) using the SAME already-existing global-`.roo`-directory
  splicing, not a new mechanism.
- No change to how `--issue <n>` (real GitHub, no `--issues-json`) issues
  are loaded — `fetchIssueWithGh` stays as-is.
- Fix 3 does not attempt to auto-detect whether a synthetic issue number
  "coincidentally" matches a real one on GitHub — gating purely on
  "loaded via `--issues-json`" is deliberate and simpler; a human choosing
  `--issues-json` already knows those numbers aren't real.
