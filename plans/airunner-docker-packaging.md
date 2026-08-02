# Package headlesscode for install inside airunner's `server` container

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI running a headless coding-agent loop. The
project owner wants headlesscode installable and runnable **inside
airunner's existing Docker deployment** (specifically the `server` container
that runs uwuchat's backend), not on their bare workstation — this is prep
work for the Tier 1 admin coding-harness integration described in
`plans/uwuchat-integration.md`, but is scoped standalone: getting the CLI
installable and runnable in that environment, not wiring it into `uwu`'s
tool-calling yet (that's still gated behind `plans/uwuchat-integration.md`'s
own Phase 2 status).

Match this project's established style: no test framework (plain `tsx`-run
test files, hand-rolled `assert`, `All N tests passed` trailer); `npx tsc
--noEmit` and `npm test` must stay green; re-run every e2e suite under
`scripts/e2e*/run.sh`.

## Real findings this task is grounded in (verified 2026-08-02 against
## ~/Projects/airunner — read these before designing anything)

- **airunner's `server` container is Python-based, no Node.js.**
  `extensions/docker/Dockerfile.prod` (the production image actually
  deployed for the uwuchat backend) is `python:3.13-slim-bookworm`,
  installing only `curl` — no Node, no git, no build toolchain. The dev
  image (`docker/Dockerfile`) does have `git` (plus build tools) but still
  no Node.
- **No Node-in-Python pattern exists anywhere in that repo.** The only
  Node.js usage is `extensions/docker/Dockerfile.caddy`'s build stage
  (builds the client SPA, then discards Node entirely — only the built
  static output survives into the final Caddy/Alpine image). There's no
  precedent to follow; this is new integration surface.
- **No nested/sibling Docker access exists anywhere in the stack** — no
  `/var/run/docker.sock` mount, no `docker` CLI installed in any container
  (verified by grepping the entire tree for `docker.sock`, zero hits).
  **This changes the plan from what `plans/uwuchat-integration.md`
  previously assumed**: that document's "Where headlesscode actually
  executes" section assumed `DockerSessionProvider` (headlesscode's
  per-session container isolation, `src/cloud/docker-provider.ts`) would
  run *inside* the backend container to isolate individual coding sessions.
  That's not available without adding Docker socket access to the backend
  container — a real, separate security expansion beyond what "install
  headlesscode in the existing container" implies, and NOT part of this
  task's scope. **Correction for v1**: headlesscode's actual orchestration
  path (`headlesscode orchestrate`, `scripts/spawn-parallel-worktrees.sh`)
  already runs as plain git worktrees + sibling OS child processes — it
  needs NO Docker at all to function, since that isolation model predates
  and is independent of `DockerSessionProvider`. So v1 runs coding sessions
  as regular processes inside the one `server` container, with **no
  per-session sandboxing beyond what the worktree/process model already
  gives** (separate working directories, separate PIDs — not separate
  containers). Flag this explicitly to the project owner in your report;
  `plans/uwuchat-integration.md` needs a follow-up correction once this
  lands (not this task's job to edit that doc, just to surface the finding
  clearly).
- **A persistent writable volume convention already exists**: `/data`
  (named volume `server_data` in prod, `AIRUNNER_BASE_PATH`/
  `AIRUNNER_USER_DATA_PATH` env-driven) — the natural root for a
  headlesscode git workspace + `.headlesscode/` state directory, kept
  separate from the application code volume so it survives image rebuilds.
- **Secrets convention**: plain environment variables via `env_file`
  (`.env`/`.env.prod`), read via `os.getenv(...)` in the Python backend.
  `OPENROUTER_API_KEY` already flows this way for other purposes. A
  headlesscode install should read `OPENROUTER_API_KEY` (and any other env
  vars it needs) the same way — do not invent a separate secrets mechanism.
- **No build/dist step exists in headlesscode itself** — `package.json`'s
  `bin`/`scripts` all invoke `tsx` directly against TypeScript source
  (`"cli": "tsx src/cli.ts"`), there is no `tsc`-compiled output shipped.
  This matters for how the image installs it (see below).

## What to build

### 1. A Dockerfile addition/stage that gets headlesscode runnable

Add Node.js (an LTS matching `package.json`'s `"engines": {"node": ">=18"}`
— Node 22, matching what `Dockerfile.caddy` already uses elsewhere in this
stack for consistency) and `git` to whichever image is meant to run
headlesscode. Two real options — investigate both and make a call,
documenting the reasoning:

- **(a) Add Node.js + git directly into `Dockerfile.prod`** (or a
  `Dockerfile.prod`-derived variant) via `apt-get install -y git` +
  NodeSource's Node 22 apt repo (the standard way to get a specific Node
  major version on Debian-slim without a separate base image).
- **(b) A separate sidecar service** in the compose stack, built from a
  small `node:22-bookworm-slim`-based image that has `headlesscode`
  installed, communicating with the `server` container over the existing
  Docker network (e.g. headlesscode's own dashboard/HTTP surface, or a
  simple internal API) rather than living inside the same container/process
  as the Python backend.

