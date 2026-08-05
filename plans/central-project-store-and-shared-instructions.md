# Central project data store + headlesscode-native shared instructions

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository —
a standalone Node/TypeScript CLI running a headless coding-agent loop. Match
the project's established conventions: no test framework beyond hand-rolled
`assert` + `tsx`-run test files, minimal new dependencies, `npx tsc --noEmit`
and `npm test` must stay green, re-run `scripts/e2e*/run.sh` afterward.
**Commit your work incrementally per logical change before calling
`attempt_completion`.**

**Do not start this until the currently in-flight round finishes and is
merged** (the three parallel worktrees dispatched 2026-08-04 evening:
`condense-async`, `decision-proxy`, `plan-citations`).

This is a bigger architectural change than recent rounds — consider
splitting it into two dispatched rounds if it grows unwieldy in practice:
(A) the central project data store (codesearch index, mode-models.json,
checkpoints), (B) the shared-instructions relocation. They're described
together here because they share the same underlying "stop requiring
per-project setup" motivation, but they touch different code and can land
independently — (A) has no dependency on (B) or vice versa.

## The problem, in the project owner's own words

> we need to insure that we can work on *any* project in *any* directory
> without having to do special setup in those directories

Four concrete real projects this must work for, zero special setup:
`~/Projects/airunner` (already used with headlesscode — has real state:
a freshly-built ~900MB codesearch index as of tonight), `~/Projects/
vileengine` (already used), `~/Projects/fastsearch` (never used with
headlesscode — the clean-slate proof this actually works with zero setup),
and `~/Projects/headlesscode` (this repo, self-hosting).

