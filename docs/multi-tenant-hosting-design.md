# Multi-tenant hosted execution — design proposal

Status: **proposal for review** (architecture + one de-risking implementation,
not a shipped system). No production infrastructure was touched; everything in
Part 2 runs against a local Docker daemon.

Scope boundary, stated up front so this reads as a bounded design and not an
attempt to solve everything at once: this document covers (1) the isolation
model, (2) per-tenant secrets handling, and (3) the control-plane /
execution-node split for running one tenant's `headlesscode` session per
isolation boundary. It deliberately does **not** cover full auth/session
management (GitHub OAuth login, user accounts), billing, or the browser chat
UI — those are separate, later tasks (`plans/browser-control-plane.md` covers
a local-only, no-auth version; multi-tenant auth is a distinct follow-up).
This design assumes the GitHub App repo-provisioning capability from
`plans/github-app-provisioning.md` exists (or will) and does not re-derive it.

---

## 1. Isolation model

### Why this is the load-bearing decision

Today `headlesscode` workers run arbitrary shell commands
(`execute_command`) with only the permissions-parity allow/deny lists
between a worker and the host. That is an acceptable risk model when the
"tenant" is the machine's owner running their own trusted code. It stops
being acceptable the moment two different users' sessions can run on shared
infrastructure: a session (buggy, malicious, or just running an aggressive
build script) must not be able to **see**, **affect**, or **exhaust
resources for** another tenant's session or the host itself. Directory-level
separation is not a security boundary — any process running as the same OS
user can read sibling worktrees, and a runaway process can consume all CPU,
RAM, or disk.

### Option (a) — one Docker container per session (the Part 2 implementation)

Each session runs in its own container, created per session and destroyed at
teardown, with:

- **Resource limits via cgroups** (`docker run --cpus --memory
  --memory-swap --pids-limit`): a runaway session is throttled/oom-killed by
  the kernel, never able to starve the host or sibling containers.
- **No shared network namespace**: each container gets its own network
  namespace (Docker's default for `docker run`); nothing listens on the host
  loopback or a shared bridge. There is no port math and no way for one
  tenant's sockets to collide with another's.
- **Root inside the container is namespaced**: the container runs as a
  non-root UID, and Docker's default seccomp/apparmor (when enabled on the
  host) restrict kernel surface. The kernel's own isolation primitives
  (namespaces + cgroups) are the boundary, not a permissions list in the
  harness.

Tradeoffs:

- **Cold-start latency**: container start is on the order of tens of
  milliseconds to a couple of seconds (image already pulled). With the
  harness repo mounted (not baked into the image) there is no image build
  per session.
- **Cost**: marginal CPU/RAM usage on a shared host — the cheapest model per
  session (no per-instance VM billing).
- **Operational complexity**: one Docker daemon per execution node, container
  lifecycle hygiene (leak prevention is exactly what the Part 2 `teardown`
  test verifies), host kernel security (the daemon must be kept patched; the
  docker socket must NOT be exposed to tenants).
- **Isolation strength**: container isolation is not a hard security boundary
  against a determined attacker with a kernel exploit (shared kernel).
  For the threat model here — arbitrary third-party *code* (not OS-level
  adversaries) — it is the pragmatic boundary. See §1.4 for when this stops
  being enough.

### Option (b) — a lighter VM per session (Firecracker microVMs or similar)

Each session gets its own microVM: a real hardware-virtualized boundary
(separate kernel, no shared kernel attack surface), boots in ~100–300 ms
(Firecracker-class), and can be torn down by killing the VM process.

Tradeoffs:

- **Cold-start latency**: still fast for a VM (100–300 ms to boot), but
  realistically higher end-to-end once the harness runtime inside the VM
  (node_modules, the repo checkout) is provisioned; snapshot/boot-time
  caching becomes its own operational problem.
- **Cost**: a microVM per session is cheaper than a full cloud VM per session
  but more expensive than a container — the VM processes run on a host that
  must itself be maintained, and each microVM carries its own rootfs and
  runtime overhead.
- **Operational complexity**: a microVM runtime (Firecracker / cloud-hypervisor
  / gVisor-style sandbox) is new infrastructure this project does not operate
  today — a new daemon, new image/rootfs pipeline, new networking (vhost
  user/virtio), new kernel/security maintenance. This project has no existing
  expertise or tooling here.
