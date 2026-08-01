# Custom headless coding-agent harness — project plan

## Why this exists

Zoo Code is a GUI-first VS Code extension. Every attempt to drive it as
a headless automation primitive has hit friction that traces back to
that fact, not to bad luck:

- File-edit tools gate on workspace root, stalling on anything outside
  the open folder (fixed by moving worktrees inside the repo).
- Its public `startNewTask()` API creates a task object but the task
  never visibly progresses — confirmed twice, silently, no error.
- The thing that actually works reliably is driving the UI directly via
  OS-level automation (`xdotool`) — i.e., pretending to be a human,
  because the tool was built for a human.

That's a workable stopgap (see `scripts/inject-task-into-window.sh`),
not a foundation to build a "give it a goal, it opens tickets, a fleet
of agents does the work down to QA and deploy" pipeline on. This
project is the long-term answer: a small, purpose-built, genuinely
headless coding agent that reuses what actually makes Zoo Code good
(its prompts, tool design, and mode/rules configuration format) without
carrying along a GUI dependency it was never going to shed.

## Repo structure — separate project, not inside airunner

This is its own repo (e.g. `~/Projects/<harness-name>`), matching the
existing pattern of `airunner` and `fastsearch` as independent projects
with independent deploy pipelines — not a folder inside `airunner/`.
Reasons this isn't a close call:

- It's not "AIRunner framework" or "a project built on AIRunner" in the
  sense CLAUDE.md already defines (both are specifically for AI-backed
  websites). A coding harness operates *on* arbitrary git repos — it's
  a different category of thing.
- Its own dependency/version lifecycle (Node or Python version, its own
  CI, its own release cadence) shouldn't be coupled to airunner's
  pinned toolchain, and airunner changes shouldn't be able to break it
  or vice versa.
- It talks to UwUChat over an API (see Phase 3), which is a real
  service boundary — the two are meant to be independently deployable
  and independently versioned.

## What "good" actually means here, so we don't lose it in translation

Per the recon (Phase 0 below), capture and preserve:

1. **System prompts** — how it reasons step by step, decides which tool
   to use when, recovers from errors. Plain text, zero VS Code
   dependency, directly portable.
2. **Tool definitions** — the exact set of tools (read file, write
   file, run command, apply a diff, etc.) and the schema used to
   invoke them and read results back. A spec, portable.
3. **The orchestration loop** — send prompt, parse response for a tool
   call, execute it, feed the result back, repeat until done. An
   algorithm, portable.
4. **The mode/rules system** — `.roomodes` and `.roo/rules-<slug>/` are
   almost certainly just "read some YAML/markdown, splice into the
   system prompt." This project should keep reading the **exact same
   files already in this repo** — no new config format to maintain,
   and Zoo Code (used interactively) and the new harness (used for
   automated work) both read the same source of truth.
5. **VS Code integration** (diff decorations, webview chat UI, terminal
   panel) — the one part that's genuinely VS-Code-specific, and also
   the part a headless background worker doesn't need.

## Phases

### Phase 0 — Recon (do this before writing any harness code)

- [ ] Clone Zoo Code's source (`Zoo-Code-Org/Zoo-Code` on GitHub, or
      wherever the actual fork lives — confirm exact repo).
- [ ] Check the license (expect MIT/Apache-2.0-family, common for
      Cline-family forks) — confirm what's actually permitted before
      reusing prompt text or tool schema, even in a clean-room
      reimplementation.
- [ ] Find and extract the actual system prompt template(s) — likely
      under a `core/prompts/` or `src/core/prompts/` type directory.
- [ ] Find and extract the tool definitions — names, argument schema,
      how results get formatted back to the model (XML-tag style,
      JSON function-calling style, or something else).
- [ ] Find and read the mode/rules-loading code — confirm it really is
      "read files, splice into prompt" and not more entangled than
      that.
- [ ] Find and read the core orchestration loop — how it parses a
      response for tool calls, executes them, handles malformed
      tool-call output, manages context/history truncation.
- [ ] Report back: how big is the "core" (prompts + tools + loop +
      rules-loading), how cleanly is it separated from `vscode.*` API
      calls, and a real effort estimate for Phase 1 based on what's
      actually there — not a guess made in advance of looking.

### Phase 1 — Minimal viable headless harness

Goal: prove the core loop works end-to-end against a real GitHub
issue, before adding anything else.

