# uwuchat integration — architect/orchestrator/worker via `uwu`'s CODE mode

## Status: architecture plan only — NOT scoped for dispatch yet

This is Phase 2 of the "ditch VS Code" goal. Phase 1 (perfecting headlesscode's
own dashboard/CLI interface, the browser-first workflow) comes first and is
still in progress as of this writing. **Do not dispatch this plan to a worker
round until the project owner explicitly says Phase 1 is far enough along.**
This document exists so the target shape is written down and doesn't have to
be re-derived later, and so Phase 1 decisions (event shapes, dashboard APIs,
decision-escalation marker files) can be made with this destination in mind.

## Two tiers, deliberately separate (2026-08-02, revised)

The full open-ended "have a conversation, get a plan doc, get a whole
orchestrated build" flow and the public-facing chatbot are **two different
products with two different risk profiles**, and this plan now treats them
as such:

- **Tier 1 — Admin general harness.** An admin, using `uwu`, can point
  headlesscode at *any* project and drive the full architect → orchestrator →
  worker flow, open-ended, same as this very session does today. This is the
  "manage any project via uwuchat" capability. **Admin-only, indefinitely** —
  not a beta stage on the way to public, but a deliberately permanent
  operator-only tier, since it implies arbitrary `execute_command` execution
  and unbounded scope. This lets admins dogfood/validate the whole pipeline
  before any of it reaches a public user in any form.
- **Tier 2 — User-facing scoped code tools.** The public-facing `uwu` gets
  narrow, bounded tools that happen to use headlesscode under the hood, NOT
  general-purpose "build whatever you want" access. Framing: give the
  chatbot *freedom to create what it needs* for a specific, recognized use
  case, not an open-ended coding harness. E.g. "bang together a quick
  website," "write a small script to solve this problem," "spin up a
  preset/bootstrapped app from a known template." Each of these is a
  constrained tool with its own narrow task template, tight iteration cap,
  and probably no exposed plan-doc/orchestrator UI at all — the user never
  sees "architect mode," they just get the artifact. This is a genuinely
  different, much smaller integration than Tier 1, not a cut-down version of
  it — see the dedicated section below.

Both tiers reuse the same underlying headlesscode engine; they differ in
*how much of it is exposed* and *how bounded each invocation is*.

## Tier 1 vision (the original framing, now admin-scoped)

Today, coding work happens as a conversation with an assistant (Claude Code,
this very session) in a terminal/IDE. The Tier 1 target: that conversation
happens instead with `uwu` — uwuchat's system bot — in the uwuchat web UI,
**for an admin account**:

1. Admin has a normal conversation with `uwu` about what they want to build.
2. `uwu` recognizes coding intent and produces an **architect-mode** output —
   a plan document, the same shape this session already produces via plan
   mode.
3. `uwu` automatically hands that document to itself in **orchestrator
   mode**, which drives `headlesscode orchestrate` (the existing multi-agent
   worktree orchestrator) against it, using the system-owned OpenRouter key,
   metered against the admin's code-credit balance.
4. Workers do the work headlessly, exactly as they do today.
5. If a worker escalates a decision (`ask_followup_question`), the
   orchestrator tries to answer it autonomously first; if it genuinely can't,
   the question surfaces as a normal `uwu` chat message in the SAME
   conversation, and the admin's reply unblocks the worker.

## Tier 2: user-facing scoped code tools (new section)

This is deliberately NOT "expose Tier 1 to users with a lower spend cap." The
shape is different:

- **A small, curated set of task templates**, not open-ended architect-mode
  plan generation. Each template is a pre-written, scoped task spec (in the
  same style as this project's own `plans/*.md` task files, but authored by
  the project owner ahead of time, not generated fresh from an arbitrary
  user conversation) — e.g. `templates/quick-website.md`,
  `templates/utility-script.md`, `templates/bootstrapped-app-<kind>.md`.
  `uwu` fills in the specifics from the conversation (what the site is
  about, what the script needs to do) but the *shape and guardrails* of the
  task are fixed by the template, not improvised.
- **No exposed orchestrator/multi-worker complexity.** These are small
  enough to run as a single headlesscode session (`code` mode, one
  worktree, one bounded iteration cap), not a multi-agent round — much
  cheaper, much faster to reason about for a first launch, and avoids
  exposing decision-escalation/blocked-state chat plumbing (Tier 1's item 3
  below) to public users at all initially.
- **Bounded blast radius by construction**: each invocation operates in a
  fresh, disposable workspace scoped to that one artifact (a new git repo /
  worktree per generated site or script), not "any project" — there's no
  equivalent of Tier 1's "point it at any project" danger because there's no
  arbitrary target to point at.
