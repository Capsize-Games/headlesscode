# Self-extending tools — `uwu` writes and deploys its own capabilities, sandboxed, no human gate

## Status: architecture design only — NOT scoped for dispatch

This is Phase 3 of the uwuchat integration arc (`plans/uwuchat-integration.md`
is Phase 2, itself gated behind Phase 1 of headlesscode's own interface work).
Do not dispatch this to a worker round. This document exists to capture a
real design decision the project owner made (2026-08-02) before any
implementation is scoped, because the decision materially changes the
security shape of what gets built — writing code against the wrong shape
here is expensive to unwind later.

## The idea

`uwu` (uwuchat's system bot) can decide it needs a new tool, use headlesscode
to write the actual implementation, and have that tool become genuinely
callable — not on the next deploy, but live, without a human approving it
first. This is a materially bigger ambition than Phase 2's Tier 1/Tier 2:
Tier 2's scoped code-generation tools produce *artifacts* (a website, a
script) for a user; this produces a new *capability of the bot itself*,
autonomously.

## The two decisions already made (2026-08-02, do not re-litigate without new information)

1. **Fully autonomous — no admin approval gate before a new tool becomes
   callable.** Explicitly chosen over an admin-approves-first staging model.
   The bot can write a tool and it goes live for real users with no human
   step.
2. **Sandboxed per-call execution — not in-process.** Every invocation of a
   self-written tool runs isolated (reusing the container-isolation pattern
   headlesscode's `DockerSessionProvider` already built for coding sessions,
   not a new isolation primitive from scratch), not directly inside the main
   `server` process. Registration/metadata can live in-process; the actual
   function body executes elsewhere per call.

**Why this combination is coherent, not reckless**: autonomy without review
is only defensible because the blast radius is bounded by the sandbox, not
because the code is trusted. This is the same logic as running an untrusted
browser extension in a sandboxed process rather than reviewing its source
before every install — the isolation IS the safety mechanism, replacing
human review rather than supplementing it. Every design choice below exists
to keep that premise actually true, not just assumed.

## What has to be true for "sandboxed, no review, still safe" to actually hold

### 1. Minimal-privilege sandbox by default — this is the primary remaining lever

With no human reviewing what a tool does before it runs, the sandbox's
default permissions ARE the security boundary. Concretely:
- **No ambient secrets.** A hot-written tool gets none of the main
  service's credentials (DB connection strings, other integrations' API
  keys, `HEADLESSCODE_OPENROUTER_API_KEY`, etc.) by default. If a tool genuinely needs
  an external credential, that has to be an explicit, narrow grant — and
  since there's no human reviewing the grant request either, this needs
  its own design (a fixed allowlist of pre-approved narrow-scope
  credentials a tool can request, e.g. "read-only weather API key," not
  "give me whatever you ask for").
- **No network access by default**, or a narrow allowlist. An unreviewed
  tool with unrestricted outbound network access can exfiltrate data or
  hit arbitrary external services — this is a real, immediate risk category
  distinct from "the code has a bug."
- **Resource limits per call** (CPU/memory/timeout), same posture
  `DockerSessionProvider` already applies to coding sessions.
- **No access to other users'/tenants' data** — this needs to be true by
  construction (the sandbox's data-access surface, if any, is scoped to
  the specific conversation that triggered the tool call), not by the
  tool's own good behavior.

### 2. Self-testing before a tool goes live at all

Even with no human review, a newly-written tool should not go live having
never been executed. Before hot-loading: headlesscode (or the generation
step) writes real test cases for the tool and runs them **inside the same
sandbox model real calls will use** — dogfooding the isolation as the test
environment, not a separate trusted environment, so a test "pass" actually
reflects what a real call will experience. A tool that fails its own tests
does not go live. This is necessary but not sufficient (self-written tests
can be wrong or incomplete — same limitation this project's own
self-verification-before-review always had) — it's a floor, not a
replacement for the missing human review.

### 3. A fast, working kill-switch — autonomy in one direction, oversight in the other

