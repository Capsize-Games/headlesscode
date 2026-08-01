# Multi-tenant hosted execution — design proposal + a real CloudProvider

## Who you are working on this for

You (deepseek) are working on `headlesscode` — a standalone Node/TypeScript
CLI/orchestration engine for headless coding-agent work. This task is
different in shape from most other work handed to you on this project: the
primary deliverable is a **written design document** (an architecture
proposal, not a finished production system), plus one bounded, real
implementation piece that de-risks the design rather than committing to the
whole thing at once. Do not try to build a complete multi-tenant hosting
platform in one pass — that would be guessing at decisions the project owner
hasn't made yet. Your job is to turn open questions into a concrete,
reviewable proposal, informed by real research, plus one working piece of
it.

## Essential context: this project already has a relevant skeleton

Read these before designing anything:

- `src/cloud/provider.ts` — a `CloudProvider` interface (5 async methods:
  `spawnWorktreeSession`, `waitReady`, `runHarness`, `collectResults`,
  `teardown`) already exists, with a working `LocalProcessProvider`
  (local worktree + local process — today's actual behavior) and a
  documented-but-unimplemented `hetznerDockerProviderSketch`.
- `docs/phase6-cloud.md` — the existing evaluation (Phase 6, spec 6.2) that
  recommends **reusing this project's existing self-hosted GitHub Actions
  runner fleet on Hetzner** for ephemeral compute, rather than building
  dedicated new infrastructure from scratch. Read the actual reasoning, not
  just the conclusion — it may have constraints relevant to your design
  (e.g. what's already running on those runners, whether they're shared
  with other CI workloads).
- `src/budget/` (per-session cost/duration/iteration caps) and the
  concurrent-session cap (`activeSessionCount`/`ConcurrencyLimiter`,
  `docs/phase6-cloud.md` §1) — these guardrails already exist and matter a
  lot more once real, billed cloud compute is involved, not just local
  processes.
- `plans/github-app-provisioning.md` (a separate, possibly-concurrent task)
  — repo access/cloning for an arbitrary user's repo. This design should
  assume that capability exists (or will), not re-derive it.

## What "multi-tenant" actually changes, and why it's a real design problem

Today, `headlesscode`'s workers run arbitrary shell commands
(`execute_command`) with only the permissions-parity work's allow/deny lists
standing between a worker and the host — which is an acceptable risk model
when the "tenant" is the machine's own owner running their own trusted code.
**That stops being true the moment more than one user's sessions can run on
shared infrastructure.** A hosted, multi-tenant version of this needs a real
security boundary between tenants, not just directory-level separation —
one tenant's session (buggy, malicious, or just running an aggressive build
script) must not be able to see, affect, or exhaust resources for another
tenant's session, or the host itself.

## Part 1 — the design document (the primary deliverable)

Write `docs/multi-tenant-hosting-design.md` covering, with real reasoning
and a stated recommendation for each (not just a list of options):

1. **Isolation model.** Compare at least: (a) one Docker container per
   session with resource limits (cgroups) and no shared network namespace
   between tenant containers, (b) a lighter VM-per-session model (Firecracker
   microVMs or similar), (c) reusing the existing self-hosted-runner
   recommendation from `docs/phase6-cloud.md` directly (do their runners
   already provide per-job container isolation via how GitHub Actions
   itself sandboxes jobs? verify, don't assume). State a clear recommendation
   with the actual tradeoffs (cold-start latency, cost, operational
   complexity) — this project's own established preference (see
   `docs/phase6-cloud.md`) is to prefer reusing what already exists over
   building new infrastructure; weigh against that but don't feel obligated
   to agree with it if the multi-tenant security requirement genuinely
   changes the calculus (a shared CI runner fleet built for the project's
   OWN trusted code may not be an appropriate isolation boundary for
   arbitrary third-party tenants — think this through explicitly, don't
   hand-wave it).
