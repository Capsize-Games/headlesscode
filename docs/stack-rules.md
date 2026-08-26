# Stack-specific instructions (stack rules)

headlesscode runs against ANY target codebase — it is not npm/TS-specific.
Different stacks have materially different conventions, footguns, and
verification tooling, so per-stack guidance is keyed by the stack a target
project actually uses instead of being stuffed into the generic prompt
template (which would either bloat every session with irrelevant
instructions or give wrong advice to projects that don't use that stack).

This doc covers the INFRASTRUCTURE (detection + splicing). The actual
per-stack guidance text (`rules.md` content) is deliberately out of scope
here and is tracked per-stack; with all stacks empty the feature is a
zero-behavior-change no-op.

## How it works

On every system-prompt build (`buildSystemPrompt` in `src/engine/prompt.ts`):

1. `detectStacks(workspaceRoot)` (`src/engine/stacks.ts`) figures out which
   stacks the target project uses. Detection is cheap and filesystem-only; a
   project can match MULTIPLE stacks at once (e.g. a FastAPI + React +
   PostgreSQL repo matches all three).
2. `loadStackRules(workspaceRoot)` reads each detected stack's `rules.md` —
   global (central) first, then project-local — and concatenates them in
   alphabetical stack order, so prompt content is reproducible across runs.
3. Only when at least one detected stack has non-empty rules content is a
   clearly delimited `STACK-SPECIFIC INSTRUCTIONS` section appended to the
   system prompt. A project matching zero stacks, or stacks whose `rules.md`
   don't exist yet, produces a prompt byte-identical to before.

## Storage conventions

Two tiers, same precedence shape as the existing global+project rules splice
(`~/.roo/rules/` + `<project>/.roo/rules/` — additive, both labeled with
their source path in the prompt):

| Tier | Path |
| ---- | ---- |
| Central (global, ships with headlesscode) | `<store>/shared/stacks/<stack>/rules.md` — `<store>` is `projectStoreRoot()` (`~/.local/share/headlesscode` by default; `$HEADLESSCODE_DATA_DIR` overrides it, exactly like every other central-store consumer) |
| Project-local (optional override/addition) | `<workspaceRoot>/.roo/rules-stack-<stack>/rules.md` |

**Repo source for the central tier.** The central tier's content is authored in
this repo at `shared/stacks/<stack>/rules.md` (this is what "ships with
headlesscode" means — the repo is the canonical source), and installed into the
per-machine central store by `scripts/sync-shared-rules.sh` (the generalized
syncer for the whole shipped `shared/` tree — stacks plus the generic
`rules-code` tier), which `scripts/install-cli.sh` also invokes. The script
installs to the SAME root the engine reads (`getCentralStackRulesDir()` in
`src/engine/stacks.ts` resolves through `projectStoreRoot()`, so a
`$HEADLESSCODE_DATA_DIR` override is honored on both sides — an install is only
real if the engine can read it back). A missing file is never an error — same
idiom as the existing missing-file handling for `mode-models.json` /
`.roomodes` (zero config = zero behavior change).

### Shipping the central content

The central tier is a shipped set, not a user-created one: the canonical
copy lives in the repo at `shared/stacks/<stack>/rules.md` (mirroring the
runtime layout), and reaches the central store two ways:

- **Local install** (`scripts/install-cli.sh`, via `scripts/sync-shared-rules.sh`):
  syncs the repo's `shared/` tree (per-stack `rules.md` + the generic
  `rules-code` rules) into the central store (idempotent — only ever
  adds/overwrites files under that tree, never deletes). Re-run after `git
  pull` to pick up content changes.
- **Docker image** (`docker/Dockerfile` + `docker/entrypoint.sh`): the image
  COPYs `shared/`, and the entrypoint seeds it into the container's `$HOME`
  at every start (the central store lives on the `/data` volume, which
  shadows image content).

Both paths resolve the destination the SAME way the runtime reads it:
`getCentralStackRulesDir()` (`src/engine/stacks.ts`) is store-root-derived
via `projectStoreRoot()` (`src/project-store.ts`), which honors the
`$HEADLESSCODE_DATA_DIR` override — so the shipped content lands at
`$HEADLESSCODE_DATA_DIR/shared/stacks/` when the override is set, else
`~/.local/share/headlesscode/shared/stacks/`. An install/seed step that used
a DIFFERENT resolution (as `install-cli.sh` briefly did) silently ships to
the wrong place — verify both sides agree before trusting an install.

A project-local `.roo/rules-stack-<stack>/rules.md` in a target repo is never
touched by either path — that tier stays purely user-owned.

## Detection heuristics

Starting point; per-stack content (not these signals) is refined in the
per-stack child issues:

| Stack | Signal |
| ----- | ------ |
| `typescript` | `tsconfig.json` present, or any project `*.ts`/`*.tsx` file |
| `javascript` | `package.json` present |
| `python` | `pyproject.toml` / `requirements*.txt` / `setup.py` present, or any project `*.py` file |
| `react` | `react` in `package.json` `dependencies` |
| `fastapi` | `fastapi` in `pyproject.toml` / `requirements*.txt` |
| `postgresql` | a postgres driver (`psycopg`, `psycopg2`, `asyncpg`) in Python deps, OR a `postgres`-image service in `docker-compose*.yml` / `compose*.yml`, OR a `migrations/`/`alembic`-style directory |
| `cpp` | `CMakeLists.txt` present, or any project `*.cpp`/`*.hpp`/`*.cc`/`*.hh` file |

"Project file" means git-tracked files (via `git ls-files
--cached --others --exclude-standard`, so `.gitignore` is honored) when the
workspace is a git repo; otherwise a bounded recursive walk that skips the
usual heavy directories (`node_modules`, `.git`, `dist`, `build`, `vendor`,
`.venv`, …).

## Zero-config guarantee

`loadStackRules` first checks whether ANY rules source exists — the central
stacks directory or a project-local `.roo/rules-stack-*` directory. If
neither exists, detection is skipped entirely and no prompt change happens:
existing sessions and e2e suites see byte-identical prompts.

## Testing

`src/engine/__tests__/stacks.test.ts` covers `detectStacks` against fixture
trees for each of the 7 stacks (including multi-stack and git-tracked
projects), `loadStackRules` precedence/ordering, and the `buildSystemPrompt`
splice gating (zero-config builds are asserted byte-identical).