**LLM backend for now: OpenRouter**, not DeepSeek-direct and not
UwUChat's API — same provider UwUChat itself already routes through,
model choice (likely a DeepSeek-family model for cost, matching this
project's own established preference) is a config knob, not a
hardcoded integration. UwUChat API/memory integration is explicitly
Phase 3, later.

- [ ] Create the new standalone repo (see "Repo structure" above) —
      plain Python or Node (Node if reusing Zoo Code's actual TS
      tool-schema/prompt code directly; Python if reimplementing from
      the recon's findings in a codebase that matches this team's
      existing tooling conventions — decide after Phase 0's report).
- [ ] Implements: read `.roomodes`/`.roo/rules-<slug>/` from a target
      repo, build a system prompt from mode + rules, call OpenRouter's
      API with the tool schema, parse tool calls, execute them via
      plain `fs`/`subprocess` (no `vscode.*` anywhere), loop until a
      completion signal, exit.
  Tools to support at minimum: read file, write file, run shell
  command, list directory. (Diff-apply and more exotic tools can come
  later — most of what the worker task files in
  `plans/parallel-tasks/` need is these four.)
- [ ] Non-interactive by design: no approval prompts, no webview, runs
      to completion or a bounded failure, logs to stdout/a file.
- [ ] Test: run it against one real, already-scoped issue (e.g. #29 or
      #38 from the existing backlog) in an isolated worktree, and
      compare the result quality against what Zoo Code/DeepSeek
      produced for similar work in earlier rounds.
- [ ] Success criterion for this phase: it does real, useful,
      comparable-quality work on a real issue, unattended, with no
      VS Code involved at any point.

### Phase 2 — Replace the orchestration layer

- [ ] Swap `scripts/spawn-parallel-worktrees.sh`'s "open a VS Code
      window + xdotool-inject" step for "spawn a background process
      running the Phase 1 harness" — this is a strict simplification
      (a background shell command instead of GUI automation), and the
      worktree/Docker isolation infrastructure carries over unchanged.
- [ ] Reuse the existing review-mode checklist
      (`plans/zoo-code-review-mode-prompt.md`) as the harness's own
      "reviewer" invocation — same fresh-context-verifier principle,
      running headlessly too.
- [ ] Reuse the existing issue-splitting logic/heuristics (from the
      `multi-agent-orchestrator` mode's instructions) — the actual
      judgment calls about how to group issues don't change just
      because the worker mechanism did.

### Phase 3 — Memory system, via a new UwUChat-facing API (deliberately
deferred, informed by real usage)

Do not start this until Phase 1/2 have run several real sessions. The
idea (a UwUChat-inspired knowledge-extraction/temporal-recall memory
system for the coding agent, unencrypted and using a local embedding
model — no FHE, no rate-limit complexity, no per-customer multi-tenancy,
since none of that is needed for an internal dev tool remembering
things about its own codebase) is a real, well-motivated one, but the
extraction logic needs to be designed for "facts about a codebase and
its own past decisions," not ported verbatim from "facts about a
roleplay character." Design this once we know what the harness
actually needed to remember across real sessions, not before.

**Architecture decision already made**: the harness is a separate
service (see "Repo structure" above) and talks to UwUChat's memory
system over an API, rather than embedding a copy of the memory pipeline
inside the harness itself. **That API does not exist yet** — today,
UwUChat's memory/knowledge system (`knowledge_facts`, `AgentMemory`,
entity resolution, embedding search) is only ever read/written from
within the AIRunner server process itself; there is no external-facing
surface for a third service to call into. This is real, new scope on
the AIRunner/UwUChat side, not just harness-side work:

- [ ] Design authenticated, scoped endpoints (record fact, query
      recall, summarize session) callable by a trusted external
      service — not by end users, and not reachable through any
      existing tenant-facing route.
- [ ] Decide data isolation: the harness's own "project knowledge"
      (facts about *this codebase*) must not live inside or be
      reachable through any real customer's tenant schema. Given this
      project's own history — tenant-isolation bugs have been the
      single most recurring category of real incident across this
      session's work — treat this as a genuine security-review item,
      not a quick add-on. A dedicated schema/service for harness
      knowledge, cleanly separated from customer tenant data, is the
      likely right shape; do not casually bolt this onto existing
      tenant-scoped tables.
- [ ] No FHE/encryption requirement for the harness's own knowledge
      (internal dev tool, not customer data) — but the new API surface
      itself still needs normal auth/authz scrutiny since it's a new
      way to reach into the AIRunner server from outside.

Candidate data shape, to revisit once Phase 1/2 are proven and the API
is designed:
- A `knowledge_facts`-equivalent: extracted facts about the codebase's
  conventions, past decisions, and things that didn't work, scoped per
  project (not per-tenant/per-user).
- A rolling session-summary mechanism (equivalent to `AgentMemory`) so
  a long-running harness session doesn't need to keep raw history
  forever.
- Local embedding model (no cloud routing, no rate limiter, no
  encryption) for semantic recall over past facts/sessions — this can
  run inside the harness's own service, calling into the UwUChat API
  only to persist/query, not for the embedding computation itself.
- No entity-resolution equivalent needed initially — code entities
  (files, functions, classes) already have canonical identifiers,
  unlike loosely-specified real-world entities in chat.

### Phase 4 — QA and deploy integration

- [ ] Existing `qa-agent` pattern (Playwright MCP) is already
      fundamentally headless-compatible (browser automation, not VS
      Code UI automation) — evaluate whether it needs to change at
      all, or just needs to be invoked by the new harness instead of
      by a Zoo Code custom mode.
- [ ] Existing `scripts/deploy-production.sh` is already scriptable —
      evaluate what the human-approval gate should look like (a
      required manual step before this runs, not automated away).

### Phase 5 — GitHub issue watcher (fully automated intake)

The dream pipeline entry point: file an issue with a specific label,
a watcher picks it up, kicks off a headless session automatically —
zero human action between "issue filed" and "work starts."

- [ ] Decide push vs. poll: a GitHub webhook (reacts to `issues.labeled`
      in real time, needs a small always-on receiver) vs. a poll loop
      (`gh issue list --label needs-agent --state open` on an interval,
      no receiver needed, simpler to run anywhere, small latency).
      Poll is the simpler starting point; webhook is the natural
      upgrade once this is running somewhere persistent (see Phase 6).
- [ ] Watcher's job is narrow: detect a newly-labeled issue, hand it to
      the same issue-splitting/spawn logic already proven this session
      (one issue can still fan out into multiple parallel worktrees if
      it's large), remove the label (or add an "in-progress" label) so
      it isn't picked up twice.
- [ ] Idempotency: if the watcher restarts mid-cycle, it must not
      double-spawn work for an issue already in progress — track
      in-progress issues somewhere durable (a label, a small state
      file, or a database row), not just in-memory.

### Phase 6 — Cloud scaling

Once the harness has no VS Code/GUI dependency (Phase 1) and no
human-in-the-loop trigger (Phase 5), "scalable" is mostly "run more of
it," not new architecture:

- [ ] The worktree-plus-isolated-Docker-stack pattern already proven
      this session ports directly to ephemeral cloud compute — spin up
      a fresh container/VM per issue, run the harness, tear down.
- [ ] This project already operates exactly this kind of infrastructure
      (self-hosted GitHub Actions runners on Hetzner) — evaluate
      whether the harness can reuse that runner fleet directly, or
      needs its own pool, before building anything new.
- [ ] Concurrency limits and cost caps matter here in a way they didn't
      for a handful of local worktrees — an issue-triggered, cloud-
      scaled pipeline can run away on cost if something loops or a
      burst of issues lands at once. Add a hard concurrent-session cap
      and a per-session cost/time budget before this goes further than
      "a few sessions running locally."

## What does NOT change

- The worktree isolation approach (`.worktrees/`, unique Docker ports/
  project names per worktree) — proven, keep it.
- The issue-splitting heuristics — proven, keep them.
- The adversarial fresh-context review principle — proven (caught
  every real bug across 4 rounds of PR #39's review), keep it
  unconditionally regardless of what runs the worker/reviewer.
- The scripts-first principle (`.roo/rules/rules.md`) — applies exactly
  as much to a new custom harness as to Zoo Code.

## Open questions to resolve during Phase 0, not before

- Is Zoo Code's actual license permissive enough to reuse its prompt
  text/tool schema directly, or does this need to be a clean-room
  reimplementation informed by reading it rather than copying it?
- Node vs. Python for the new harness — depends on how much of Zoo
  Code's actual TS code (prompts, tool schema, rules-loading) turns out
  to be directly reusable vs. needing reimplementation.
- Does OpenRouter's function-calling support (which varies somewhat by
  the underlying model it routes to) match the tool-call format Zoo
  Code's prompts assume, or does the tool-definition language need
  adapting for whichever model ends up as the default?