2. **Secrets/credentials per tenant.** Each tenant's session needs an
   OpenRouter key (their own? a shared platform key with per-tenant usage
   metering via the cost accounting already built in `src/budget/`? — has
   real product/billing implications, flag it as a decision for the project
   owner rather than picking one yourself) and a GitHub App installation
   token (per `plans/github-app-provisioning.md`, already designed to be
   short-lived and never persisted — carry that property through here:
   describe how a tenant's credentials get to their isolated compute
   without ever being visible to another tenant's session or logged/
   persisted anywhere they shouldn't be).
3. **Control-plane vs. execution-node split.** A control-plane service
   (session lifecycle, auth, dispatching work to a `CloudProvider`
   implementation) is architecturally separate from execution nodes (where
   `execute_command` actually runs). Describe this split concretely: what
   API does the control plane expose, how does it map onto the existing
   `CloudProvider` interface (does a new implementation of that exact
   interface suffice, or does the interface itself need to grow — say
   which, and why).
4. **What this explicitly does NOT need to solve yet**: full auth/session
   management (GitHub OAuth login, user accounts), billing, and the browser
   chat UI itself are separate, later tasks (`plans/browser-control-plane.md`
   already covers a local-only, no-auth version — multi-tenant auth is a
   distinct follow-up, not this task). Say so explicitly in the doc so it
   reads as a bounded design, not an attempt to solve everything at once.

## Part 2 — one bounded, real implementation piece

Implement a real `DockerSessionProvider` (or whatever you conclude in Part 1
is the right minimal first step — if your Part 1 recommendation isn't
Docker-based, implement THAT instead; the point is proving the design with
working code, not necessarily Docker specifically) implementing the existing
`CloudProvider` interface from `src/cloud/provider.ts`, replacing the
`hetznerDockerProviderSketch` placeholder with something real:
- `spawnWorktreeSession`: creates an isolated container (or your chosen
  primitive) with the worktree/repo mounted or cloned in, resource limits
  applied (CPU/memory caps — a runaway session must not be able to starve
  the host or other tenants' sessions).
- `runHarness`: executes the harness command inside that isolation
  boundary, not on the host directly.
- `teardown`: actually removes the container/isolation boundary and any
  resources it used — a leaked container per session is a real cost/
  security problem at scale, test that this actually happens, don't just
  assume the happy path.
- This does NOT need real multi-tenant auth wired up yet — it needs to
  PROVE the isolation boundary works: two concurrent sessions running
  deliberately conflicting/aggressive test workloads (e.g. one tries to
  read a file that should belong only to the other) cannot see or affect
  each other.

## What NOT to do

- Do not build authentication, a user database, billing, or the browser
  chat UI in this task — explicitly separate, later work.
- Do not deploy anything to real production infrastructure — this is local/
  test-environment implementation + a design document, not a live rollout.
- Do not assume Docker is the answer without the comparison in Part 1 — if
  your research points somewhere else, follow it and say so.

## Tests

- New `src/cloud/__tests__/docker-provider.test.ts` (or matching your chosen
  primitive): the full 5-method lifecycle against a real local Docker
  daemon if available in your environment (skip gracefully with a clear
  message if Docker isn't available, don't fail the whole suite over an
  environment gap — check how other tests in this project handle an
  optional-dependency situation, if any do, for the pattern to match).
  Prove teardown actually removes what spawn created (list containers
  before/after, not just check the exit code).
- A test (or a clearly-described manual verification if a real isolation
  boundary can't be exercised in the test suite itself) proving two
  concurrent sessions are actually isolated from each other — this is the
  single most important thing to verify in this whole task, don't let it
  be an assumption.

## Verification checklist

1. `npx tsc --noEmit` clean.
2. `npm test` — all suites green including new ones (or clearly skipped
   with a stated reason if your environment lacks a required local
   dependency like Docker — do not silently pass a test that didn't
   actually run).
3. The isolation proof above, actually run, with real observed output in
   your report.

## What to report back

- `docs/multi-tenant-hosting-design.md` in full — this is the primary
  deliverable, treat it accordingly (clear reasoning per section, a stated
  recommendation, not a menu of options with no conclusion).
- The implementation from Part 2: files changed/added, confirmation of
  tsc/test results, and the isolation-boundary proof's real output.
- Whether Docker (or your chosen alternative) was actually available in
  your environment to test against, and what you did if not.
- Open questions you hit that genuinely need the project owner's input
  before Part 2's approach could go further (e.g. real budget/infrastructure
  cost constraints you can't estimate from inside this task) — list them
  plainly rather than picking an answer and hoping it's right.