- **Cost is naturally small and predictable per template** (a single bounded
  session, not an open-ended round), which likely means this can be metered
  through something closer to uwuchat's existing tier-cap/turn-counting
  model rather than needing the full code-credits wallet Tier 1 requires —
  worth revisiting once real per-template cost data exists from Tier 1 usage.
- **Output delivery** is a new, real open question: does the user get a
  downloadable zip, a live-previewed static deploy, a link to a hosted
  sandbox? This determines real new infrastructure (`src/cloud/`'s
  Docker/Hetzner provider abstraction is a plausible fit for "deploy this
  generated thing somewhere the user can see it") that Tier 1 doesn't need
  at all (an admin managing "any project" presumably already has their own
  deploy path).
- Tier 2 should be scoped as its own follow-up plan doc once Tier 1 is real
  and validated — it's mentioned here to record the framing and keep Tier 1's
  design (item 1, code-credits; item 5, compute location) honest about NOT
  assuming Tier 2 reuses it wholesale.

## Why this maps onto existing uwuchat scaffolding, not a rebuild

Verified live in the uwuchat/airunner codebase (`~/Projects/airunner`,
`projects/uwuchat/{server,client}` + `server/src/airunner_services/`):

- **`ToolCategory.CODE` already exists** in `airunner_services`'s tool
  registry (`llm/core/tool_registry.py`), explicitly documented as a
  "mode-specific category (for mode-based agent routing)" alongside
  `AUTHOR`/`RESEARCH`/`QA`. Zero tools registered under it today — the type
  system anticipated this, nothing built it.
- **Tool-calling and mode-classification are real and working**: the
  `TOOL_CLASSIFICATION` pipeline (`ai_pipeline.py`) already routes a turn
  before the model responds — this is the natural hook for "did the user just
  express coding intent." `RESEARCH`-category tools (web search/scraping,
  `llm/tools/research_rag_tools.py`, `intelligent_crawl_tool.py`) are a real,
  working precedent for what a CODE-category tool set looks like.
- **Frontend precedent for non-text bot output already exists**:
  `TurnFlowView`/`InlineFlowNodes.tsx` (expandable system-prompt → tool-call
  → tool-result → response visualization) and `InlineCostBreakdown.tsx`
  (per-message cost card) in
  `projects/uwuchat/client/components/chat/messages/` — a code-mode progress/
  cost card is an adaptation of these, not new UI invention.
- **headlesscode's decision-escalation mechanism already exists** and needs
  no redesign: `.harness.needs-decision` / `.harness.decision-answer` marker
  files, `src/orchestrator/watch.ts`'s `"blocked"` group status. Orchestrator
  mode just needs to poll for it and emit a chat message instead of (or in
  addition to) what the dashboard/CLI helper script does today.

## What's genuinely NOT built and would be new work (Tier 1)

### 1. A code-credits system (system-owned key, NOT BYOK)

**BYOK was considered and rejected** (2026-08-02): routing coding calls
through a user-supplied OpenRouter key means the raw requests are visible in
THAT user's own OpenRouter dashboard/logs — including `uwu`'s system prompts,
the architect/orchestrator prompt engineering, and anything else sent
upstream. That's a real prompt-leak vector, not a hypothetical one, and it's
unacceptable for the same reason the existing chat pipeline already keeps its
system prompts off any user-visible surface. Coding mode uses the **same
system-owned `OPENROUTER_API_KEY`** the rest of uwuchat already uses — the
new piece is accounting for it separately from chat's flat-tier model, not a
different key.

Verified: **zero credits/metered-spend mechanism exists anywhere in
airunner/uwuchat today** — billing is flat Stripe subscription tiers
(`extensions/auth/server/stripe_routes.py`, `TIER_CAPS`/`TIER_DAILY_CAPS`/
`TIER_DAILY_TOKEN_CAPS`) metered by counting `PipelineTokenUsage.call_chain_id`
rows per tenant per period — turns/tokens, not dollars, and no concept of a
purchasable/decrementing balance. Coding mode needs a parallel accounting
model: real dollar cost per session/round, debited against a credit balance,
because unlike chat turns, a coding round's cost is open-ended (iteration
count varies a lot task to task) rather than a flat per-turn cost. Needed:

- A `code_credits` balance per account (or per-admin-account, given the
  admin-only launch scope) — a purchasable/toppable-up balance, structurally
  closer to a prepaid wallet than the existing tier-cap counters.
- Real-time debiting from headlesscode's own `.headlesscode/usage/*.jsonl`
  (already tracks real $ per session/round via `BudgetTracker`) — this is the
  authoritative cost source; credits are debited from real measured spend,
  not estimated up front.
