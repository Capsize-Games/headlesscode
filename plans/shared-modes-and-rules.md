# Shared/global custom modes across projects — instructions for implementation

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI that runs a headless coding-agent loop (ported
from a VS Code extension called Zoo Code, vendored under `src/vendor/zoo-code/`).
This repo is used to orchestrate work both on itself and on other, unrelated
repositories on the same machine (each such repository has its own
`.roomodes` custom mode definitions and `.roo/rules*/` directories).

Match this project's established style: no test framework (plain `tsx`-run
test files, `All N tests passed` trailer); `npx tsc --noEmit` and `npm test`
must stay green; re-run every e2e suite under `scripts/e2e*/run.sh`
afterward, since this touches mode-loading, which several e2e suites
exercise directly (they assert specific rules/modes get spliced into the
system prompt).

## The problem

Two (and growing) separate repositories on this machine each maintain their
own `.roomodes` + `.roo/rules*/` — some of it is genuinely project-specific
(e.g. one project's rules reference its own Python/Docker conventions,
another's reference its own TypeScript test conventions), but some of it is
the exact same orchestration machinery duplicated: the
`multi-agent-orchestrator-headless` mode's definition is meant to be one
canonical thing, not two copies that can silently drift as one gets updated
and the other doesn't.

### What already works today (verified by reading the vendored source directly — don't take this on faith, but also don't rebuild it)

**Rules already merge global + project, additively.** Read
`src/vendor/zoo-code/src/core/prompts/sections/custom-instructions.ts`'s
`loadRuleFiles` function and `src/vendor/zoo-code/src/services/roo-config/index.ts`'s
`getRooDirectoriesForCwd` — this is already wired all the way through
`buildSystemPrompt` (`src/engine/prompt.ts`), because headlesscode's system
prompt building goes through the real vendored `SYSTEM_PROMPT`/
`addCustomInstructions` chain, not a simplified reimplementation. Concretely:
`getRooDirectoriesForCwd` returns `[getGlobalRooDirectory(), <project's own
.roo dir>]` — i.e. `[~/.roo, <cwd>/.roo]` — and `loadRuleFiles` (and the
equivalent per-mode-rules loading a bit further down the same file) **reads
BOTH and concatenates their content** (not "project overrides global" — both
apply, each labeled with its source path in the final prompt). This means
`~/.roo/rules/rules.md` and `~/.roo/rules-<mode-slug>/rules.md` are ALREADY
real, working, global config paths for anything running through this repo's
`buildSystemPrompt` — confirm this yourself by reading the code, and prove it
with the test in the "Tests" section below, but do not write new
rules-loading logic, it already exists.

**Modes do NOT merge global + project — this is the actual gap.**
`src/engine/prompt.ts`'s `loadCustomModes(workspaceRoot)` only reads
`<workspaceRoot>/.roomodes`. There is no global modes file read at all. The
real VS Code extension has a "global modes" concept too
(`CustomModesManager.mergeCustomModes` in `zoo-code/src/core/config/CustomModesManager.ts`
— read it for the MERGE LOGIC pattern, not for its storage location, which
is VS-Code-internal `context.globalStorageUri` and not relevant here), and
it merges **project modes first, then global modes, deduped by slug with
project winning** (a project can locally override/redefine a mode that also
exists globally). That's the precedence model to replicate.

## What to build

### 1. A global custom-modes file

Pick `~/.roo/custom_modes.yaml` as the path (same directory family as the
already-working global rules, same filename convention — `custom_modes.yaml`
— that the real extension's `GlobalFileNames.customModes` already uses,
just at a portable path instead of VS-Code-internal storage). Same shape as
`.roomodes`: a top-level `customModes:` array, same schema
(`customModesSettingsSchema` from `src/vendor/zoo-code/types/index.js`,
already imported and used by `loadCustomModes` — reuse it, don't write a
second parser).

### 2. Merge logic in `loadCustomModes`

Modify `src/engine/prompt.ts`'s `loadCustomModes(workspaceRoot)`:
- Load the project's own `.roomodes` (existing logic, keep it — tag results
  `source: "project"`, already done).
- Load `~/.roo/custom_modes.yaml` if it exists (same YAML/JSON-fallback/
  cleaning logic already used for `.roomodes` — extract a shared helper
  rather than duplicating the parse/validate block twice). Tag results
  `source: "global"`.
