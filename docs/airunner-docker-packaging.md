# Packaging headlesscode for airunner's Docker deployment

Status: **v1 shipped 2026-08-02** — headlesscode is installable and runnable
inside airunner's existing Docker stack as an opt-in sidecar service. It is
NOT yet wired into uwu's tool-calling (that remains `plans/uwuchat-integration.md`
Tier 1, gated on that plan's own Phase 2 status).

## TL;DR

- A purpose-built image (`docker/Dockerfile`, `node:22-bookworm-slim` + git,
  source + `npm ci`) runs headlesscode as a **sidecar service** next to
  airunner's Python `server` container — **not** inside the Python image.
- Build it from the headlesscode repo: `docker build -f docker/Dockerfile -t
  headlesscode:0.1.0 .` (or run `scripts/docker-smoke.sh`, which builds AND
  verifies).
- airunner opts in with a separate compose override,
  `extensions/docker/docker-compose.headlesscode.yml` (combined with
  `docker-compose.prod.yml`). Nothing about the deployed `server` service
  changes.
- Workspaces + state live on the same `/data` named volume the backend uses
  (`server_data`), under `/data/headlesscode-workspaces` (+
  `/data/headlesscode-home` for the central data store — checkpoints at
  `~/.local/share/headlesscode/checkpoints` and the per-project store under
  `~/.local/share/headlesscode/projects/`), so they survive image rebuilds.
- Playwright browsers are **not** in the image (v1 decision — see below);
  `browser_action` needs an explicit one-time `npx playwright install
  chromium` step before it works.

## Why a sidecar service, not Node inside the `server` image

This is the one big architectural call, made after reading airunner's real
Docker setup and `plans/uwuchat-integration.md`'s Tier 1 framing:

1. **The two runtimes can't share a process anyway.** uwuchat's backend is
   Python; headlesscode is a Node CLI. "Same container" (option a) would still
   mean Python spawning `headlesscode` as a subprocess — the only thing (a)
   buys over (b) is avoiding a network hop. Tier 1's own framing is
   "orchestrator tool **shells to** `headlesscode orchestrate`" — a
   subprocess/API call, which is exactly what a sidecar over the Docker
   network supports.
2. **Keeps the Python image lean.** `Dockerfile.prod` is
   `python:3.13-slim-bookworm` with deliberately no build toolchain. Adding
   Node 22 (via NodeSource apt), git, and a full `npm ci` node_modules tree to
   that image bloats every backend deploy with an entire second language
   runtime the backend itself never uses.
3. **Matches the stack's existing shape.** airunner already runs small,
   focused services (db, caddy, server) and documents the fastsearch sidecar
   pattern in `docker-compose.prod.yml`. A headlesscode service is the same
   pattern.
4. **Cleanly opt-in.** The sidecar is a *new* service in a *separate*
   override file; the existing `server` service is byte-for-byte untouched.
   With (a), Node+git would be baked into the production backend image for
   everyone from day one.

The tradeoff, accepted for v1: the server reaches headlesscode over the
internal Docker network (DNS alias `headlesscode`) rather than a
same-filesystem subprocess. Tier 1's wiring (plan build order item 1) will
pick the invocation surface (dashboard/HTTP or a thin API shim) — the image
and compose placement here don't constrain that choice.

## Image layout

`docker/Dockerfile` (build context = headlesscode repo root):

- `node:22-bookworm-slim` — the same Node LTS this stack's client build
  already uses (`Dockerfile.caddy`), satisfying `"engines": {"node": ">=18"}`.
- `git` + `ca-certificates` via apt (git is load-bearing: worktree spawn,
  shadow-git checkpoints, reviewers; ca-certificates for OpenRouter/npm TLS).
- `npm ci` (full, devDependencies included) — headlesscode has **no compiled
  output**; `tsx` + `typescript` run the TypeScript source at runtime, so they
  are runtime `dependencies` (since issue #99, the package's `bin` must work
  from a clean `npm install -g`, which installs dependencies only). The
  playwright npm package is also a runtime dependency but installs JS-only
  (no browser download on install — no install script).
