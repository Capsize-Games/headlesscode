# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# headlesscode — standalone headless coding-agent CLI, packaged as a Docker
# image. Runs headlesscode as a standalone service (CLI/orchestrator/watcher)
# next to whatever application container wants to drive it over the Docker
# network.
#
# Node 22 + git; tsx executes the TypeScript source directly — there is no
# compiled output in this repo, so devDependencies are needed at runtime and
# installed via `npm ci`.
#
# Build context = headlesscode repo root:
#   docker build -f docker/Dockerfile -t headlesscode:0.1.0 .
#
# Registry + tag policy: images are published to
# ghcr.io/capsize-games/headlesscode, tagged with the exact `version` from
# package.json (e.g. `0.1.0`) plus a floating `latest` pointing at the most
# recent release build. Pin the versioned tag in any deployment that needs
# reproducibility — `latest` is for local experimentation only.
#
# Deliberately NOT installed here:
#   - Playwright browser binaries. The `playwright` npm package installs as
#     JS-only (no browser download on npm ci — no install script), and
#     browser binaries are a ~400MB addition, so browser_action is disabled
#     until an explicit `npx playwright install chromium` (+ install-deps)
#     step is run.
#   - Docker CLI / docker.sock. Per-session container isolation
#     (DockerSessionProvider) is a separate, undecided security expansion —
#     v1 runs sessions as plain git worktrees + sibling processes, which
#     needs no Docker.
# ---------------------------------------------------------------------------

FROM node:22-bookworm-slim

# git: the orchestration path (worktree spawn / checkpoints / reviewers)
# shells out to git constantly. ca-certificates: HTTPS for OpenRouter + npm.
# curl: handy for debugging the sidecar (no healthcheck dependency on it —
# the compose healthcheck calls `headlesscode --version`).
# gh: the GitHub CLI, used by execute_command inside worktrees (UwUChat
# code-mode proxy tools call execute_command with `gh ...`); token auth
# via GH_TOKEN/GITHUB_TOKEN env, matching src/watcher/github.ts.
# Installed from the official GitHub release tarball, not Debian apt:
# bookworm ships gh 2.23.0 (2023), whose `issue view` GraphQL query still
# requests the removed repository.issue.projectCards field and fails with
# "Projects (classic) is being deprecated" on every modern repo. Pin a
# recent release so detail queries (issue/pr view) keep working.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git \
    && curl -fsSL https://github.com/cli/cli/releases/download/v2.98.0/gh_2.98.0_linux_amd64.tar.gz -o /tmp/gh.tar.gz \
    && tar -xzf /tmp/gh.tar.gz -C /tmp \
    && install -m 0755 /tmp/gh_2.98.0_linux_amd64/bin/gh /usr/local/bin/gh \
    && rm -rf /tmp/gh.tar.gz /tmp/gh_2.98.0_linux_amd64 /var/lib/apt/lists/*

WORKDIR /opt/headlesscode

# Dependencies first, for layer caching: package manifest + lockfile only.
COPY package.json package-lock.json tsconfig.json ./
# Full install (devDependencies included): tsx + typescript run the
# TypeScript source at runtime. Playwright is a devDependency but installs
# JS-only — no browser binaries are downloaded.
RUN npm ci --no-audit --no-fund

# Application source (the vendored portable core lives under src/vendor/).
COPY src ./src

# Shipped central stack-rules content (`shared/stacks/<stack>/rules.md`) —
# seeded into the runtime's central store at container start (entrypoint.sh),
# because $HOME lives on the /data volume which shadows image layers.
COPY shared ./shared

# Runtime orchestration scripts: the non-dry-run orchestrate path shells out
# to scripts/spawn-parallel-worktrees.sh, which in turn launches each worker
# via scripts/run-worker.sh; headlesscode-answer.sh answers decision-escalation
# prompts a blocked worker (scripts' HARNESS_ROOT resolves to /opt/headlesscode
# from BASH_SOURCE, so they find src/cli.ts + node_modules here). The rest of
# scripts/ is dev/deploy tooling (GUI injection, phone-home, QA runs) that has
# no business in the image.
COPY scripts/spawn-parallel-worktrees.sh scripts/run-worker.sh scripts/headlesscode-answer.sh ./scripts/
RUN chmod +x scripts/spawn-parallel-worktrees.sh scripts/run-worker.sh scripts/headlesscode-answer.sh

# Bundled shared content (per-stack rules.md, …). Copied into the image and
# seeded into the container's $HOME at every start by entrypoint.sh — the
# central store lives on the /data volume, which shadows image content.
COPY shared ./shared

# The package.json `bin` entry (bin/headlesscode.mjs — a JS launcher that
# resolves the package's own node_modules/tsx, see issue #99) only becomes
# executable when headlesscode is installed as a dependency of another
# package, so wire a fixed wrapper that mirrors the repo's own
# `tsx src/cli.ts` invocation.
#
# TSX_TSCONFIG_PATH: tsx discovers tsconfig.json from the *cwd*, but the CLI
# is invoked from arbitrary working directories (orchestrated project
# checkouts, scratch repos, /data/...). Pinning the tsconfig keeps the
# package's compiler options stable regardless of the cwd (the imports are
# all relative now — issue #99 rework — but the pin still prevents tsx from
# picking up an unrelated tsconfig from wherever the CLI is invoked).
RUN printf '#!/bin/sh\nexport TSX_TSCONFIG_PATH=/opt/headlesscode/tsconfig.json\nexec /opt/headlesscode/node_modules/.bin/tsx /opt/headlesscode/src/cli.ts "$@"\n' \
        > /usr/local/bin/headlesscode \
    && chmod +x /usr/local/bin/headlesscode

# Persistent state lives on the /data volume (a named volume in whatever
# compose stack runs this image) so it survives image rebuilds — never
# inside the container filesystem. HEADLESSCODE_WORKSPACE_ROOT is where orchestrated
# project checkouts + their .headlesscode/ dirs go; HOME (default
# ~/.headlesscode/checkpoints, playwright cache) also lands under /data.
ENV HEADLESSCODE_WORKSPACE_ROOT=/data/headlesscode-workspaces \
    HOME=/data/headlesscode-home

# docker/entrypoint.sh re-creates these dirs at every container start — the
# volume mount shadows whatever the image build created.
COPY docker/entrypoint.sh /usr/local/bin/headlesscode-entrypoint.sh
RUN chmod +x /usr/local/bin/headlesscode-entrypoint.sh

EXPOSE 4390
ENTRYPOINT ["/usr/local/bin/headlesscode-entrypoint.sh"]
# v1: the container is an install target, not yet wired into any specific
# caller's tool-calling surface. Keep it alive so another container can
# reach it over the Docker network; a future integration replaces this with
# the real invocation surface.
CMD ["sleep", "infinity"]
