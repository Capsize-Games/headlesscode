# `headlesscode init` — one-command project registration

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

> i want to use headlesscode with ~/Projects/rts_cpp but that project isn't
> set up as a headlesscode project. that made me realize that we need an
> easy way to register a project as a headlesscode project so that
> headlesscode will index the project and do everything else it needs to
> set it up. when registering a project, headlesscode should pay attention
> to the stack so that it chooses the correct instruction files for the
> project. it should also insure that .gitignore is set up correctly so
> that it doesn't index the wrong thing.

## What already works (verify, don't re-build)

Most of the "special setup per project" pain this describes was already
eliminated by the central-project-store work
(`plans/central-project-store-and-shared-instructions.md`,
`src/project-store.ts`):

- **Project registration/metadata is already automatic and passive.**
  `resolveProjectDataDir()` (`src/project-store.ts:143-167`) creates
  `~/.local/share/headlesscode/projects/<key>/` and writes
  `project.json` (`writeProjectMetadata`, `src/project-store.ts:176-192`)
  the first time ANY command touches a workspace. There is nothing to
  build here — do not add a second metadata-writing path.
- **Stack-aware instruction selection is already automatic.**
  `detectStacks(workspaceRoot)` (`src/engine/stacks.ts:243`) and
  `loadStackRules` (`src/engine/stacks.ts:368`) run on every system-prompt
  build (`src/engine/prompt.ts`) and splice in the right
  `shared/stacks/<stack>/rules.md` content with zero configuration. See
  `docs/stack-rules.md`. Do not add a separate "choose instructions at
  registration time" mechanism — detection already happens per-session,
  which is strictly more correct than a one-time choice (a repo's stack
  can change over time, e.g. a C++ project growing a Python tooling
  layer).
- **The codesearch index and codemap already live centrally**, never in
  the target repo, so they cannot pollute a target repo's git history
  regardless of that repo's `.gitignore` (`src/codesearch/index.ts:1-13`,
  `src/codemap/cli.ts:6-9`).

## The actual gaps

1. **No single command walks a human through registering a new project.**
   Today, using headlesscode against a fresh repo (e.g. `~/Projects/
   rts_cpp`) requires knowing to run `headlesscode index --workspace
   <path>` and `headlesscode codemap --workspace <path>` as two separate,
   undiscoverable steps, with no confirmation of what stack(s) were
   detected or whether anything is missing. Confirmed by reading
   `src/cli.ts:650-660` (the `index` and `codemap` subcommand dispatch) —
   there is no `init`/`register` subcommand anywhere in `src/cli.ts`.