"No approval gate before going live" is not the same as "no oversight,
ever." An admin needs a way to instantly disable a specific tool that turns
out to be broken, wasteful, or actively harmful — this has to be at least
as fast as the tool went live in the first place, or the asymmetry defeats
the point. Additionally: **automatic retirement** — a tool that errors
repeatedly, times out consistently, or gets flagged by users should be
auto-disabled without waiting for a human to notice, with the disablement
itself logged/surfaced (an admin should be able to see "these tools were
auto-retired and why" after the fact).

### 4. Cost/resource metering on sandboxed calls

Every real execution of a self-written tool costs real resources (sandbox
spin-up, any LLM calls the tool itself might make). This needs to flow into
the same accounting Phase 2 already scopes (code-credits) — an unreviewed,
autonomously-created tool that gets called frequently is a real, uncapped
cost surface if it isn't metered the same way everything else is.

### 5. Durability across restarts — tie to git, don't invent a second source of truth

A hot-loaded tool needs to survive the main service restarting. Rather than
building a separate persistent-code store: on going live, the tool's code
should also be durably committed (auto-committed, since there's no human
approval step to wait for) to the actual repository — reusing headlesscode's
already-built GitHub push-back (`plans/github-push-and-pr.md`), just without
waiting for the PR to be merged by a human (auto-merge instead, since that
approval step doesn't exist in this design). Git stays the single source of
truth for what tools exist; hot-loading is how a newly-committed tool
becomes live without waiting for a redeploy, not a parallel mechanism.

### 6. Namespace/conflict handling

A tool registry with autonomous, unreviewed additions needs real conflict
detection: two tools with the same name, a new tool shadowing an existing
built-in, naming collisions across concurrent creation — this needs
explicit rules (reject on collision? version/namespace automatically?),
not left implicit.

## What's genuinely new engineering here (not present anywhere today)

- **Dynamic module loading into airunner's `ToolRegistry` at runtime**
  (Python `importlib`-based) — does not exist yet.
- **A sandboxed per-call execution primitive for tool invocations**
  specifically (distinct from `DockerSessionProvider`, which isolates a
  whole *coding session*, not a single function call) — this likely means
  a lightweight RPC-to-sandbox model: the registry holds metadata, a call
  dispatches to an isolated worker (container or subprocess) that runs the
  actual function body and returns a result. Real latency/cost tradeoffs to
  work out (a container-per-call is expensive; a warm-pool of reusable
  sandboxes is the likely direction but adds real complexity).
- **The self-test-before-live pipeline**, running inside that same sandbox
  model.
- **The kill-switch/auto-retirement surface**, with visibility for admins.
- **Credential-grant allowlisting** for tools that need narrow external
  access without ambient secrets.
- **Auto-commit path** (github-push-and-pr without the human-merge step)
  specifically for this use case — everywhere ELSE in this project,
  auto-merge is explicitly avoided (Step 3.5, Tier 1/2's "always open a PR,
  never auto-merge" convention). This is a deliberate, narrow exception to
  that standing convention, made ONLY because sandboxed execution is meant
  to substitute for the review this convention otherwise provides — flag
  this tension explicitly in any future implementation task, since it's the
  one place this design intentionally breaks an established project
  pattern, and that reasoning needs to travel with the code, not just live
  in this doc.

## Open questions still unresolved (for a future scoping pass, not now)

- Warm-pool vs. per-call sandbox provisioning — real latency/cost tradeoff,
  needs real measurement before committing to one, same "verify don't
  assume" discipline this project has applied to every other local/
  isolation-related performance question.
- Exact credential-allowlist mechanism and who curates the allowlist itself
  (a meta-question: if the allowlist can be autonomously extended too, the
  "no ambient secrets" guarantee erodes over time unless the allowlist
  itself has a human gate even though individual tool creation doesn't).
- Whether `uwu` deciding "I need a new tool" should itself be rate-limited
  or bounded per admin/session, independent of the credits system, to avoid
  tool-creation sprawl as a distinct failure mode from cost overrun.
- How this interacts with Tier 2 (public-facing scoped tools) if this
  capability is ever extended beyond the admin-only Tier 1 context this
  design currently assumes — not addressed here, deliberately out of scope
  until Tier 1's own version of this is real and evaluated.