- Merge: for each global mode, include it UNLESS a project mode with the
  same `slug` already exists (project wins, mirroring
  `CustomModesManager.mergeCustomModes`'s documented behavior — read that
  function for the exact tie-break, don't guess). Return the combined list.
- A missing `~/.roo/custom_modes.yaml` is not an error (mirrors a missing
  `.roomodes` today — returns `[]`for that source, zero behavior change for
  anyone who hasn't set this up).
- A malformed global file should behave the same way a malformed `.roomodes`
  already does today (check the existing behavior — logs an error and
  returns `[]` for that source, doesn't throw) for consistency, not a new,
  stricter failure mode introduced only for the global path.

### 3. Migrate the actually-universal content

This is a **content/config change, not just code** — do this as part of the
same task, it's what makes the feature real rather than theoretical:

- Move `multi-agent-orchestrator-headless`'s mode DEFINITION (the
  `.roomodes` entry itself — `roleDefinition`, `whenToUse`,
  `customInstructions`, `groups`) from this repo's own `.roomodes` into
  `~/.roo/custom_modes.yaml`. Its `customInstructions` reference generic
  scripts (`scripts/spawn-parallel-worktrees.sh`, `gh`, `npx tsx src/cli.ts
  orchestrate`) and generic file paths (`.orchestrator-state.json`,
  `plans/issues/`) — nothing project-specific is baked into the mode text
  itself, which is exactly why it's a good candidate to be the first
  globally-shared mode. Leave this repo's own `.roomodes` entry for it
  REMOVED (so you can prove the global merge is actually what's supplying
  it, not a leftover local copy) but leave `deepseek-reviewer` and
  `multi-agent-orchestrator` (the GUI one) local for now — their bodies
  reference more project-specific detail worth reviewing case-by-case later,
  not part of this task.
- Leave `.roo/rules-multi-agent-orchestrator-headless/rules.md` where it is,
  per-project, unchanged — this is exactly the kind of project-specific
  supplementary detail (this repo's own requirements, gotchas, coexistence
  notes with its other orchestration paths) that should stay local and get
  spliced ON TOP of the shared global mode definition, which the existing
  (already-working) rules merge already does for free once the mode itself
  is shared.
- If a sibling project on this machine also has its own copy of this mode
  (check `~/Projects/airunner/.roomodes` if you have access to it — if you
  don't, note that in your report rather than guessing at its content),
  remove the duplicate mode definition there too and confirm it still
  resolves correctly via the new global file, since that project would now
  be relying on the exact same global merge this task builds.

### What NOT to do

- Do not touch the rules-merging code — it already works, confirmed above.
  If your test for it fails, that means you misunderstood something about
  the existing code, not that it needs new logic.
- Do not move `deepseek-reviewer`'s mode definition to global in this task
  — its body is generic in spirit but its `whenToUse`/examples reference
  this repo specifically; leave it local, this can be revisited separately
  once there's a second real consumer to generalize against.
- Do not build any UI or CLI command for editing `~/.roo/custom_modes.yaml`
  — it's a plain YAML file, editing it directly is sufficient for this task.

## Tests

- New `src/engine/__tests__/global-modes.test.ts`: a project mode and a
  differently-slugged global mode both appear in the merged result; a
  project mode and a SAME-slugged global mode — only the project one
  appears (project wins); missing global file behaves as zero-config;
  malformed global file degrades the same way a malformed `.roomodes`
  already does (don't throw, match existing error-logging behavior).
- A real proof that the ALREADY-WORKING rules-merge does what this doc
  claims: write a fixture to a temp `HOME` (override `os.homedir()` via
  whatever mechanism the existing tests use to sandbox filesystem paths —
  check how other tests avoid touching the real `~/.roo/`, don't write to
  the real one from a test) containing `~/.roo/rules/rules.md`, build a
  system prompt via `buildSystemPrompt` against a temp project workspace,
  and assert BOTH the global and a project-local `.roo/rules/rules.md`
  file's content appear in the resulting prompt. This is existing behavior,
  not new — the point of this test is proving the doc's claim is actually
  true in this codebase today, since the plan depends on it.

## Verification checklist

1. `npx tsc --noEmit` clean.
2. `npm test` — all suites green including new ones.
3. Every e2e suite under `scripts/e2e*/run.sh` still passes — pay particular
   attention to any suite that asserts specific rules content appears in a
   dry-run prompt (search for `MODE RULE` / `GENERIC RULE` assertions), since
   this task's global-modes change must not affect what those already
   verify.
4. Manual smoke test: with `multi-agent-orchestrator-headless` removed from
   this repo's own `.roomodes` and present only in `~/.roo/custom_modes.yaml`,
   run `npx tsx src/cli.ts --dry-run --mode multi-agent-orchestrator-headless
   --workspace <this repo>` and confirm it still resolves and loads that
   mode's real `customInstructions` (not falling back to the built-in `code`
   mode's default) — this is the concrete proof the global merge is real, not
   just unit-tested.

## What to report back

- Files changed/added, including the exact content moved into
  `~/.roo/custom_modes.yaml`.
- Confirmation of tsc/test/e2e results (actual pass/fail counts).
- The manual smoke test's real output.
- Whether you had access to `~/Projects/airunner` and, if so, what you did
  there; if not, say so plainly rather than guessing at its `.roomodes`
  content.
- Any deviation from this spec, and why.
- Anything you noticed while doing this that looks like a related bug or
  gap, even if unfixed — flag it rather than ignoring it.
