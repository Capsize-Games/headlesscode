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
| Central (global, ships with headlesscode) | `~/.local/share/headlesscode/shared/stacks/<stack>/rules.md` |
| Project-local (optional override/addition) | `<workspaceRoot>/.roo/rules-stack-<stack>/rules.md` |

Per-stack content is authored in-repo under `shared/stacks/<stack>/rules.md`
(the source of truth, mirroring the central path minus the
`~/.local/share/headlesscode` prefix) and installed to the central path on
each machine.

A missing file is never an error — same idiom as the existing missing-file
handling for `mode-models.json` / `.roomodes` (zero config = zero behavior
change).

## Where the shipped content lives

The canonical per-stack content is committed to this repo under
`shared/stacks/<stack>/rules.md` — a mirror of the central runtime layout —
and reaches the central store two ways:

- **Local install** (`scripts/install-cli.sh`): syncs the repo's `shared/`
  tree into `~/.local/share/headlesscode/shared/` (idempotent — only ever
  adds/overwrites files under that tree, never deletes). Re-run the script
  after `git pull` to pick up content changes, same as the CLI wrapper.
- **Docker image** (`docker/Dockerfile` + `docker/entrypoint.sh`): the image
  COPYs `shared/`, and the entrypoint seeds it into the container's `$HOME`
  at every start (the central store lives on the `/data` volume, which
  shadows image content).

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