- `src/` copied; a `/usr/local/bin/headlesscode` wrapper runs
  `tsx /opt/headlesscode/src/cli.ts` (the package's `bin` entry only becomes
  executable when installed as a dependency, so a fixed wrapper mirrors the
  repo's own invocation). The wrapper exports `TSX_TSCONFIG_PATH=/opt/headlesscode/tsconfig.json`:
  tsx discovers tsconfig from the *cwd*, and the CLI is invoked from arbitrary
  working directories (orchestrated checkouts, scratch repos, `/data/...`) —
  without the pin, tsx would pick up some unrelated tsconfig (or none) and
  the CLI would fail to boot from a foreign cwd.
- The three runtime orchestration scripts (`scripts/spawn-parallel-worktrees.sh`,
  `run-worker.sh`, `headlesscode-answer.sh`) are copied in — a real
  non-dry-run `orchestrate` run shells out to them (the rest of `scripts/` is
  dev/deploy tooling and stays out of the image).
- `docker/entrypoint.sh` recreates `/data/headlesscode-workspaces` and
  `$HOME` at every start (the volume mount shadows image-build dirs) and sets
  a default global git identity (override via `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`).

`.dockerignore` (repo root) keeps the build context small and keeps
local-only state out of the image: `.env*`, `.headlesscode/` (hundreds of MB
in a live worktree), node_modules, logs, the gitignored `/zoo-code/` clone,
etc.

## airunner side: opt-in compose override

`extensions/docker/docker-compose.headlesscode.yml` (in the airunner repo):

```bash
docker compose --env-file .env.prod \
  -f docker-compose.prod.yml \
  -f docker-compose.headlesscode.yml \
  up -d --build
```

The service:

- `image: headlesscode:0.1.0` — built from the **headlesscode** repo, not
  airunner's tree (no vendored source, no publishing pipeline for v1; build
  on the deploy host or `docker save`/`load` a locally built image).
- internal-network alias `headlesscode`, no published ports (like `db`).
- `server_data:/data` — the same named volume the backend mounts, so state
  survives rebuilds; headlesscode only ever touches its own `/data/headlesscode-*`
  subpaths.
- `env_file: [.env]` — the exact convention the `server` service already
  uses; no separate secrets mechanism.
- `healthcheck` runs `headlesscode --version`; v1 command is `sleep infinity`
  (idle install target until Tier 1 wires a real invocation surface).

Validated with `docker compose config` (base + override and base alone both
parse; the merged `headlesscode` service resolves to the intended image,
volume, network alias, env, and healthcheck).

## Workspace / state placement

- Git workspaces: `/data/headlesscode-workspaces/<project>` (=
  `HEADLESSCODE_WORKSPACE_ROOT`).