- **Isolation strength**: the strongest of the three options — a separate
  kernel per tenant is a real security boundary, not a namespaced one.

### Option (c) — reuse the existing self-hosted GitHub Actions runner fleet directly

`docs/phase6-cloud.md` §5 recommends reusing existing self-hosted GitHub
Actions runners for ephemeral harness compute: a harness job runs as a runner
job, `docker run` per issue inside the job.
The question the plan says to verify, not assume: **do the runners already
provide per-job container isolation?**

Verified reasoning — GitHub Actions does **not** give self-hosted runners the
job isolation it gives GitHub-hosted runners:

- GitHub-hosted runners run each job in a fresh ephemeral VM (each job gets
  a new VM from the runner pool) — that isolation comes from the *hosted*
  infrastructure, not from the Actions protocol.
- Self-hosted runners are **your** long-lived machines; each job is a
  process (or `container:`-wrapped process) running on a persistent host
  that other jobs and other workloads share. There is **no automatic VM or
  container boundary per job** on a self-hosted runner. GitHub's own docs
  state that self-hosted runners don't provide the same security guarantees
  as GitHub-hosted runners and recommend against using them for public
  repos for exactly this reason.
- `jobs.<job_id>.container` in a workflow gives you a job *inside* a
  container the runner creates — but the runner daemon itself, the workspace,
  and the job containers all share the one host kernel, and the runner has
  to be treated as effectively privileged on that host (it needs Docker
  access, and it runs with the OS user's permissions). Per-job *container*
  isolation is what you configure, not what the fleet gives you by default.

Conclusion for option (c): the runner fleet is a good *execution-node
pool* — it already has Docker and is already paid for — but it is **not** a
per-tenant security boundary on its own. Today the harness runs on those
runners as the project's own trusted code, which is fine. Pointing
**arbitrary third-party tenants'** sessions at the same runners without a
real per-session boundary would mean each tenant's arbitrary code runs on a
host that also has the project's CI credentials, the runner's Docker socket,
and shared state with the project's own pipeline. That is precisely the
"shared CI runner fleet built for the project's OWN trusted code is not an
appropriate isolation boundary for arbitrary third-party tenants" case the
plan asks to think through explicitly.

That said, option (c) still has a real role: it is the cheapest way to
**operate the execution nodes**. The recommendation below separates the
question "what is the per-session boundary" (a container) from "what machines
run the boundary" (the existing fleet, if its shared-tenancy concerns are
addressed; see §1.5).

### Recommendation

