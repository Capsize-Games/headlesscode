# uwuchat integration — architect/orchestrator/worker via `uwu`'s CODE mode

## Status: architecture plan only — NOT scoped for dispatch yet

This is Phase 2 of the "ditch VS Code" goal. Phase 1 (perfecting headlesscode's
own dashboard/CLI interface, the browser-first workflow) comes first and is
still in progress as of this writing. **Do not dispatch this plan to a worker
round until the project owner explicitly says Phase 1 is far enough along.**
This document exists so the target shape is written down and doesn't have to
be re-derived later, and so Phase 1 decisions (event shapes, dashboard APIs,
decision-escalation marker files) can be made with this destination in mind.

## The vision (project owner's own framing, 2026-08-02)

Today, coding work happens as a conversation with an assistant (Claude Code,
this very session) in a terminal/IDE. The target: that conversation happens
instead with `uwu` — uwuchat's system bot — in the uwuchat web UI. Concretely:

1. User has a normal conversation with `uwu` about what they want to build.
2. `uwu` recognizes coding intent and produces an **architect-mode** output —
   a plan document, the same shape this session already produces via plan
   mode.
3. `uwu` automatically hands that document to itself in **orchestrator
   mode**, which drives `headlesscode orchestrate` (the existing multi-agent
   worktree orchestrator) against it, using the project's real BYOK
   OpenRouter key.
4. Workers do the work headlessly, exactly as they do today.
5. If a worker escalates a decision (`ask_followup_question`), the
   orchestrator tries to answer it autonomously first; if it genuinely can't,
   the question surfaces as a normal `uwu` chat message in the SAME
   conversation, and the user's reply unblocks the worker.

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

## What's genuinely NOT built and would be new work

### 1. BYOK infrastructure (the biggest real gap)

Verified: **zero BYOK mechanism exists anywhere in airunner/uwuchat.**
Billing today is flat Stripe subscription tiers (`extensions/auth/server/
stripe_routes.py`, `TIER_CAPS`/`TIER_DAILY_CAPS`/`TIER_DAILY_TOKEN_CAPS`)
metered by counting `PipelineTokenUsage.call_chain_id` rows per tenant per
period — turns/tokens against a single system-owned `OPENROUTER_API_KEY`.
Coding mode needs a parallel, separate accounting model: real dollars against
a user-supplied key, not turns against a shared quota. Needed:

- Secure BYOK key storage (encrypted at rest — `UserEncryptedText` pattern
  already used for `AgentMemory.summary` is the established precedent to
  follow, not invent a new encryption approach).
- A settings UI toggle ("enable coding — bring your own OpenRouter key") with
  key entry/validation (a real, cheap OpenRouter API call to confirm the key
  works before saving, matching this project's "verify don't assume" ethos).
- Coding-mode LLM calls must route through headlesscode's own client
  construction (`src/llm/openrouter.ts` already exists) using the user's key,
  NOT through `airunner_services`'s system-key pipeline — these are
  structurally different call paths, not a config flag on the existing one.
- A cost display reading headlesscode's own `.headlesscode/usage/*.jsonl`
  (real $ per session/round) — parallel to `InlineCostBreakdown`, not sharing
  its data source, since `pipeline_token_usage` rows don't apply to BYOK
  calls at all.
- Guardrails: a spending cap the user sets for coding specifically (distinct
  from subscription tier caps), enforced by headlesscode's existing
  `BudgetTracker`/`--max-cost-usd` (already built, currently opt-in via CLI
  flag — this integration is a natural forcing function to make it always-on
  for uwuchat-launched sessions).

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

1. BYOK key storage + validation + settings toggle (foundational, blocks
   everything else, no dependency on headlesscode internals).
2. `ToolCategory.CODE` tools: an `architect` tool (produces a plan doc, calls
   headlesscode's own LLM client with the BYOK key) and an `orchestrator`
   tool (shells to `headlesscode orchestrate`).
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

- Compute location for orchestrator rounds (item 5 above) — user's own
  machine only, or hosted?
- Per-round spend cap default and whether it's user-configurable per session
  or only globally per account.
- Whether architect-mode output should always require explicit user
  approval before auto-handing to orchestrator, or whether that handoff can
  be automatic for small/low-risk plans (mirrors this project's own Step
  2/3.5 significance-threshold judgment calls in `.roomodes`).