**Recommend (b) if the two runtimes genuinely don't need to share a
process** — it avoids bloating the Python backend image with an entire
second language runtime + browser automation dependencies (see Playwright
note below), keeps the "install Node in a Python image" complexity
contained to a purpose-built image, and is more consistent with this
project's own "small, focused services" pattern already visible in the
compose stack (celery workers are already separate services from `server`).
Make the actual call yourself based on how `plans/uwuchat-integration.md`'s
eventual tool-calling wiring would need to reach headlesscode (a same-process
function call needs (a); an HTTP/subprocess-over-network call is fine with
(b)) — re-read that document's Tier 1 "orchestrator tool shells to
`headlesscode orchestrate`" framing, which suggests (b) (a subprocess/API
call from Python to a separate service) is the more natural fit, but this is
your judgment call to make and justify, not a foregone conclusion.

### 2. Install headlesscode itself

Since there's no build/dist step, ship source + `npm ci` (which pulls in
`tsx`/`typescript` as devDependencies — needed at runtime here since
there's no compiled output) inside the target image/stage. Options: vendor
the headlesscode source directly into the image build context (simplest,
matches how this repo is currently developed — a straight `COPY . .` +
`npm ci` in whatever stage runs it), or (more decoupled, more setup)
publish it as an installable artifact (git-based `npm install
git+https://...` pointing at this repo, or a private registry) — your call,
but a straight source copy is almost certainly the right choice for a v1
given the project owner's stated speed priority; don't over-build a
publishing pipeline that isn't needed yet.

### 3. Workspace + state directory placement

Root the git workspace(s) headlesscode manages, plus its own
`.headlesscode/` state directories, under the `/data` volume convention
identified above (e.g. `/data/headlesscode-workspaces/<project>`) — not
inside the application code path, which gets replaced on every image
rebuild/deploy.

### 4. Playwright / `browser_action` — a real image-size decision point

The `browser_action` tool (`src/tools/browser/`) depends on Playwright,
which needs real browser binaries downloaded (`playwright install`) — a
meaningfully large addition to whatever image ships headlesscode. Decide
and document: ship it by default (simpler, browser_action just works), or
make it an optional/separate concern (skip `playwright install` in the base
image, document that `browser_action` won't work until it's added) given
this is a v1 focused on getting the core harness running, not necessarily
every tool. Lean toward skipping it for v1 unless it's genuinely cheap —
your call, but say which you chose and why.

### 5. Environment/config wiring

Document (a short section in this task's own report, plus a
`docs/airunner-docker-packaging.md` if you judge it warranted) exactly what
env vars the container needs (`OPENROUTER_API_KEY` at minimum; note whether
`HEADLESSCODE_EMBEDDING_BACKEND=ollama` even makes sense in this context —
almost certainly NOT, since there's no local GPU inside this deployment;
the default `openrouter` embedding backend is correct here, explicitly
confirm this rather than leaving it ambiguous) and how they're expected to
reach the container (existing `.env`/`.env.prod` convention).

### 6. A way to actually verify it runs

Build (or extend) a small script (e.g.
`scripts/docker-smoke.sh`) that builds whatever
image/stage this task produces and runs a trivial headlesscode command
inside it (`headlesscode --version` or equivalent, plus ideally one real
`headlesscode orchestrate --dry-run`-style check if that exists — check
`src/cli.ts` for what's available) to prove the install actually works, not
just that the Dockerfile parses.

## What NOT to do

- Do not add `/var/run/docker.sock` or install the `docker` CLI into any
  container as part of this task — that's the nested-Docker/
  `DockerSessionProvider` question, explicitly out of scope here (see the
  "real findings" section above) and a separate security decision the
  project owner hasn't made yet.
- Do not wire this into `uwu`'s actual tool-calling — that's
  `plans/uwuchat-integration.md`'s job, still gated behind its own Phase 2
  status. This task only makes headlesscode installable/runnable in the
  target environment.
- Do not build a publishing pipeline (private npm registry, versioned
  releases) for v1 — a direct source copy into the image build is
  sufficient given the stated speed priority.
- Do not modify airunner's production compose files in a way that changes
  what's deployed today without it being clearly opt-in (e.g. a new
  service/profile, not a change to the existing `server` service's
  behavior) — this is new, additive infrastructure, not a replacement for
  anything currently running.

## Tests / verification

1. `npx tsc --noEmit` clean (in headlesscode).
2. `npm test` — all suites green (in headlesscode; this task is unlikely to
   touch application code, but confirm nothing broke).
3. The Docker smoke script (item 6 above) actually builds and runs
   successfully — quote its real output in your report, don't just claim it
   works.
4. If airunner's own repo needed changes (new Dockerfile/compose additions),
   confirm those files are syntactically valid (`docker compose config` or
   equivalent) — you do not need to run airunner's own test suite, this is
   out of scope, but don't leave invalid YAML/Dockerfile behind.

## What to report back

- Files changed/added, in both headlesscode and (if applicable) airunner.
- Your choice between option (a) same-container and (b) sidecar service,
  and why — this is the single biggest architectural call in this task.
- Your choice on Playwright/browser_action inclusion, and why.
- Real output from the Docker smoke test proving the install works.
- Explicit confirmation of the nested-Docker finding (no docker.sock
  anywhere) and that this task correctly did NOT add it.
- Any deviation from this spec, and why.