- Per-workspace session state: `<workspace>/.headlesscode/` (usage/events/
  memory feeds, plus `reports/` — the complete per-session final
  `attempt_completion` reports, issue #34), plus repo-local `.worktrees/`
  for orchestrated sessions.
- Global + per-project central state: `$HOME=/data/headlesscode-home` — covers
  the central data store (`~/.local/share/headlesscode/`): the checkpoint
  root (`~/.local/share/headlesscode/checkpoints`, which must stay outside any
  workspace), the per-project store (`projects/<key>/` — codebase index,
  mode-models.json, permissions.json), the shared instructions
  (`shared/`), and anything else that keys off `$HOME`.
- All of it is on `server_data:/data`, so image rebuilds/deploys never
  destroy it.

## Playwright / `browser_action`

**Decision: browsers are NOT installed in the image for v1.**

- The `playwright` npm package installs JS-only (no browser download on
  `npm ci`), so the base image is lean by default and `browser_action` fails
  with a clear "executable doesn't exist" error until browsers are added.
- The browser binaries (~400MB with Chromium + OS deps) are a poor trade for
  a v1 whose focus is the core orchestrate/worker/review harness —
  `browser_action` isn't on Tier 1's critical path.
- Enabling later is explicit and contained, in the image or at runtime:

  ```bash
  docker run --rm -it headlesscode:0.1.0 bash
  npx playwright install chromium
  npx playwright install-deps chromium   # needs apt in the image (root)
  ```

## Environment / config wiring

All variables flow through the existing `env_file` (`.env` / `.env.prod`)
convention — nothing new is invented:

| Variable | Required? | Notes |
|---|---|---|
| `HEADLESSCODE_OPENROUTER_API_KEY` | **Yes** (real runs) | Same system-owned key the rest of uwuchat uses. Needed only for non-`--dry-run` sessions. |
| `HEADLESSCODE_EMBEDDING_BACKEND` | **No — leave unset** | **Confirmed: `ollama` does NOT make sense here.** This deployment has no local GPU and no ollama service; the code default `openrouter` (see `DEFAULT_EMBEDDING_BACKEND` in `src/codesearch/embedder.ts`) is the correct backend. The dev-machine `.env` in this repo sets `ollama` as a local-only opt-in — do not copy that setting into the container. |
| `HEADLESSCODE_WORKSPACE_ROOT` | no (default set) | `/data/headlesscode-workspaces` (baked into the image + compose). |
| `HEADLESSCODE_MAX_COST_USD`, `HEADLESSCODE_MAX_DURATION_MS` | no | Per-session budget guardrails (Phase 6). |
| `HEADLESSCODE_MAX_CONCURRENT_SESSIONS` | no | Global concurrency cap. |
| `HEADLESSCODE_STREAM`, `OPENROUTER_MODEL`, `OPENROUTER_HTTP_REFERER`, `OPENROUTER_APP_TITLE` | no | Standard CLI/OpenRouter overrides. |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | no | Git identity for the harness's commits; the entrypoint defaults to `headlesscode <headlesscode@localhost>` if unset. |

## Isolation model — explicitly NO nested Docker

Verified against airunner (2026-08-02): **no `/var/run/docker.sock` mount and
no `docker` CLI exist anywhere in the stack** (zero grep hits for
`docker.sock` across the tree). `DockerSessionProvider`
(`src/cloud/docker-provider.ts`) shells out to a local `docker` CLI to spin up
per-session containers — it cannot run inside a container that has no Docker
access without first adding Docker socket access to a container, which is a
real, separate security expansion the project owner hasn't decided on.

This packaging **does not add it**: no docker.sock, no docker CLI, no
`DockerSessionProvider`. v1 sessions run as plain git worktrees + sibling OS
processes inside the one sidecar container — isolated from each other by
separate working directories/PIDs, not separate containers. `plans/uwuchat-integration.md`
section 5 documents the same correction and the accepted tradeoff for the
admin-only Tier 1 scope.

## Verification

`scripts/docker-smoke.sh [image-tag]` builds the image and proves the install
works inside a container:

1. image builds (source COPY + `npm ci` inside the image),
2. `headlesscode --version`,
3. `headlesscode --dry-run` (system prompt build, no API key, no LLM),
4. `headlesscode orchestrate --dry-run` against a scratch git repo with
   `--issues-json` (git + the orchestrator CLI path; no `gh` CLI needed),
5. `/data` volume convention: with a volume mounted at `/data`, the entrypoint
   creates `/data/headlesscode-workspaces` + `/data/headlesscode-home` and the
   CLI runs from that state root.

Requires docker + network for `npm ci`. Exit 0 = PASS.

## Explicitly out of scope (v1)

- Wiring headlesscode into uwu's tool-calling — that's
  `plans/uwuchat-integration.md` Tier 1.
- A publishing pipeline (private npm registry, versioned releases) — the
  image is built from a direct source copy; no `dist`/build step exists in
  headlesscode itself and none is introduced.
- Docker socket access / per-session container isolation (see above).
- Changes to the behavior of any currently-deployed airunner service — the
  compose override is purely additive.
