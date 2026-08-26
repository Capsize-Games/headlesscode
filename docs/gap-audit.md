# Gap audit — headlesscode vs Zoo Code (VS Code)

Snapshot of known behavioral gaps between the headless harness and the interactive VS Code
extension it's ported from. Documented for prioritization, not all scheduled.

## Built

- **Checkpoints, decision escalation, cost/token monitoring, diff-based editing,
  command/protected-file permissions parity, an automatic rework loop for `orchestrate`** —
  see [`docs/checkpoints.md`](checkpoints.md) and this doc's own git history for context.
- **`execute_command` timeout** now actually backgrounds the process (matching the vendored
  tool's own documented contract) instead of `SIGKILL`ing it.
- **Diff-based editing** — `apply_diff`/`search_replace`/`edit_file`, backed by a verbatim
  vendored port of Zoo Code's diff-matching logic
  (`src/vendor/zoo-code/src/core/diff/strategies/multi-search-replace.ts`). Checkpoints snapshot
  after any iteration using any edit tool, not just `write_to_file`.
- **Settings/permissions parity** — `src/permissions/commands.ts` +
  `src/permissions/protected-files.ts`, enforced in `src/tools/executor.ts` before a command
  runs or a file is written, not just requested via the system prompt. Covered by
  `scripts/e2e-permissions/run.sh`. Not ported: `alwaysAllowWriteOutsideWorkspace`/
  `alwaysAllowReadOnlyOutsideWorkspace` (moot — the workspace-boundary guard is already a hard
  deny, stricter than Zoo Code's default toggle).
- **Real-time worker monitoring + pause/resume** — `src/engine/events.ts`'s per-session JSONL
  event feed, dashboard live session detail view, pause/resume control (the dashboard's first
  write path — bearer-token gated, see `src/dashboard/server.ts`'s header comment).
- **`codebase_search`** — real semantic search backed by an embedding model, built AND
  activated (not just built-and-unused): `headlesscode index` builds a per-workspace index
  (generated on first use, gitignored, incremental by content hash), `spawn-parallel-worktrees.sh`
  copies an existing index into fresh worktrees so a worker never starts un-indexed, and
  `.roo/rules-code/rules.md` tells `code`-mode workers to try it before whole-file reads.
  Verified live: a real session reached for `codebase_search` before any whole-file read.
  Two embedding backends: `openrouter` (default, `qwen/qwen3-embedding-4b`) and `ollama`
  (opt-in via `HEADLESSCODE_EMBEDDING_BACKEND=ollama`, local `qwen3-embedding:8b`, verified
  live against a real local Ollama instance — zero marginal cost per index build). Distinct
  from the Phase 3 memory embedder (`src/memory/embed.ts`), which only powers session/fact
  recall, not code search.
- **Real context condensation** — `src/engine/condense.ts` replaces the old sliding-window-only
  placeholder with token-budget-aware summarize+merge, sharing its tool-call-group-boundary
  safety logic with `truncateHistory`'s own eviction path (one implementation family, not two
  independently-maintained ones). Falls back to the message-count sliding window for sessions
  that never approach the token threshold — condensation is a supplement, not a replacement.
- **A local-model narrow support role, evaluated honestly** — `src/tools/output-summarizer.ts`
  can compress oversized tool output via a local Ollama model, opt-in
  (`HEADLESSCODE_LOCAL_SUMMARIZATION=1`, off by default). An independent review found real
  problems with the shipped default model (non-deterministic output breaks prompt-cache
  stability on repeated commands; a live test showed it dropping the one relevant line from a
  buried-failure log and adding forbidden meta-commentary) — it stays off by default. This is
  useful evidence, not just caution: a narrow, well-scoped local-model role already showed
  real reliability gaps, which bears on any broader local-model ambitions (see the project
  owner's ongoing local-LLM/vision discussion).
- **Streaming responses + reasoning-content capture** — opt-in SSE streaming
  (`llm_stream_chunk` events) and `include_reasoning` capture for `deepseek/*` models, both
  previously fully absent. Verified to work correctly alongside context condensation in the
  same session (a combined test was added specifically because the two features were merged
  sequentially, both touching `src/engine/loop.ts`'s core request path).
- **A real browser-automation tool** (`browser_action`, Playwright-backed) — this was NOT a
  port (confirmed: no such tool exists anywhere in the Zoo Code reference clone), genuinely new
  work. Session-end cleanup verified to actually kill a still-open browser process; hung actions
  time out rather than hanging the session.
- **Dashboard browser parity** — chat-thread session view (not just a flat event log),
  checkpoint list/diff/restore from the browser (restore gated behind the same bearer-token
  auth as other control-plane POSTs), a read-only workspace file browser (reuses the existing
  path-traversal guard, does not add file editing), and a permissions-settings page mirroring
  the earlier mode-models settings page.
- **Minimal MCP client — fixture/dependency only, feature incomplete.** A real stdio-transport
  test fixture (built on the official `@modelcontextprotocol/sdk`) compiles and is merged, but
  the actual client (`src/mcp/client.ts`), executor wiring, and session lifecycle management
  were never built — the original implementation attempt stopped early and only a follow-up
  fixture-compile fix landed. The fixture currently has no test importing it. Treat MCP as
  still NOT implemented for any practical purpose; only the groundwork (a working test fixture
  + the SDK dependency) is in place. **Deliberately deprioritized (2026-08-02)** — the project
  owner has explicitly said this is on the backburner; not something currently in use or missed.
- **Recursive task decomposition (`new_task`)** — a headless-native reimplementation (NOT a
  literal port of Zoo Code's webview-coupled version, per its own plan doc's explicit design
  rationale): synchronous nested child `HeadlessSession`, a shared `BudgetTracker` between
  parent/child (independently reviewed and confirmed a child-only spend trips the shared cap —
  the real risk this design existed to prevent), a recursion-depth cap, child checkpoints
  tagged into the same shadow-git lineage as the parent, and event-feed parent/child lineage
  fields. Two known, real, currently-unresolved gaps from this work, tracked here so they don't
  get lost: (1) the synchronous nested-call design has never actually run end-to-end against a
  real LLM — only unit-tested against fakes; (2) a confirmed pre-existing bug where
  `attempt_completion` + `new_task` called in the same turn silently completes without
  delegating, instead of erroring.
- **`headlesscode orchestrate status`** — a structured one-shot/`--wait` status command reading
  `.orchestrator-state.json` directly, replacing a fragile bash sleep-and-grep polling loop that
  both this project's own self-hosted orchestrator mode and the sibling project's
  mode used to hand-roll. Both `.roomodes`/rules copies updated to use it.
- **Code-intelligence tools** — `outline`/`go_to_definition`/`find_references`/`import_graph`,
  backed by the TypeScript compiler's real language service (not text search), sharing one
  cached `ts.Program` per workspace. **Adoption gap found and addressed**: these shipped with
  good tool descriptions but got zero real usage across multiple live sessions until a rules-file
  "prefer X over Y" nudge was added — same pattern that made `codebase_search` actually get
  used. This is now a standing project convention (`.roo/rules/rules.md`): a new tool intended
  for regular use isn't done until something tells a model to reach for it, verified live, not
  just described well. Adoption is improving but still worth watching, not yet a settled result.
- **`update_todo_list`** activated, with a real, evidence-backed honest evaluation: null-to-
  negative on the 3 realistic tasks tested (6–11 iterations each) — the tool works correctly
  when used (well-formed incremental checklists maintained to completion) but adds iteration/
  token overhead when invoked and showed no measurable quality benefit at that task scale. A
  benefit remains plausible on substantially larger tasks where sub-task loss is a real risk;
  that has not been observed yet.
- **Dashboard work-progress timeline** — a third view (alongside the flat event log and
  chat-thread view) rendering a session's actual shape: per-iteration tool-type classification,
  condensation/checkpoint/pause markers, and a read/write/exec/search count summary. Zero new
  UI dependencies, matching this project's dashboard ethos.
- **headlesscode installable inside a host project's own Docker deployment** — a sidecar
  container service (`docker-compose.headlesscode.yml`, opt-in, combined via `-f`) built from
  this repo, Node 22 + git, workspace rooted under the existing `/data` volume, reachable over
  the internal Docker network. No nested-Docker/`docker.sock` access — deliberately out of
  scope, a separate security decision not yet made. This is groundwork for that plan's Tier 1
  (admin-only, full harness access), not the integration itself.

## Real open gaps

- **The real MCP client/executor wiring** — see above; only a compiling fixture exists.
  Deliberately backburnered, not currently blocking anything.
- **`headlesscode index`'s default embedding backend is still `openrouter`, not the free local
  `ollama` option** — the capability exists and is verified working, it's just not the default
  for local development where a GPU is available.
- **GitHub App provisioning never exercised against a real registered App** — built/tested
  against GitHub's documented API shape, but that step needs a human to register the App, not
  something an agent can verify. This is now more load-bearing than when first noted: real
  push-branch/open-PR code (`plans/github-push-and-pr.md`) is being built on top of this
  infrastructure, and the entire GitHub round-trip is currently only tested against fakes —
  worth actually registering a real App soon if the GitHub round-trip matters near-term.
- **GitHub push-back (push branch + open PR)** — `src/github/provision.ts` only ever clones a
  repo IN; confirmed zero push/PR code existed anywhere before `plans/github-push-and-pr.md`
  (in progress as of this writing). Needed for the uwuchat integration plan's Tier 1
  orchestrator tool to have anywhere to deliver a finished round's work.
- **Multi-tenant hosting** — a design document plus one bounded proof-of-concept
  (`DockerSessionProvider` implementing `CloudProvider`), not real per-tenant isolation.
  Correctly parked per the project owner's stated local-first priority.
- **Cloud provider** — documented sketch, not implemented (`docs/phase6-cloud.md`), a
  deliberate scope decision.
- **Playwright-MCP QA interactivity** — a deliberate scope
  decision; QA sessions can run commands/tests but not interact with a live browser
  interactively (distinct from the new `browser_action` tool above, which the CODING agent can
  use — QA's gap is specifically about live MCP-driven interactivity during QA verification).
- **No vision/image support** — `deepseek/deepseek-v4-flash` (the pinned model) cannot process
  images, and there was previously no image path anywhere in this harness at all (`browser_action`
  screenshots told the model to "read it back if your model supports images," which was already
  a dead end — `read_file`'s result is text-only). Scoped in `plans/image-support.md`: a cheap
  cloud vision model (OpenRouter, not local — a deliberate direction change from an earlier
  local-Ollama-vision idea) captions images to text at the boundary, no core type changes. Not
  yet dispatched.
- **uwuchat integration (Tier 1/Tier 2)** — full architecture in the uwuchat integration plan;
  most of headlesscode's own prerequisites for Tier 1 now exist (orchestrate, `orchestrate
  status --wait`, recursive `new_task`, Docker-sidecar installability, GitHub push-back in
  progress). The remaining work is on the host project's Python side (the `ToolCategory.CODE`
  tools, the code-mode toggle, code-credits accounting) — not further blocked on this repo.