2. **Nothing ensures a target repo's `.gitignore` excludes
   `.headlesscode/`.** Workspace-relative session artifacts DO still land
   inside the target repo by design: events (`src/engine/events.ts:85`,
   `<workspaceRoot>/.headlesscode/events`), the per-session markdown
   report (`src/engine/events.ts:24`,
   `<workspaceRoot>/.headlesscode/reports/<sessionId>.md`), usage records
   (`src/dashboard/aggregate.ts:13`,
   `<workspaceRoot>/.headlesscode/usage`), the scratch dir
   (`.roo/rules/rules.md`'s "Never write to /tmp" section,
   `<workspaceRoot>/.headlesscode/scratch/`), and the default memory dir
   (`README.md`'s `--memory-dir` entry, `<workspace>/.headlesscode/
   memory`). This repo's OWN `.gitignore` has `/.headlesscode/`
   (`.gitignore:15-16`) precisely because of this — but nothing propagates
   that same line into a NEW target repo, so a first run against
   `~/Projects/rts_cpp` risks a human accidentally `git add`-ing session
   logs/reports. Confirmed via `grep -rn "gitignore" src` — no code
   reads or writes a target repo's `.gitignore` anywhere today.

## What to build

Add a new `headlesscode init` subcommand (`src/init/cli.ts`, wired into
`src/cli.ts` next to the `index`/`codemap`/`migrate` dispatch block at
`src/cli.ts:646-692`) that runs the existing pieces in one step and reports
what it found/did. It is a thin orchestration layer over EXISTING
functionality — it must not reimplement stack detection, indexing, or
codemap building.

### Behavior

```
headlesscode init --workspace <path> [--skip-index] [--skip-codemap] [--embedding-backend <openrouter|ollama>]
```

Steps, in order, each printed as a clearly labeled section to stdout:

1. **Resolve + register.** Call `resolveProjectDataDir(workspace)`
   (`src/project-store.ts:143`) — this is the existing, sole registration
   mechanism; do not duplicate its `project.json` write. Print the
   resolved central data dir path.
2. **Detect stacks.** Call `detectStacks(workspace)`
   (`src/engine/stacks.ts:243`). Print the detected stack names (or "no
   recognized stack — generic instructions only" if empty). For each
   detected stack, check whether `getCentralStackRulesFile(stack)`
   (`src/engine/stacks.ts:65`) exists and note in the output if a stack
   was detected but has no rules content yet (this is informational, not
   an error — `docs/stack-rules.md`'s zero-config guarantee already
   handles the empty case silently everywhere else; `init` is the one
   place that surfaces it to a human on purpose, since registration is
   exactly when a human would want to know "this stack has no
   instructions yet, consider adding `shared/stacks/<stack>/rules.md`").
3. **Ensure `.gitignore` covers `.headlesscode/`.** New helper
   `ensureWorkspaceGitignore(workspace)` in `src/init/gitignore.ts`:
   - Read `<workspace>/.gitignore` if it exists (empty string if not).
   - If no existing line already matches/covers `.headlesscode` (accept
     any of `.headlesscode/`, `/.headlesscode/`, `.headlesscode`,
     `/.headlesscode` — reuse the same small matcher idiom
     `src/codesearch/files.ts:154`'s `matchesIgnorePattern` uses, don't
     write a new one from scratch if it can be imported/reused cleanly;
     otherwise a small local equivalent is fine since the existing one is
     file-local and not exported), append a new line `/.headlesscode/`
     (with a one-line comment above it, mirroring this repo's own
     `.gitignore:14-16`) to the file, creating it if absent. Preserve
     existing content byte-for-byte otherwise (no reformatting, no
     reordering).
   - Only touch the file if the workspace is a real directory (skip
     silently — do not create a `.gitignore` — if `<workspace>` doesn't
     exist; `init` should fail loudly in that case instead, see error
     handling below).
   - Print whether the file was created, appended to, or already covered.
4. **Build the codesearch index**, unless `--skip-index`. Reuse
   `buildIndex` (`src/codesearch/index.ts`) exactly as `src/codesearch/
   cli.ts`'s `indexMain` does — do not fork its logic; either call into a
   shared exported function or shell out to the same code path. This step
   costs real money (embedding calls) — print the same cost/token summary
   `indexMain` already prints today.
5. **Build the codemap**, unless `--skip-codemap`. Reuse `buildCodemap`
   (`src/codemap/build.ts`) exactly as `src/codemap/cli.ts`'s
   `codemapMain` does. No LLM cost.
6. **Final summary.** One block: workspace path, central data dir,
   detected stacks, gitignore action taken, index result (chunks
   embedded/skipped or "skipped by flag"), codemap result (regenerated or
   "skipped by flag").

### Error handling

- `--workspace` missing/not-a-directory → usage error, exit 2 (match the
  existing convention in `src/codesearch/cli.ts` / `src/codemap/cli.ts`
  for missing `--workspace`).
- A failure in the index or codemap step should NOT roll back the
  `.gitignore` edit or stack detection output already printed — each step
  is independent and its failure is reported inline, then `init` exits
  non-zero after finishing whatever later steps are still safe to run
  (mirrors this project's existing non-fatal-per-subsystem idiom
  described in `.roo/rules/rules.md`'s "Established conventions"
  section — but note indexing/codemap failures here ARE the primary
  purpose of the command, so unlike a truly auxiliary subsystem, `init`
  must still exit non-zero, just without corrupting the steps that did
  succeed).

### CLI wiring

Add to `src/cli.ts`'s subcommand dispatch (next to `index`/`codemap` at
`src/cli.ts:646-660`):

```ts
if (argv[0] === "init") {
	return initMain(argv.slice(1))
}
```

Add a corresponding one-line entry to the `USAGE` block (`src/cli.ts:147`
area, alongside the existing `index`/`codemap` entries at
`src/cli.ts:186-197`) so `headlesscode --help` surfaces it, and add
`headlesscode init --help` output following the exact style of
`INDEX_USAGE`/`CODEMAP_USAGE` (`src/codesearch/cli.ts:39`,
`src/codemap/cli.ts:22`).

### Tests

New `src/init/__tests__/gitignore.test.ts` (hand-rolled `assert`, `tsx`-run,
matching every other `__tests__` dir's style — see `src/codesearch/
__tests__/files.test.ts` for the idiom) covering `ensureWorkspaceGitignore`:

- No `.gitignore` exists → file created with the `.headlesscode` entry.
- `.gitignore` exists, no matching line → entry appended, existing content
  untouched.
- `.gitignore` already has `.headlesscode/`, `/.headlesscode/`,
  `.headlesscode`, or `/.headlesscode` → no-op, file unchanged (verify via
  exact byte comparison, not just "still contains the pattern").
- `.gitignore` has an unrelated pattern that does NOT cover
  `.headlesscode` (e.g. `node_modules/`) → entry still appended.

New `src/init/__tests__/cli.test.ts` covering the `init` subcommand
end-to-end against a fixture temp dir with `--skip-index --skip-codemap`
(so the test suite doesn't make real embedding API calls or need a
network) — asserts `.gitignore` was written, `project.json` exists in the
resolved central dir (use `$HEADLESSCODE_DATA_DIR` override the way other
tests do — grep `HEADLESSCODE_DATA_DIR` usage in `src/project-store.test.ts`
for the pattern), and stack detection output appears for a fixture with a
recognizable stack file (e.g. a `CMakeLists.txt` → `cpp` detected, directly
relevant to the `rts_cpp` motivating case).

Register both new test files in `package.json`'s `test` script (chained
with `&&`), matching every other test file's registration.

### Docs

Add a short "Registering a new project" section to `README.md` (near the
existing "Real-usage example against a target repo" section,
`README.md:99-115`) showing:

```bash
npx headlesscode init --workspace ~/Projects/rts_cpp
```

and one sentence on what it does (detects stack, indexes, builds codemap,
fixes `.gitignore`) — do not duplicate the full `--help` text, just point
to it.

## Out of scope (explicitly do not build)

- No new central-store schema changes — `project.json` stays as-is.
- No UI/dashboard changes — this is CLI-only for now.
- No auto-detection of a "correct" `.roomodes`/`.roo/rules-*` for the
  target repo — those remain the target repo's own, optional, project-local
  files (per `README.md:161`); `init` only handles the CENTRAL stack-rules
  tier, which is genuinely automatic.
- No change to `headlesscode migrate` — legacy migration is a separate,
  already-solved concern.