- A **hard stop**, not just a warning, when the balance hits zero — wire into
  headlesscode's existing `BudgetTracker`/`--max-cost-usd` (already built,
  currently opt-in via CLI flag — this integration is a natural forcing
  function to make a cap always-on for uwuchat-launched sessions, sourced
  from the remaining credit balance rather than a fixed CLI number).
- A cost display reading `.headlesscode/usage/*.jsonl` — parallel to
  `InlineCostBreakdown`, not sharing its data source, since
  `pipeline_token_usage` rows are turn-counts against the flat-tier model and
  don't represent real coding spend.
- Because coding mode is admin-only for now, the purchase/top-up flow itself
  can be minimal (a manual admin-only balance adjustment, not a real Stripe
  product) until this goes wider — but the debiting/hard-stop/display
  plumbing should be built for real from the start, since that's the part
  that actually protects against runaway spend.

### 2. Mode-routing dispatcher

`ToolCategory.CODE` is declared but nothing switches into it at runtime.
Needed: real logic in (or alongside) `TOOL_CLASSIFICATION` that recognizes
coding intent and enters architect mode, plus the actual state machine for
architect → orchestrator handoff within one conversation (today `uwu` has no
concept of "mode" that persists turn-to-turn beyond tool routing per-turn).

### 3. Decision-escalation → chat bridge

New, but small: a background process (or webhook) that watches
`.orchestrator-state.json` for `status: "blocked"` on a uwuchat-launched
round, and when found, posts a message into the originating `uwu`
conversation containing the worker's question + enough context (recent
`harness.log` tail) for the user to answer meaningfully in chat. The reply
needs to route back to `scripts/headlesscode-answer.sh` (or its API
equivalent) for the correct worktree.

### 4. Memory system — explicitly OUT of scope for this integration

headlesscode already has a stub (`src/memory/uwuchat.ts`,
`UwUChatMemoryStore`) that throws "not implemented" today, and
`docs/memory-uwuchat-contract.md` proposes REST endpoints that **do not
exist yet on the AIRunner side**, with a hard requirement (§5 of that doc)
that any harness-memory schema stay isolated from `AgentMemory`/tenant data.
That's real, separate backend work with its own security review — do not
bundle it into this integration. Coding sessions can run without shared
memory initially; `uwu`'s own rolling-summary memory of "we've been building
X" is a reasonable enough starting context even without deep integration.

### 5. Where headlesscode actually executes

Not yet decided: does `headlesscode orchestrate` run on the same
infrastructure as uwuchat's backend (would need real compute provisioning —
`src/cloud/` already has a Docker/Hetzner provider abstraction built for
exactly this), or does it need to run somewhere the user has already
authorized (their own machine, a project-specific sandbox)? This has real
security implications (arbitrary code execution + `execute_command` on
whatever host runs it) that need a decision before any of this ships, not
just a technical wiring question.

## Suggested build order (when Phase 2 actually starts)

1. Code-credits accounting: balance tracking, real-time debit from
   `.headlesscode/usage/*.jsonl`, hard stop at zero (foundational, blocks
   everything else, no dependency on headlesscode internals besides the
   usage-file format already shipping today). Admin-only manual top-up is
   enough for launch; skip building a real purchase flow until this goes
   beyond admin accounts.
2. `ToolCategory.CODE` tools: an `architect` tool (produces a plan doc, calls
   headlesscode's own LLM client with the system-owned key) and an
   `orchestrator` tool (shells to `headlesscode orchestrate`).
3. Mode-routing/handoff logic (`TOOL_CLASSIFICATION` → architect → auto-hand
   to orchestrator within one conversation).
4. Decision-escalation → chat bridge.
5. Cost display UI (adapt `InlineCostBreakdown` pattern).
6. Progress visualization UI (adapt `TurnFlowView`/`InlineFlowNodes`,
   possibly informed by whatever `plans/work-progress-visualization.md`
   ships in headlesscode's own dashboard first — reuse the classification
   logic, not just the visual pattern).
7. Compute/execution-environment decision (where orchestrator rounds
   actually run) — should be settled before step 2 ships to real users, but
   can be prototyped locally first.

## Open questions for the project owner (resolve before dispatch)

- Compute location for orchestrator rounds (item 5 above) — this is sharper
  now that coding is admin-only: does it just run on the admin's own
  machine/dev box for this phase (simplest, no hosted-execution security
  design needed yet), or does it need to run on shared infra even for the
  admin-only launch?
- Per-round spend cap default and whether it's account-configurable or fixed
  globally, and how code-credit top-up actually happens for the admin-only
  phase (manual DB/admin-panel adjustment is probably enough to start).
- Whether architect-mode output should always require explicit user
  approval before auto-handing to orchestrator, or whether that handoff can
  be automatic for small/low-risk plans (mirrors this project's own Step
  2/3.5 significance-threshold judgment calls in `.roomodes`).