**One Docker container per session, on execution nodes that are dedicated to
tenant sessions (not mixed with the project's own privileged CI), with the
GitHub Actions runner fleet kept for the project's own trusted pipeline
until that separation is made explicit.**

Rationale, weighing the project's stated preference to reuse what exists:

1. The multi-tenant security requirement genuinely changes the calculus. The
   Phase 6 recommendation was made for the project's **own** trusted code,
   where the threat model is "my code, my machine". Third-party tenants make
   the shared runner host a cross-tenant trust boundary, which the existing
   fleet is not designed to be. Reusing the fleet *as-is* for tenants is
   rejected on those grounds — not because the fleet is bad, but because the
   job it was built for is different.
2. Containers over microVMs: the marginal security gain of a separate kernel
   does not justify the operational cost for a first deploy of a system that
   does not exist yet. The realistic first-failure modes in multi-tenant
   hosted execution are *resource exhaustion* and *sloppy lifecycle*
   (leaked sessions) — both of which cgroups + strict teardown already
   answer — not a kernel-exploit attacker. This is the same
   "iterate on what exists, escalate when the threat model demands it"
   logic Phase 6 used; the escalation path from containers to Firecracker is
   exactly the `CloudProvider` interface swap (§3) and is documented in
   §1.4.
3. Containers are the smallest real step that actually changes the security
   posture. Docker is already the project's established isolation primitive
   (Phase 2's per-worktree compose stacks, the runner-fleet evaluation's
   `docker run` per issue), and the Part 2 implementation proves the
   lifecycle against a real daemon today.

### 1.4 When containers stop being enough (escalation path)

If a later threat-model review concludes tenants may be *actively
adversarial at the OS level* (not just running hostile code), the boundary
escalates to per-session microVMs (Firecracker) — same `CloudProvider`
contract, different `spawnWorktreeSession`/`teardown` implementation. The
trigger would be a demonstrated need to isolate a tenant from a host
kernel compromise, or a compliance requirement for hardware-virtualized
separation. This is a decision point for the project owner, not something to
pre-build.

### 1.5 What makes a node safe to host tenant containers

Independent of the per-session boundary, the *node* must not be a single
point of cross-tenant exposure:

- **No tenant session ever sees the Docker socket** (it would be host root).
  The control plane talks to the daemon; sessions only get the container
  environment.
- **Dedicated nodes or strict logical separation** for tenant sessions vs.
  the project's own privileged pipeline (CI runs, deploy scripts). The
  simplest correct first step is: tenant sessions never land on a runner
  that also has the project's CI secrets/Docker socket reachable by the
  same OS user that runs tenant code.
- **Host-level caps as backstop**: the per-session cgroup limits are the
  primary control; a per-node aggregate cap (sum of `--cpus`/`--memory` over
  active sessions, enforced by the control plane's existing
  `ConcurrencyLimiter`/`activeSessionCount` guardrails, §3.3) prevents a
  fleet-level oversubscription incident.

### 1.6 Cost/latency summary

| | Cold start (to harness-ready) | Cost/session | Ops complexity | Boundary strength |
| --- | --- | --- | --- | --- |
| Container/session (a) | ~0.5–3 s (image cached) | marginal CPU/RAM | low (daemon + hygiene) | namespaced kernel |
| Firecracker VM/session (b) | ~0.3–5 s + runtime provision | medium (VM process/rootfs) | high (new runtime) | hardware-virtualized |
| Runner reuse (c) | job-queue latency (s–min) | ~free (already paid) | low | **none per job** on self-hosted |

---

## 2. Secrets / credentials per tenant

Two credentials matter for a session: an **OpenRouter key** (LLM access) and
a **GitHub App installation token** (repo access, per
`plans/github-app-provisioning.md`). Two principles carry through from the
existing design: **short-lived** and **never persisted**. The Part 2
implementation ships the *mechanism* for both (per-session env injection,
scoped filesystem), without choosing the OpenRouter key model.

### 2.1 OpenRouter key — ownership model is a product decision

The plan explicitly flags this as a project-owner decision, not one for this
design to pick. The two viable models and their consequences:

- **Tenant-supplied key**: each tenant brings their own OpenRouter key. No
  platform billing/metering needed; a tenant's spend is their own problem;
  the tenant can be rate-limited by their own key. But: onboarding friction,
  and the platform cannot enforce its own per-session budgets on a tenant's
  spend through their own key (the `src/budget/` guardrails still work
  *inside* a session, they just can't be backed by a platform-side spend
  cap).
- **Shared platform key + per-tenant metering**: one platform key, with
  per-session usage already metered by the existing cost accounting
  (`src/budget/`, `estimateCost`/`BudgetTracker`, per-session `budgetUsage`)
  and attributable to a tenant via the session's tenant id. Gives the
  platform real enforcement of budgets and a path to billing. But: it is
  **platform billing** in disguise — the moment tenants are charged per use,
  the metering data becomes a billing system and needs its own auditability
  and dispute-handling, which is a later, separate task.

**Recommendation for the doc: flag, don't pick.** Both models are
implementable behind the same per-session env injection below; the difference
is where the key comes from at session-spawn time and whether the platform
metering output is treated as billing-grade data. The project owner should
decide this together with the billing task (explicitly out of scope here).

### 2.2 GitHub App installation token — carry the short-lived, never-persisted property through

`plans/github-app-provisioning.md` already designs installation tokens as
short-lived (1 hour), cached in memory only, never written to disk, and
stripped from the clone's `git remote` URL after cloning. The hosted design
carries that property into the execution node:

1. **Control plane** holds the durable secrets: the GitHub App private key +
   App ID (env/secret-store on the control plane) and the OpenRouter key
   (per the §2.1 decision). The control plane is the only process that ever
   holds durable secrets.
2. **At session spawn**, the control plane mints *session-scoped, short-lived*
   credentials and passes them to the session's isolation boundary **via
   container env vars, not files, not logs, not the image**:
   - the GitHub installation token (freshly minted, 1-hour TTL — exactly
     what `src/github/app-auth.ts` produces);
   - the OpenRouter key (per §2.1).
   The values are only ever in the container's process environment and in
   the control plane's memory. They are never written into the worktree, the
   image, the container filesystem, `.env`, or any log (the harness's own
   `harness.log` captures command output — a `gh` call that embeds the token
   in a URL could leak it there, so the provisioning step must strip the
   token from the remote URL **before** the session's first command can
   run; this is the same requirement the provisioning plan already states).
3. **Every other tenant's session cannot see them**: container env is per
   process namespace; a sibling session has no access to another container's
   `/proc/<pid>/environ` (no shared PID namespace, no shared mount
   namespace — §1(a)).
4. **No persistence anywhere**: nothing writes these values to disk; on
   teardown the container (and its env) is destroyed. If the control plane
   crashes, the in-memory tokens are gone with it; the GitHub token's 1-hour
   TTL bounds any residual exposure, and the App key itself never left the
   control plane.

A concrete, reviewable rule for the implementer: **a tenant session's
credentials exist only in (a) control-plane memory at mint time, (b) the
session container's env, (c) the control plane's own secure store for the
durable App key.** Not in files, not in images, not in logs, not in the
worktree's git config.

### 2.3 Why env injection is the right transport here

The `CloudProvider` interface's `CloudSessionRequest.env` field
(`src/cloud/provider.ts`) already exists and flows through to the harness —
the Part 2 provider passes it as container env. This is the seam the
credential path plugs into; it requires no interface change and keeps the
credential logic in the control plane rather than scattering it across
providers.

---

## 3. Control plane vs. execution node split

### 3.1 The split, concretely

- **Control plane** (a service, later the browser control plane; today the
  CLI/orchestrator processes): owns session lifecycle, tenant identity (once
  auth exists), credential minting (§2), dispatching work to a
  `CloudProvider` implementation, and the guardrails — per-session budgets
  (`src/budget/budget.ts`), the global concurrency cap
  (`src/budget/concurrency.ts`'s `ConcurrencyLimiter` +
  `activeSessionCountForRepo`). It never runs `execute_command` against
  tenant code; it never holds tenant worktrees.
- **Execution nodes**: machines with a Docker daemon (or, later, a microVM
  runtime) that run the isolated sessions — the containers where
  `execute_command` actually runs. Nodes are dumb: they receive a
  session-spawn request (image, mounts, env, limits), run a command in the
  container, return output, and delete the container on teardown. The
  daemon API is the node's only interface; tenant code never gets a shell on
  the node itself.

### 3.2 What API does the control plane expose?

External (to tenants/browser UI — later work): `POST /sessions` (start a
session for a tenant), `GET /sessions/:id` (status/events), `POST
/sessions/:id/answer` (decision escalation), `DELETE /sessions/:id` (stop).
This is the `plans/browser-control-plane.md` API shape grown with tenant id
and credential injection; it is explicitly **not** built in this task.

Internal (control plane → execution node): the existing `CloudProvider`
interface, verbatim:

```
spawnWorktreeSession(request) -> handle
waitReady(handle)             -> void
runHarness(handle, cmd)       -> { exitCode, output }
collectResults(handle)        -> Record<string, unknown>
teardown(handle)              -> void
```

### 3.3 Does the interface need to grow? — No, but it needs two documented conventions

The five methods are sufficient to run the full lifecycle against a real
isolation boundary — the Part 2 `DockerSessionProvider` implements them
unchanged and passes the full contract test. Two gaps are handled as
**conventions on the existing fields**, not interface changes:

1. **Credentials travel via `CloudSessionRequest.env`** (already exists —
   §2.3). No new field, but the doc convention must be: the control plane
   puts *session-scoped* credentials in `env` and the provider must treat
   `env` as secrets-bearing (never log it, never write it to a file).
2. **The concurrency cap maps to node capacity via provider options, not a
   new method.** `activeSessionCount`/`ConcurrencyLimiter` count sessions at
   the control plane; the provider's constructor takes
   `{ maxConcurrentSessions, hostCpuCount, hostMemBytes }` so the
   per-session resource caps (CPU/memory per container) are bounded by real
   node capacity and enforced before spawn. This keeps the interface stable
   while making oversubscription impossible by construction.

Why not grow the interface now: the interface is deliberately small (its
whole point, per `src/cloud/provider.ts`'s header) and every backend that
implements it — `LocalProcessProvider`, `DockerSessionProvider`, a future
`FirecrackerProvider` — implements the same five methods. Adding
credential/limit plumbing to the interface before the control-plane service
exists would be speculative API surface. When the control plane is built,
*it* becomes the layer that turns a tenant request into a
`CloudSessionRequest` with `env` + limits populated; the provider interface
does not need to know about tenants at all.

### 3.4 What the control plane maps onto today

Today's CLI/orchestrator already plays the control-plane role locally:
`orchestrateMain` enforces the concurrency cap before spawning, writes task
files, calls the spawner, and `watchGroups` polls `.harness.done` markers.
The hosted evolution keeps that loop and swaps the backend: the
orchestration layer calls the same five methods on `DockerSessionProvider`
that it calls on `LocalProcessProvider` today (the Part 2 test drives exactly
this five-method lifecycle). No orchestration-layer change is required to
run against the Docker provider; the seam was built for this.

---

## 4. Explicitly NOT in scope (bounded design)

- **Auth / user accounts / GitHub OAuth login**: separate follow-up. This
  design's tenant identity is an opaque `tenantId` passed through session
  requests for isolation/attribution; there is no login.
- **Billing**: the §2.1 OpenRouter-key decision and any charge-tenant flow.
  The existing `src/budget/` metering is a *cost guardrail*, not a billing
  system; making it billing-grade is a later task.
- **Browser chat UI**: `plans/browser-control-plane.md`'s local-only, no-auth
  version is a separate task; multi-tenant auth on top of it is yet another.
- **Production deployment**: nothing here is deployed; the Part 2 provider is
  a local, test-environment implementation that proves the isolation
  boundary works.
- **Anything beyond the minimal isolation proof**: no auth, no user
  database, no billing, no UI.

---

## 5. Part 2 — `DockerSessionProvider` (the de-risking implementation)

The design's minimal first step is a real `DockerSessionProvider` behind the
existing `CloudProvider` interface, replacing the `hetznerDockerProviderSketch`
placeholder with a working implementation. It proves, with real observed
behavior against a local Docker daemon:

1. The full 5-method lifecycle (spawn → wait → run → collect → teardown).
2. **Isolation**: two concurrent sessions cannot see or affect each other —
   one session's file is unreadable from the other, and one session's
   aggressive resource use does not kill the other (cgroup limits).
3. **Teardown actually removes**: containers are listed before/after, not
   just asserted.

### 5.1 Design of the implementation

`src/cloud/docker-provider.ts`:

- `spawnWorktreeSession` runs `docker create` (then `docker start`) with:
  - the **harness repo mounted read-only** at `/harness` (the `headlesscode`
    checkout that contains `src/cli.ts`) — no image build per session, no
    copy of node_modules;
  - the **tenant repo mounted** at `/workspace` (this is where the harness
    `--workspace` points; the provider does not itself clone — repo
    provisioning is the GitHub App task's job, and a pre-cloned checkout is
    what `LocalProcessProvider` also assumes);
  - **resource limits** (`--cpus`, `--memory`, `--memory-swap`,
    `--pids-limit`) from constructor options — a runaway session is
    throttled by cgroups, and the limits are set from real host capacity so
    a single session cannot starve the host;
  - **no published ports** and the default (isolated) network namespace;
    a private `--network none`-style topology is unnecessary — Docker's
    default already gives each container its own network namespace with no
    host exposure;
  - **non-root user** (the container runs as the HOST uid:gid — a non-root
    user outside the container's uid 0, so the host-owned workspace bind
    mount stays writable by the harness while the session still has no root
    privileges inside the container) and `--read-only` rootfs with tmpfs for
    `/tmp` (the harness writes `.harness.*` markers into the workspace, which
    is writable; the rest of the filesystem is read-only);
  - **per-session env** from `CloudSessionRequest.env` (the §2 credential
    seam) plus the fixed mounts/limits.
- `waitReady` polls `docker inspect` for the container's running state.
- `runHarness` executes `docker exec` the given command inside the container
  and returns `{ exitCode, output }` — the harness runs inside the boundary,
  never on the host.
- `collectResults` reads the session's result markers via `docker exec cat`
  (`.harness.exit`, `.harness.done`, `harness.log` tail) — the results live
  in the workspace mount, so they persist past container teardown, but the
  *execution* is containerized.
- `teardown` runs `docker rm -f` and **verifies the container is gone**
  (`docker ps -a` no longer lists it) — throwing if removal failed, so a
  leaked container is a loud failure, not a silent cost.
- Constructor defaults are env-driven (`HEADLESSCODE_DOCKER_IMAGE`,
  `HEADLESSCODE_DOCKER_CPUS`, `HEADLESSCODE_DOCKER_MEMORY_MB`) with an
  injectable `docker` command runner + fake-ready/fake-result seams for
  unit tests, matching the `LocalProcessProvider` testing style.

### 5.2 What the tests prove (real daemon, real output)

`src/cloud/__tests__/docker-provider.test.ts`:

- **Lifecycle**: full 5-method run against a real local Docker daemon using
  `node:22-bookworm-slim` (available locally; pulled if not). Asserted on
  real observed output: container created with the expected limits
  (`docker inspect` shows `NanoCpus`/`Memory`), harness command output
  returned, results collected.
- **Teardown proof**: `docker ps -a --filter` lists the session container
  after spawn, and does **not** list it after `teardown` — containers are
  enumerated, not just exit codes checked. (This mirrors the
  "list containers before/after" requirement.)
- **Isolation proof — the most important verification**: two sessions
  spawned concurrently:
  1. *Filesystem/visibility*: session A writes a tenant-private file into
     its workspace; session B runs `cat` for that path and observes it does
     not exist (each session's workspace mount is private to it).
  2. *Resource isolation*: session B runs a CPU-burning loop while session A
     runs a trivial command — A completes with the expected output, proving
     A was not starved into failure by B (B is capped by its own cgroup
     limits).
  3. *Network/namespace*: no published ports, so nothing a session listens
     on is reachable from the host or from another session's namespace.
- **Skip policy**: if `docker` is unavailable or the daemon is down, the
  suite prints a clear skip message and exits 0 — it does not fail the
  whole `npm test` run over an environment gap. (Docker was available in the
  environment this was developed in; the suite ran for real.)

### 5.3 What the Docker provider does NOT yet do (deliberately)

- No tenant identity/auth (out of scope).
- No image build/management (uses the harness repo mount; a baked image is a
  later optimization).
- No node discovery / remote daemons (control plane and node are co-located
  for the test; the SSH/daemon-TLS hop is a later operational step).
- No `--network none` or firecracker escalation (see §1.4).

---

## 6. Open questions for the project owner

1. **OpenRouter key model** (§2.1): tenant-supplied keys vs. a shared
   platform key with metering? This is a product/billing decision with real
   consequences for onboarding, enforcement, and whether the `src/budget/`
   metering must become billing-grade.
2. **Execution-node tenancy** (§1.5): are the existing self-hosted runners
   acceptable as tenant-session nodes if tenant sessions are containerized,
   or must tenant nodes be separate from the project's own CI fleet? This
   determines whether the "reuse what exists" preference can extend to
   multi-tenant at all, or whether a small dedicated node pool is required.
3. **Real budget/infrastructure cost constraints**: this design cannot
   estimate real node sizing or monthly cost from inside the task (no
   production fleet numbers). Before the control-plane service is built,
   the owner should set: expected max concurrent tenants, per-session CPU/
   memory targets, and acceptable per-node oversubscription.
4. **Isolation escalation trigger** (§1.4): what threat model (if any)
   justifies moving from containers to Firecracker microVMs — and who makes
   that call?
5. **Credential scope**: for the first hosted milestone, is it acceptable
   that the control plane holds a shared OpenRouter key in memory (per
   §2.1), or is a secret-store integration (e.g. vault/cloud KMS) a
   prerequisite before any real tenant traffic?

---

## 7. Related prior work (skeleton this builds on)

- `src/cloud/provider.ts` — the `CloudProvider` interface, `LocalProcessProvider`,
  and the now-replaced `hetznerDockerProviderSketch`.
- `docs/phase6-cloud.md` — Phase 6 guardrails + the runner-fleet evaluation
  this document re-examines for the multi-tenant case.
- `src/budget/` — per-session budgets and the global concurrency cap that
  become hard controls once sessions run on billed/shared compute.
- `plans/github-app-provisioning.md` — repo access + short-lived token
  design this document assumes and carries through.
- `plans/browser-control-plane.md` — the local, no-auth control-plane UI
  that this design's §3 API shape extends (later task).