Confirmed live tonight, repeatedly, by hand: every one of these currently
needs a workspace-relative `.headlesscode/` directory (codesearch index,
`mode-models.json`) that a human/agent must manually create and populate —
and every NEW worktree of an already-set-up repo needs the same thing
seeded into it again (`scripts/spawn-parallel-worktrees.sh`'s copy-in logic,
which several worktrees tonight needed done by hand since they were spawned
outside the orchestrator's own state tracking). This is exactly the
"special setup per directory" the project owner wants eliminated.

Separately: `.roomodes` and `.roo/rules-*/rules.md` currently live
per-project and get fully duplicated across projects for the parts that
are genuinely identical everywhere (the Planning → Architect → Orchestrator
→ Reviewer pipeline, headlesscode-usage conventions) — only a fraction of
each project's `.roomodes`/rules content is actually project-specific.

## Design decision already made (do not re-litigate)

The vendored Zoo Code core already has a working global-shared-config
mechanism (`~/.roo/custom_modes.yaml`, `~/.roo/rules(-<mode>)/`, merged
with project-local content in `src/engine/prompt.ts`'s `loadCustomModes`
and the vendored `custom-instructions.ts`). Reusing it directly was
considered and explicitly REJECTED by the project owner in favor of a
fully headlesscode-native shared location, to complete the decoupling from
Zoo Code as a tool/dependency. Do not propose falling back to `~/.roo/` —
that door is closed. Do reuse the existing PARSING code (the zod schema,
the rules-directory-scanning logic) where possible; only the LOOKUP PATHS
need to change, not the file format or parsing logic — the format itself
(`customModesSettingsSchema`, plain YAML) isn't Zoo-Code-proprietary, only
the `~/.roo/` naming/location is.

## Part A: central per-project data store

### Location

`~/.local/share/headlesscode/` (XDG data-dir convention, per the project
owner's own suggestion), with this layout:

```
~/.local/share/headlesscode/
  projects/
    <project-key>/
      codesearch/index.jsonl(.meta.json)
      mode-models.json
      permissions.json          (if/when that exists per src/permissions/)
      project.json              (metadata: real path, first-seen timestamp)
  checkpoints/                  (see "Consolidate checkpoints" below)
```

### Project identity: resolve via git, not raw path

**Critical design point, verified live tonight**: `git rev-parse
--git-common-dir` from INSIDE A WORKTREE resolves to the MAIN repo's `.git`
directory, not the worktree's own — confirmed:
```
$ cd .worktrees/condense-async && git rev-parse --git-common-dir
/home/joe/Projects/headlesscode/.git
```
This means keying the project store by the resolved, absolute
`git-common-dir` (or its parent directory) rather than by the raw workspace
path gives TWO things at once, for free:
1. Any directory works with zero registration — the key is derived purely
   from the filesystem, nothing to set up.
2. **Every worktree of a repo automatically shares the SAME central store
   as the main repo** — no more seeding/copying a fresh worktree's index
   from the main checkout (`scripts/spawn-parallel-worktrees.sh`'s
   `.headlesscode/codesearch/index.jsonl` copy logic, and the manual
   copying done by hand for every worktree spawned tonight, both become
   unnecessary and should be REMOVED, not just left as a redundant
   fallback).

Resolution algorithm:
1. `git rev-parse --show-toplevel` on the workspace root if it's inside a
   git repo with NO separate common-dir complication — but prefer
   `--git-common-dir` specifically (resolved to an absolute path, then take
   its parent) so worktrees collapse to the main repo automatically.
2. If the workspace is NOT a git repo (a plain directory), fall back to
   the resolved (symlinks-followed) absolute realpath of the workspace root
   itself as the identity source.
3. Hash whichever identity string you land on (sha256, truncated to a
   reasonable length — this is a directory name, not a security boundary)
   to get `<project-key>`. Write `project.json` alongside it recording the
   real path this key was derived from — a human inspecting
   `~/.local/share/headlesscode/projects/` needs to be able to tell which
   directory is which project without re-deriving the hash by hand.

### Consolidate checkpoints too

`src/checkpoints/service.ts`'s `defaultCheckpointDir()` already uses a
GLOBAL, non-workspace-relative location — but a DIFFERENT one:
`~/.headlesscode/checkpoints` (not `~/.local/share/headlesscode/`). Two
different home-directory locations for what is conceptually the same kind
of data is exactly the fragmentation this whole task is meant to eliminate.
Move it to `~/.local/share/headlesscode/checkpoints` for consistency.
**This location has real existing data on the project owner's machine** —
do not silently orphan it. On first run under the new location, if the old
`~/.headlesscode/checkpoints` exists and the new location does not, migrate
(move, not copy — this can be large) and log what happened. Provide a
`headlesscode migrate` subcommand as the explicit, human-triggerable
version of this if an automatic migration feels too implicit for something
touching real data — check `docs/*.md` conventions for how other
migrations in this codebase have been handled, if any exist, and match
that precedent rather than inventing a new one from scratch.

### Migrating existing workspace-relative `.headlesscode/` dirs

Both `~/Projects/airunner` and `~/Projects/headlesscode` currently have
real, valuable, freshly-built `.headlesscode/codesearch/index.jsonl` data
(airunner's is ~900MB, rebuilt tonight at real embedding-API cost). The
same auto-detect-and-migrate-once behavior applies: on first run against a
workspace that has an old-style `<workspaceRoot>/.headlesscode/` AND no
corresponding central-store entry yet, migrate the content across (move,
log clearly) rather than silently starting from a fresh unindexed state
and forcing a costly re-embed. Do NOT delete the old directory automatically
without confirming the move succeeded — verify the copy/move landed intact
before removing the source.

### Code changes (mechanical, once the resolution function exists)

Centralize the "given a workspace root, what's its central data dir"
resolution into ONE new function (e.g. `resolveProjectDataDir` in
`src/index-util.ts`, or a new `src/project-store.ts` if that grows large
enough to deserve its own module) and have every current call site use it
instead of joining `workspaceRoot` + `.headlesscode`:
- `src/index-util.ts` (`indexFilePathFor`, `hasCodebaseIndex`)
- `src/codesearch/types.ts`/`cli.ts` (`INDEX_RELATIVE_PATH` usage)
- `src/config/mode-models.ts` (wherever it resolves
  `<workspaceRoot>/.headlesscode/mode-models.json`)
- `src/checkpoints/service.ts` (`defaultCheckpointDir`)
- `scripts/spawn-parallel-worktrees.sh`'s seeding logic — DELETE the
  copy-in-index/copy-in-mode-models steps entirely once worktrees resolve
  to the same central store automatically; leave the `zoo-code` symlink
  step alone, that's an unrelated concern.

## Part B: headlesscode-native shared instructions

### Location

`~/.local/share/headlesscode/shared/` (same root as Part A, different
subtree):
```
~/.local/share/headlesscode/shared/
  modes.yaml              (replaces the role ~/.roo/custom_modes.yaml plays)
  rules/                  (replaces ~/.roo/rules/)
  rules-<mode>/           (replaces ~/.roo/rules-<mode>/, one per mode slug)
```

### Code changes

In `src/engine/prompt.ts`'s `loadCustomModes`: change the hardcoded global
path from `path.join(os.homedir(), ".roo", "custom_modes.yaml")` to
`path.join(os.homedir(), ".local", "share", "headlesscode", "shared",
"modes.yaml")` (or route through whatever central helper Part A introduces,
if it makes sense to share that path-root logic — don't force it if the
two don't naturally share code). Reuse `customModesSettingsSchema` and
`loadModesFromFile` UNCHANGED — only the path constant moves. Do the
equivalent for wherever the vendored `custom-instructions.ts` resolves its
global `.roo/rules(-<mode>)/` search paths — same treatment: change the
path, keep the file-scanning logic.

### Content migration: audit before moving anything

Don't guess at what's shared vs. project-specific from memory. Actually
diff the real `.roomodes` / `.roo/rules-*/rules.md` files across all four
named projects that have them (at minimum `~/Projects/headlesscode` and
`~/Projects/airunner`, both confirmed to have real `.roomodes` content
tonight; check `~/Projects/vileengine` and `~/Projects/fastsearch` too —
the latter may have none yet, which is fine, it's the zero-setup proof
case). The Planning/Architect/Orchestrator-headless/Reviewer mode
definitions were confirmed byte-for-byte-similar between headlesscode's own
`.roomodes` and airunner's tonight — that's the strongest known candidate
for the shared file. Genuinely project-specific content (e.g. airunner's
UwUChat-only-vs-framework-code split, or whatever's specific to
vileengine's engine conventions) stays in each project's own `.roomodes`/
`.roo/rules-*/`, which continues to override/extend the shared definitions
exactly like the existing project-wins-on-slug-collision merge already
does.

## Part C: central, cross-project operational defaults (embedding model + provider pin)

Confirmed live tonight: headlesscode's codesearch embedder
(`src/codesearch/embedder.ts`) has NO OpenRouter provider pin at all today
— pure auto-routing. Compare against `~/Projects/airunner`'s own working
setup (`projects/uwuchat/server/embedding_provider.py`): model
`qwen/qwen3-embedding-8b` (the 8b variant — headlesscode currently defaults
to 4b), pinned via `extra_body.provider = {"order": ["DeepInfra"],
"allow_fallbacks": false}`, chosen there specifically for zero data
retention + lower cost (see that file's own comment). There's no
conflicting rationale in headlesscode for embeddings the way there is for
chat (below), so matching airunner's embedding provider/model choice is a
reasonable default.

**Do NOT extend this to the deepseek/* CHAT model pin.** `src/llm/
openrouter.ts:655-667` already pins `deepseek/*` calls to DeepSeek's
OFFICIAL endpoint specifically because its cache-read pricing is ~10x
cheaper than third-party hosts (DeepInfra included) — this is a deliberate,
already-correct, already-documented choice, made for the exact caching
economics this whole effort has been optimizing tonight
(`plans/smart-condensation-async.md`). Airunner pins DeepInfra for chat for
an unrelated reason (US-hosting compliance for the model's Chinese origin,
not cost) — matching that here would likely make headlesscode's caching
economics WORSE, not better. Leave `openrouter.ts`'s existing pin alone;
this section is scoped to the EMBEDDING model only.

Per the project owner's direction: **this is a cross-project operational
default, not per-project config** — it belongs in the central store from
Part A, not in any individual project's `.headlesscode/mode-models.json`.
Add it to `~/.local/share/headlesscode/`'s own top-level config (e.g.
`~/.local/share/headlesscode/settings.json` or similar — check whether Part
A's design already has a natural home for headlesscode-wide-but-not-
per-project settings, and use that rather than inventing a second
central-config file if one already exists by the time this lands), covering:
- Default embedding model: `qwen/qwen3-embedding-4b` → `qwen/qwen3-embedding-8b`
  (confirm the cost delta is acceptable before committing to this — 8b will
  cost more per index build than 4b; check real numbers, don't assume).
- Default embedding provider pin: add `{"order": ["DeepInfra"],
  "allow_fallbacks": false}` to `src/codesearch/embedder.ts`'s OpenRouter
  embedding request, matching airunner's exact provider name capitalization
  (`"DeepInfra"`, not `"deepinfra"` — OpenRouter's provider slugs may be
  case-sensitive; verify live before assuming either casing works).
- This should be a per-user/machine default (central store), not hardcoded
  in application code with no override — someone on a different OpenRouter
  account without DeepInfra data-policy access needs a way to change it.

## Part D: default tools must be language-generic or conditionally gated

### The problem

Confirmed by direct inspection: the ENTIRE codeintel tool family —
`outline`, `go_to_definition`, `find_references`, `import_graph`, and the
newly-added `rename_symbol` — is built exclusively on TypeScript's
`ts.Program`/`ts.LanguageService` (`src/codeintel/program.ts`), which only
scans `.ts`/`.tsx`/`.mts`/`.cts` files. The newly-added `run_tests`
(`src/tools/test-selection.ts`, `src/tools/run-tests.ts`) is similarly
TypeScript-specific: direct-match test discovery is hardcoded to `foo.ts`
→ `__tests__/foo.test.ts`, and execution is hardcoded to the `tsx`
invocation `npm test` uses.

This directly contradicts the "work on any project, zero special setup"
goal this whole plan is about. All five codeintel tools plus `run_tests`
are unconditionally advertised in every session's tool list (confirmed:
every `harness.log` session-start line tonight lists them regardless of
workspace) — for a real target project like `~/Projects/vileengine` (C++)
or the Python portions of `~/Projects/airunner`/`~/Projects/fastsearch`,
these tools are dead weight: listed, costing prompt tokens on every single
request, and silently useless or error-prone if the model tries them.

**`codebase_search` already gets this right** — its chunker
(`src/codesearch/chunk.ts`, `CODE_EXTENSIONS` in `src/codesearch/types.ts`)
already handles Python, C++, Rust, Go, and more via a broad extension list
and language-aware boundary heuristics. That's the existing bar these newer
tools should be held to, not a new standard being invented here.

### What to build

Don't scope a full multi-language rewrite of the codeintel tools (real
per-language AST/LSP support) into this round — that's a much bigger lift
(tree-sitter integration or per-language language-server processes) and
deserves its own plan if pursued. For THIS round, the pragmatic fix is
**detect the workspace's language(s) and conditionally gate which tools get
advertised**, mirroring the pattern already used for read-only executors
not receiving write tools:

- Add a cheap workspace-language detector (extension-frequency over the
  same file walk `codebase_search`'s indexer already does, or marker files:
  `package.json`/`tsconfig.json` → TS/JS, `pyproject.toml`/`setup.py` →
  Python, `CMakeLists.txt`/`*.cpp`+`*.h` presence → C++, etc. — keep it
  simple, this doesn't need to be exhaustive, just accurate enough to
  gate on).
- Only register/advertise the `ts.Program`-based codeintel tools
  (`outline`, `go_to_definition`, `find_references`, `import_graph`,
  `rename_symbol`) when the workspace is actually detected as TS/JS.
- For `run_tests`: either (a) restrict it the same way (TS/JS-only for
  now, advertised only when detected), or (b) add a second, genuinely
  generic test-invocation path for at least the languages the four named
  real projects need (Python → `pytest`, and check what `vileengine`
  actually uses for C++ — don't guess, look at its real build/test
  setup) — (b) is more work but directly serves the stated goal better
  than just hiding the tool on non-TS projects. Decide based on time
  budget; (a) is an acceptable interim step if (b) doesn't fit this round.
- Whichever tools stay TS-only, make that scoping EXPLICIT and gated, not
  an accident of "we only ever tested this on headlesscode's own repo" —
  the whole point is these four real projects (including two never
  verified with headlesscode before) must each get a tool list that
  actually matches what works for them.

### Testing

- Unit tests for the language detector against small fixtures of each
  target shape (a TS project, a Python project, a C++ project) — assert
  the codeintel tools/run_tests appear only where appropriate.
- Real verification against the actual named projects: confirm
  `~/Projects/vileengine`'s session tool list does NOT include the
  TS-only tools, and `~/Projects/headlesscode`'s own session tool list
  still does.

## Part E: OpenRouter pricing must not silently go stale

### The problem

`src/budget/cost.ts`'s `DEFAULT_PRICING_TABLE` is a hardcoded table,
manually verified at specific past dates noted in comments (e.g.
"verified against OpenRouter's own `/api/v1/models/.../endpoints` on
2026-08-01") — there is no live-fetch and no scheduled refresh for
pricing at all, only for context-window SIZE (a different, already-fixed
concern). This file's own comments document that staleness here has
ALREADY caused real incidents: a model missing from the table once caused
a false-positive budget abort via the 7x-too-high fallback rate, and a
`cacheRead` price was once off by 10x before being caught. This is a
guardrail (budget cap enforcement), not just cosmetic — both under- and
over-estimating real cost has already caused a real problem in each
direction.

### What to build

Extend the ALREADY-LIVE context-window fetch mechanism
(`fetchModelContextWindow` in `src/llm/openrouter.ts`, fixed earlier
tonight per `plans/speed-and-context-efficiency.md`) to ALSO capture
pricing from the same `/api/v1/models/<id>/endpoints` response if it
carries per-token price fields (check the real response shape live before
assuming — verify field names/units directly against the API, the same
way the context-window fix was verified, don't guess from memory).
Mirror the exact same fail-open pattern already established: live-fetched
price wins when available, `DEFAULT_PRICING_TABLE`'s hardcoded value
remains the fallback (not removed) for when the live fetch fails or the
model/endpoint doesn't expose pricing this way — resolved once per
session and cached, same as the context-window value (reuse
`resolvedContextWindowTokens`'s caching fix as the pattern to follow
exactly, including its bug: cache the VALUE, not just that a fetch was
attempted).

### Testing

- Unit test: a fake `LlmClient` returning a live price differing from the
  hardcoded default — assert cost estimation uses the live value.
- Unit test: live fetch fails/returns nothing — assert fallback to
  `DEFAULT_PRICING_TABLE` exactly as today, no behavior change from a
  session with no live pricing available.
- Real-session check: confirm a live session logs which price source
  (live vs. fallback) it actually used, the same way context-window
  resolution already logs `[condense] resolved live context window...` —
  add an equivalent log line so pricing staleness is visible in
  `harness.log` going forward, not silently assumed correct.

## What NOT to build

- Don't invent a new file format for modes/rules. The YAML shape
  (`customModesSettingsSchema`) and the rules-directory-scanning convention
  already work and are already tested — only the lookup PATHS are Zoo-Code
  branded, not the format. Changing the format too is unnecessary risk for
  no benefit here.
- Don't build a project "registration" step (a command a human runs once
  per new project to "set it up"). The entire point is zero special setup
  — the git-common-dir-derived key must make every project work on first
  contact, including ones (like `fastsearch`) that have never touched
  headlesscode before.
- Don't try to solve credential/secrets storage as part of this — that's a
  separate, unrelated concern (`.env` handling already exists per-project
  and isn't in scope here).

## Testing

- Unit tests for the project-key resolution: a real git repo fixture, a
  worktree of it, and a plain non-git directory — assert the repo and its
  worktree resolve to the SAME key, and the non-git directory gets its own
  distinct key derived from its realpath.
- Migration tests: an old-style `<workspaceRoot>/.headlesscode/` with a
  fake index file present, run resolution, assert the content lands in the
  new central location and the source is only removed after the copy is
  verified intact.
- End-to-end verification against the REAL four named projects, not just
  fixtures — this is the actual acceptance bar the project owner cares
  about:
  1. `~/Projects/fastsearch` (never used before): run `headlesscode index
     --workspace ~/Projects/fastsearch` fresh with zero manual setup,
     confirm the index lands under
     `~/.local/share/headlesscode/projects/<key>/codesearch/`, not inside
     `fastsearch` itself.
  2. `~/Projects/airunner` (has real existing state): confirm its ~900MB
     index migrates correctly and codebase_search still works against it
     post-migration, without a costly full re-embed.
  3. Spawn a worktree of `~/Projects/headlesscode` (this repo) and confirm
     `codebase_search` works in it immediately with NO seeding step at
     all — this is the concrete proof that Part A's worktree-sharing
     design point actually holds, not just the unit-test fixture version
     of it.
